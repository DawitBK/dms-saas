/**
 * Phase 2 verification — revived subsystems, at the service/DB layer.
 *   - Forms instance creation actually files a Document (was DB-broken).
 *   - executePurge really deletes rows + issues a Certificate of Destruction
 *     (purge previously only flipped a status; no CoD was ever created).
 *   - Audit writes are stamped with tenant_id (cross-tenant export closed).
 *
 * Run: npx tsx test-scripts/verify-phase2.ts   (needs a live DB)
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

import { sequelize } from '../src/infrastructure/database/sequelize.js';
import {
  initModels, Document, DocumentVersion, DocumentDek, DocumentType, Department,
  CertificateOfDestruction, FormTemplate, AuditLog,
} from '../src/infrastructure/database/models/index.js';
import { executePurge } from '../src/modules/documents/trashService.js';
import { createFormInstance, createFormTemplate, updateFormTemplateStatus } from '../src/modules/forms/forms.service.js';
import { writeAuditLog } from '../src/modules/audit/audit.service.js';
import { ROLE_PERMISSIONS } from '../src/config/permissions.js';
import { assertLocalDevDatabase, needsDemoData, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

// The verification tenant (qa-lab unless VERIFY_TENANT says otherwise): this script writes documents, purges one and
// writes audit rows, so it must never default to a tenant that holds real data. See lib/dev-admin.ts.
const TENANT = verifyTenantId();
let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}`, d ?? ''); }
};

async function run() {
  assertLocalDevDatabase(sequelize.config.host, sequelize.config.database);
  await sequelize.authenticate();
  initModels();
  console.log('\n═══ Phase 2 verification ═══\n');

  const admin = await sequelize.query<{ id: string }>(
    `SELECT id FROM users WHERE email = :email LIMIT 1`,
    { replacements: { email: verifyAdminEmail() }, type: (await import('sequelize')).QueryTypes.SELECT },
  );
  if (!admin[0]) needsDemoData('verify-phase2.ts', `no user "${verifyAdminEmail()}" (set VERIFY_ADMIN_EMAIL to an existing administrator)`);
  const userId = admin[0].id;
  // Publishing a tenant-wide form needs an organisation-level permission now (formTemplateScope.ts), so the actor carries
  // SYSTEM_ADMIN's real permission set rather than the empty list this script used to pass.
  const user = { userId, role: 'SYSTEM_ADMIN', roles: ['SYSTEM_ADMIN'], tenantId: TENANT, permissions: [...ROLE_PERMISSIONS.SYSTEM_ADMIN] } as any;

  // ── 1. Forms instance creation ──
  console.log('1. Forms instance creation (was DB-broken)');
  const tpl = await createFormTemplate(
    { name: `P2 Test Form ${Date.now()}`, schemaJson: [[]], layoutMode: 'static' },
    user,
  );
  await tpl.update({ status: 'active', approvedBy: userId });
  const { instance } = await createFormInstance(tpl.id, { field1: 'value' }, user);
  check('form instance created', Boolean(instance?.id));
  const formDoc = instance.documentId ? await Document.findByPk(instance.documentId) : null;
  check('form instance filed a valid Document (documentName/dept/type set)',
    Boolean(formDoc && formDoc.documentName && formDoc.departmentId && formDoc.documentTypeId));
  const formVer = await DocumentVersion.findOne({ where: { documentId: instance.documentId! } });
  const formDek = await DocumentDek.findOne({ where: { documentId: instance.documentId! } });
  check('form Document has an encrypted version + DEK', Boolean(formVer && formDek));

  // ── 2. Purge + Certificate of Destruction ──
  console.log('\n2. executePurge — real deletion + Certificate of Destruction');
  const docType = await DocumentType.findOne({ where: { tenantId: TENANT, code: 'CORR' } });
  const dept = await Department.findOne({ where: { tenantId: TENANT } });
  const purgeDocId = crypto.randomUUID();
  const purgeVerId = crypto.randomUUID();
  await Document.create({
    id: purgeDocId, tenantId: TENANT, documentName: `P2-PURGE-${Date.now()}`, title: 'purge target',
    departmentId: dept!.id, documentTypeId: docType!.id, folderId: null, ownerId: userId,
    organisationUnit: dept!.code, status: 'TRASHED', securityClassification: 'INTERNAL',
    retentionClass: 'RET-CORR-5Y', documentDate: new Date(), retentionTriggerDate: new Date(),
    source: 'CREATED_IN_SYSTEM', deletedAt: new Date(),
  } as any);
  await DocumentVersion.create({
    id: purgeVerId, documentId: purgeDocId, versionNumber: '1.0', isMajorVersion: true,
    storageKey: `${dept!.code}/CORR/${purgeDocId}/${purgeVerId}/x.pdf`, storageBucket: 'dms-documents',
    fileSize: BigInt(10), mimeType: 'application/pdf', originalFilename: 'x.pdf',
    sha256Hash: 'x', plaintextSha256: 'x', authorId: userId, changeSummary: 'test',
  } as any);
  await DocumentDek.create({ documentId: purgeDocId, versionId: purgeVerId, encryptedDek: 'x', kekId: 'x', algorithm: 'AES-256-GCM' } as any);

  const result = await executePurge(purgeDocId, userId);
  check('executePurge returns a certificate reference', /^COD-\d{4}-/.test(result.certificateReference), result.certificateReference);
  check('document row deleted', !(await Document.findByPk(purgeDocId)));
  check('version rows deleted', (await DocumentVersion.count({ where: { documentId: purgeDocId } })) === 0);
  check('DEK deleted (key destroyed)', !(await DocumentDek.findOne({ where: { documentId: purgeDocId } })));
  const cod = await CertificateOfDestruction.findOne({ where: { reference: result.certificateReference } });
  check('Certificate of Destruction row exists', Boolean(cod));
  check('CoD references the purged document', Boolean(cod && cod.documentIds.includes(purgeDocId)));

  // ── 3. Audit tenant stamping ──
  console.log('\n3. Audit tenant scoping');
  await writeAuditLog({ eventType: 'SYSTEM_SEED' as any, tenantId: TENANT, userId, actionDetails: { p2: true } });
  const recent = await AuditLog.findOne({ where: { tenantId: TENANT }, order: [['sequenceNumber', 'DESC']] });
  check('audit rows are stamped with tenant_id', Boolean(recent && recent.tenantId === TENANT));

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error('FATAL:', e); process.exit(1); });
