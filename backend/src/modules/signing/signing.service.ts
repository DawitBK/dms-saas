import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import forge from 'node-forge';
import { Op } from 'sequelize';
import {
  Document,
  DocumentVersion,
  SignatureRecord,
  SignatureRequest,
} from '../../infrastructure/database/index.js';
import { AppError } from '../../core/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { getStorageAdapter } from '../../infrastructure/storage/StorageAdapter.js';
import { getVaultService } from '../../infrastructure/vault/VaultService.js';
import {
  requireLegalHoldClear,
  assertNotTerminalState,
} from '../../shared/documentGuards.js';
import { runInTransaction } from '../../shared/transaction.js';
import { validateTransition } from '../documents/DocumentStateMachine.js';

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
};

// ── Internal CA keypair — loaded from persistent encrypted storage ──────────────
// The CA keypair is stored at storage/.ca-keypair.json, with the private key
// AES-256-GCM encrypted by a vault-managed DEK. This survives server restarts,
// so previously-issued user signing certificates remain verifiable.

const CA_KEYPAIR_PATH = path.resolve(process.cwd(), 'storage', '.ca-keypair.json');

interface PersistedCA {
  certPem: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  encryptedDek: string;
  kekId: string;
}

let _caKey: forge.pki.rsa.PrivateKey | null = null;
let _caCert: forge.pki.Certificate | null = null;

async function getOrCreateCA(): Promise<{ caKey: forge.pki.rsa.PrivateKey; caCert: forge.pki.Certificate }> {
  if (_caKey && _caCert) return { caKey: _caKey, caCert: _caCert };

  const vault = getVaultService();

  // Try to load persisted CA keypair
  try {
    const raw = await fs.readFile(CA_KEYPAIR_PATH, 'utf8');
    const stored: PersistedCA = JSON.parse(raw);
    const plaintextDek = await vault.unwrapDEK(stored.encryptedDek, stored.kekId);
    const iv = Buffer.from(stored.iv, 'base64');
    const authTag = Buffer.from(stored.authTag, 'base64');
    const ciphertext = Buffer.from(stored.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextDek, iv);
    decipher.setAuthTag(authTag);
    const keyPem = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    plaintextDek.fill(0);
    _caKey = forge.pki.privateKeyFromPem(keyPem);
    _caCert = forge.pki.certificateFromPem(stored.certPem);
    return { caKey: _caKey, caCert: _caCert };
  } catch {
    // File absent or unreadable — generate a new CA for the first time
  }

  // Generate new CA keypair
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '00';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: 'commonName', value: 'DMS Internal CA' },
    { name: 'organizationName', value: 'DMS' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Encrypt and persist the private key using envelope encryption (same as document DEKs)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  const { plaintextDek, encryptedDek, kekId } = await vault.generateDEK('system');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', plaintextDek, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keyPem, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  plaintextDek.fill(0);

  const stored: PersistedCA = {
    certPem,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    encryptedDek,
    kekId,
  };
  await fs.mkdir(path.dirname(CA_KEYPAIR_PATH), { recursive: true });
  await fs.writeFile(CA_KEYPAIR_PATH, JSON.stringify(stored, null, 2), 'utf8');

  _caKey = keys.privateKey;
  _caCert = cert;
  return { caKey: keys.privateKey, caCert: cert };
}

