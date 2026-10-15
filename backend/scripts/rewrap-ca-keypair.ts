/**
 * rewrap-ca-keypair.ts — Rewrap storage/.ca-keypair.json's encrypted private
 * key onto a fresh DEK under the current KEK, mirroring rewrap-deks.ts.
 *
 * NOT covered by rewrap-deks.ts — that script only touches the
 * document_deks table. This file (DMS's internal signing CA, used to issue
 * every user's PKI_DIGITAL signing certificate — signing.service.ts) has
 * its own inline encryptedDek/kekId pair, easy to forget during a key
 * rotation. getOrCreateCA() silently mints a BRAND NEW CA — with no error,
 * no warning — the moment it ever fails to decrypt this file, which
 * permanently breaks verification of every previously-issued PKI signature.
 * Run this after rewrap-deks.ts --execute reports 0 pending, every time you
 * rotate VAULT_MASTER_KEY, before ever considering removing an old
 * VAULT_MASTER_KEY_V{n} value from the env file.
 *
 * Usage:
 *   node scripts/run-with-env.cjs production tsx scripts/rewrap-ca-keypair.ts            (dry run — just proves it still decrypts)
 *   node scripts/run-with-env.cjs production tsx scripts/rewrap-ca-keypair.ts --execute   (re-wrap onto the current KEK version for real)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import '../src/config/env.js';
import { getVaultService } from '../src/infrastructure/vault/VaultService.js';

const CA_KEYPAIR_PATH = path.resolve(process.cwd(), 'storage', '.ca-keypair.json');

interface PersistedCA {
  certPem: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  encryptedDek: string;
  kekId: string;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const vault = getVaultService();

  const raw = await fs.readFile(CA_KEYPAIR_PATH, 'utf8');
  const stored: PersistedCA = JSON.parse(raw);

  console.log(`CA keypair currently wrapped under kekId: ${stored.kekId}`);

  const plaintextDek = await vault.unwrapDEK(stored.encryptedDek, stored.kekId);
  const iv = Buffer.from(stored.iv, 'base64');
  const authTag = Buffer.from(stored.authTag, 'base64');
  const ciphertext = Buffer.from(stored.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', plaintextDek, iv);
  decipher.setAuthTag(authTag);
  const keyPem = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  plaintextDek.fill(0);
  console.log('OK — decrypted successfully with the currently-configured key(s). The CA keypair is intact.');

  if (!execute) {
    console.log('Dry run only. Re-run with --execute to re-wrap this file onto the current KEK version.');
    return;
  }

  const { plaintextDek: newDek, encryptedDek: newEncryptedDek, kekId: newKekId } = await vault.generateDEK('system');
  const newIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', newDek, newIv);
  const newCiphertext = Buffer.concat([cipher.update(Buffer.from(keyPem, 'utf8')), cipher.final()]);
  const newAuthTag = cipher.getAuthTag();
  newDek.fill(0);

  const rewrapped: PersistedCA = {
    certPem: stored.certPem,
    iv: newIv.toString('base64'),
    authTag: newAuthTag.toString('base64'),
    ciphertext: newCiphertext.toString('base64'),
    encryptedDek: newEncryptedDek,
    kekId: newKekId,
  };

  await fs.writeFile(CA_KEYPAIR_PATH, JSON.stringify(rewrapped, null, 2), 'utf8');
  console.log(`Rewrapped. New kekId: ${newKekId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
