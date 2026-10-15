/**
 * dr-decrypt-version.ts — Disaster-recovery helper: decrypt one stored
 * document version straight to a plain file on disk, outside any HTTP
 * request.
 *
 * Deliberately reuses the app's own fetchAndDecrypt()/fetchDecryptStream()
 * (documentCrypto.ts) and DocumentDek/DocumentVersion models rather than
 * re-implementing AES-KW/AES-GCM by hand — same code path a real download
 * request goes through, so it stays correct if that logic ever changes
 * (KEK rotation, format_version bump, hashicorp backend, etc.).
 *
 * Usage (run wherever VAULT_MASTER_KEY[_Vn] or VAULT_ADDR/VAULT_TOKEN are
 * actually set — normally the server itself, or a local .env pointed at a
 * restored DB + a copy of backend/storage/ + the real .env.production):
 *
 *   node scripts/run-with-env.cjs production tsx scripts/dr-decrypt-version.ts <versionId> <outputPath>
 *
 * <versionId> is a document_versions.id (uuid). If you only have a
 * document_id, look up its versions first:
 *   SELECT id, version_number, original_filename, storage_key
 *   FROM document_versions WHERE document_id = '<documentId>' ORDER BY version_number;
 */
import '../src/config/env.js';
import { DocumentDek, DocumentVersion, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { fetchAndDecrypt, fetchDecryptStream } from '../src/modules/documents/documentCrypto.js';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function main() {
  const [versionId, outPath] = process.argv.slice(2);
  if (!versionId || !outPath) {
    console.error('Usage: tsx scripts/dr-decrypt-version.ts <versionId> <outputPath>');
    process.exit(1);
  }

  initModels();
  await sequelize.authenticate();

  const version = await DocumentVersion.findByPk(versionId);
  if (!version) {
    console.error(`No document_versions row found for id ${versionId}`);
    process.exit(1);
  }

  const dek = await DocumentDek.findOne({ where: { versionId }, attributes: ['formatVersion'] });
  if (!dek) {
    console.error(`No document_deks row found for versionId ${versionId} — key is missing, this file cannot be decrypted.`);
    process.exit(1);
  }

  if (dek.formatVersion === 2) {
    const stream = await fetchDecryptStream(version.storageKey, versionId);
    await pipeline(stream, fs.createWriteStream(outPath));
  } else {
    const plaintext = await fetchAndDecrypt(version.storageKey, versionId);
    await fs.promises.writeFile(outPath, plaintext);
  }

  console.log(`Decrypted "${version.originalFilename}" (version ${version.versionNumber}) -> ${outPath}`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