export async function generateUserKeyPair(userId: string) {
  const { caKey, caCert } = await getOrCreateCA();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: 'commonName', value: userId },
    { name: 'organizationName', value: 'DMS' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ── Guards shared by the legacy request / execute / decline / verify paths ───────

/** The Document row must belong to the caller's tenant. The routes' ACL gate resolves
 *  access, but these services looked the document up by bare id; answered as not-found. */
function assertSameTenant(document: Document, user: CurrentUser): void {
  if (document.tenantId !== user.tenantId) {
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  }
}

/** The legacy single-signatory flow must never run over a live e-signing ceremony
 *  (esigning module). Both flip the same document status: with a ceremony in flight,
 *  any signing:manage holder could POST /documents/:id/sign/execute and mark the
 *  document SIGNED (or decline it) while the real request, its named recipients and
 *  its field placements were silently bypassed and left dangling. */
async function assertNoLiveCeremony(documentId: string): Promise<void> {
  const live = await SignatureRequest.findOne({
    where: { documentId, status: { [Op.in]: ['sent', 'partially_signed'] } },
    attributes: ['id'],
  });
  if (live) {
    throw new AppError(
      409,
      'ERR-SIGN-CEREMONY-ACTIVE',
      'This document has an e-signing request in progress. Sign or decline it from the e-signing page.',
    );
  }
}

/** The pending record names who was asked to sign (requestSigning stamps the requester).
 *  Execute/decline used to take ANY pending record for the document and never compared
 *  its signatory to the caller, so a different user's signature was recorded against
 *  (and attributed to) the requester. */
async function requirePendingFor(documentId: string, user: CurrentUser): Promise<SignatureRecord> {
  const pending = await SignatureRecord.findOne({ where: { documentId, status: 'PENDING' } });
  if (!pending || pending.signatoryUserId !== user.userId) {
    throw new AppError(
      403,
      'ERR-SIGN-NOT-SIGNATORY',
      'Only the person this document was sent to for signature can sign or decline it',
    );
  }
  return pending;
}

// ── Request signing ────────────────────────────────────────────────────────────

export async function requestSigning(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId);
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');

  assertSameTenant(document, user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  await assertNoLiveCeremony(documentId);

  // FIX: this hand-rolled allowlist (['APPROVED','ACTIVE','DRAFT']) let a
  // document skip approval entirely and go straight to PENDING_SIGNATURE —
  // the canonical graph in DocumentStateMachine.ts only permits that
  // transition from APPROVED or SIGNING_DECLINED. Same bug class as the one
  // fixed in esigning.service.ts's createSignatureRequest: validate against
  // the real state machine instead of a separate, looser, hand-maintained list.
  validateTransition(document.status, 'PENDING_SIGNATURE');

  const previousState = document.status;

  await runInTransaction(async (t) => {
    await document.update({ status: 'PENDING_SIGNATURE' }, { transaction: t });
    await SignatureRecord.create(
      {
        documentId,
        signatoryUserId: user.userId,
        signingType: 'ELECTRONIC',
        status: 'PENDING',
      },
      { transaction: t },
    );
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_SIGNED, // reuse; sign request
    userId: user.userId,
    userRole: user.role,
    documentId,
    previousState,
    newState: 'PENDING_SIGNATURE',
    actionDetails: { action: 'SIGN_REQUESTED', requestedBy: user.userId },
  });

  return { success: true, status: 'PENDING_SIGNATURE' };
}

// ── Execute signing ────────────────────────────────────────────────────────────

export async function executeSigning(
  documentId: string,
  user: CurrentUser,
  signingType: 'ELECTRONIC' | 'PKI_DIGITAL',
  extras: {
    ipAddress?: string;
    userAgent?: string;
    consentAcknowledged?: boolean;
  },
) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentVersion,
        as: 'versions',
        separate: true,
        limit: 1,
        order: [['createdAt', 'DESC']],
      },
    ],
  });
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  assertSameTenant(document, user);
  if (document.status !== 'PENDING_SIGNATURE') {
    throw new AppError(
      409,
      'ERR-SIGN-INVALID-STATE',
      'Document is not pending signature',
    );
  }
  if (signingType !== 'ELECTRONIC' && signingType !== 'PKI_DIGITAL') {
    throw new AppError(422, 'ERR-SIGN-TYPE-INVALID', 'signingType must be ELECTRONIC or PKI_DIGITAL');
  }
  await assertNoLiveCeremony(documentId);
  await requirePendingFor(documentId, user);

  const latestVersion = (document as any).versions?.[0];
  if (!latestVersion)
    throw new AppError(422, 'ERR-NO-VERSION', 'No document version found');

  // Recompute SHA-256 from storage for integrity check
  let documentHashAtSign = latestVersion.sha256Hash as string;
  try {
    const storage = getStorageAdapter();
    const _vault = getVaultService();
    const encryptedBuffer = await storage.get(
      latestVersion.storageKey + '.enc',
    );
    const computedHash = crypto
      .createHash('sha256')
      .update(encryptedBuffer)
      .digest('hex');
    if (computedHash !== latestVersion.sha256Hash) {
      throw new AppError(
        409,
        'ERR-INTEGRITY-VIOLATION',
        'Document integrity check failed before signing',
      );
    }
    documentHashAtSign = computedHash;
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Storage not available — use stored hash (acceptable in test/dev)
  }

  let signatureData: string | null = null;
  let certPem: string | null = null;
  let certSubject: string | null = null;
  let certIssuer: string | null = null;
  let certSerial: string | null = null;
  let certNotBefore: Date | null = null;
  let certNotAfter: Date | null = null;
  let sigAlgorithm: string | null = null;

  if (signingType === 'PKI_DIGITAL') {
    const { privateKeyPem, certPem: generatedCertPem } = await generateUserKeyPair(
      user.userId,
    );
    certPem = generatedCertPem;
    const parsedCert = forge.pki.certificateFromPem(certPem);
    certSubject = parsedCert.subject.getField('CN')?.value ?? user.userId;
    certIssuer = parsedCert.issuer.getField('CN')?.value ?? 'DMS Internal CA';
    certSerial = parsedCert.serialNumber;
    certNotBefore = parsedCert.validity.notBefore;
    certNotAfter = parsedCert.validity.notAfter;
    sigAlgorithm = 'RSA-PSS-SHA256';

    // Sign the document hash with RSA-PSS.  Store the matching certificate on
    // the signature record below so this can be cryptographically verified
    // later without retaining the user's private key.
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    const md = forge.md.sha256.create();
    md.update(forge.util.hexToBytes(documentHashAtSign));
    const pss = forge.pss.create({
      md: forge.md.sha256.create(),
      mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
      saltLength: 32,
    });
    signatureData = Buffer.from(
      forge.util.createBuffer(privateKey.sign(md, pss)).getBytes(),
      'binary',
    ).toString('base64');
  } else {
    // Electronic — consent required
    if (!extras.consentAcknowledged) {
      throw new AppError(
        422,
        'ERR-CONSENT-REQUIRED',
        'Electronic signature requires consent acknowledgement',
      );
    }
  }

  await runInTransaction(async (t) => {
    // Find the pending signature record and update it
    const pending = await SignatureRecord.findOne({
      where: { documentId, status: 'PENDING' },
      transaction: t,
    });

    const sigRecord = {
      status: 'SIGNED',
      signingType,
      signedAt: new Date(),
      documentHashAtSign,
      ...(signingType === 'PKI_DIGITAL'
        ? {
            certificateSubject: certSubject,
            certificateIssuer: certIssuer,
            certificateSerial: certSerial,
            certificatePem: certPem,
            certNotBefore,
            certNotAfter,
            signatureAlgorithm: sigAlgorithm,
            signatureData,
            ltvEmbedded: false,
          }
        : {
            ipAddress: extras.ipAddress ?? null,
            userAgent: extras.userAgent ?? null,
            consentAcknowledged: true,
          }),
    };

    if (pending) {
      // Stamp the version that was actually signed (verifySigning compares against it).
      await pending.update({ ...sigRecord, documentVersionId: latestVersion.id }, { transaction: t });
    } else {
      await SignatureRecord.create(
        {
          documentId,
          documentVersionId: latestVersion.id,
          signatoryUserId: user.userId,
          ...sigRecord,
        },
        { transaction: t },
      );
    }

    await document.update({ status: 'SIGNED' }, { transaction: t });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_SIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    previousState: 'PENDING_SIGNATURE',
    newState: 'SIGNED',
    actionDetails: {
      signingType,
      algorithm: sigAlgorithm ?? 'ELECTRONIC',
      hashAtSign: documentHashAtSign?.slice(0, 16) + '...',
    },
  });

  return { success: true, status: 'SIGNED', signingType };
}

// ── Decline signing ────────────────────────────────────────────────────────────

export async function declineSigning(
  documentId: string,
  user: CurrentUser,
  reason: string,
) {
  if (!reason || reason.trim().length < 5) {
    throw new AppError(
      422,
      'ERR-REASON-REQUIRED',
      'Decline reason must be at least 5 characters',
    );
  }

  const document = await Document.findByPk(documentId);
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  assertSameTenant(document, user);
  if (document.status !== 'PENDING_SIGNATURE') {
    throw new AppError(
      409,
      'ERR-SIGN-INVALID-STATE',
      'Document is not pending signature',
    );
  }
  await assertNoLiveCeremony(documentId);
  await requirePendingFor(documentId, user);

  await runInTransaction(async (t) => {
    const pending = await SignatureRecord.findOne({
      where: { documentId, status: 'PENDING' },
      transaction: t,
    });
    if (pending) {
      await pending.update(
        { status: 'DECLINED', declineReason: reason },
        { transaction: t },
      );
    }
    await document.update({ status: 'SIGNING_DECLINED' }, { transaction: t });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_SIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    previousState: 'PENDING_SIGNATURE',
    newState: 'SIGNING_DECLINED',
    isSuccess: false,
    actionDetails: { action: 'SIGN_DECLINED', reason, declinedBy: user.userId },
  });

  return { success: true, status: 'SIGNING_DECLINED' };
}

// ── Verify signing ─────────────────────────────────────────────────────────────

export async function verifySigning(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentVersion,
        as: 'versions',
        separate: true,
        limit: 1,
        order: [['createdAt', 'DESC']],
      },
    ],
  });
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  assertSameTenant(document, user);

  const signatures = await SignatureRecord.findAll({
    where: { documentId, status: 'SIGNED' },
    order: [['signedAt', 'DESC']],
  });

  if (!signatures.length) {
    return { valid: false, reason: 'No signatures found', signatures: [] };
  }

  const latestVersion = (document as any).versions?.[0];
  const results = [];

  for (const sig of signatures) {
    let hashValid = true;
    let pkiValid: boolean | null = null;
    let integrityIssue: string | null = null;

    // Recompute the hash of the version that was actually SIGNED. This used to compare
    // against the document's LATEST version, so filing any later version — including
    // the signed copy a completed e-signing ceremony files — made every earlier
    // signature read as "modified since signing" AND permanently flipped it to INVALID.
    const signedVersion: any = sig.documentVersionId && sig.documentVersionId !== latestVersion?.id
      ? await DocumentVersion.findByPk(sig.documentVersionId)
      : latestVersion;
    if (signedVersion) {
      try {
        const storage = getStorageAdapter();
        const encryptedBuffer = await storage.get(
          signedVersion.storageKey + '.enc',
        );
        const currentHash = crypto
          .createHash('sha256')
          .update(encryptedBuffer)
          .digest('hex');
        hashValid = currentHash === sig.documentHashAtSign;
        if (!hashValid) {
          integrityIssue = 'Document has been modified since signing';
          // Log security alert
          await writeAuditLog({
            eventType: AUDIT_EVENTS.DOCUMENT_SIGNED,
            userId: user.userId,
            userRole: user.role,
            documentId,
            isSuccess: false,
            errorCode: 'ERR-INTEGRITY-VIOLATION',
            actionDetails: {
              action: 'SIGNATURE_VERIFY_TAMPER_DETECTED',
              sigId: sig.id,
              expected: sig.documentHashAtSign,
              computed: currentHash,
            },
          });
          // Mark signature as INVALID
          await sig.update({ status: 'INVALID' });
        }
      } catch {
        integrityIssue = 'Storage unavailable for hash verification';
      }
    }

    // PKI signature verification.  `hashValid` only proves that the current
    // encrypted file matches the signed hash; it says nothing about who signed
    // that hash. Verify the signer certificate's CA chain, validity window,
    // and RSA-PSS signature independently.
    if (sig.signingType === 'PKI_DIGITAL') {
      if (!sig.signatureData || !sig.documentHashAtSign || !sig.certificatePem) {
        pkiValid = false;
        integrityIssue ??= 'PKI signature cannot be verified: signer certificate was not retained';
      } else {
        try {
          const cert = forge.pki.certificateFromPem(sig.certificatePem);
          const { caCert } = await getOrCreateCA();
          const now = new Date();
          const certificateValidNow = cert.validity.notBefore <= now && cert.validity.notAfter >= now;
          const issuedByTrustedCa = caCert.verify(cert);
          const md = forge.md.sha256.create();
          md.update(forge.util.hexToBytes(sig.documentHashAtSign));
          const pss = forge.pss.create({
            md: forge.md.sha256.create(),
            mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
            saltLength: 32,
          });
          // node-forge types the generic X.509 public key as a union that
          // also includes raw buffers; certificates created by this internal
          // RSA CA always carry an RSA public key.
          const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
          const signatureMatches = publicKey.verify(
            md.digest().getBytes(),
            Buffer.from(sig.signatureData, 'base64').toString('binary'),
            pss,
          );
          pkiValid = hashValid && certificateValidNow && issuedByTrustedCa && signatureMatches;
          if (!pkiValid) {
            integrityIssue ??= !certificateValidNow
              ? 'Signer certificate is outside its validity period'
              : !issuedByTrustedCa
                ? 'Signer certificate was not issued by the trusted internal CA'
                : !signatureMatches
                  ? 'PKI signature does not match the signed document hash'
                  : 'Document has been modified since signing';
          }
        } catch {
          pkiValid = false;
          integrityIssue ??= 'PKI signature verification failed';
        }
      }
    }

    results.push({
      signatureId: sig.id,
      signatoryUserId: sig.signatoryUserId,
      signingType: sig.signingType,
      status: sig.status,
      signedAt: sig.signedAt,
      hashValid,
      pkiValid,
      integrityIssue,
    });
  }

  const allValid = results.every(
    (r) => r.hashValid && r.status === 'SIGNED' && (r.signingType !== 'PKI_DIGITAL' || r.pkiValid === true),
  );

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_SIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: {
      action: 'SIGNATURE_VERIFIED',
      valid: allValid,
      signatureCount: results.length,
    },
  });

  return { valid: allValid, signatures: results };
}
