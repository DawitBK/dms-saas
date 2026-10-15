// Images inserted directly into a letter's rich-text Body — see
// migrations/20260922000001-letter-body-images.sql for why these are a
// separate, lighter-weight store from LetterAttachment/Document rows.
//
// Uploaded independently of any specific letter (the compose form at
// letters/new has no letter id yet when an author pastes/inserts an image),
// so there is no letterId FK here — the association lives one level up, in
// the doc JSON itself (an image node's `src` names this row's id).

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../core/AppError.js';
import { Op, type Transaction } from 'sequelize';
import { LetterBodyImage, LetterBodyImageLink } from '../../infrastructure/database/index.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import type { CurrentUser } from '../approvals/stepRules.js';
import type { ImageResolver } from './letterBodyPdfRenderer.js';

// Dynamic import, not a static one: StorageAdapter.ts pulls in minio.ts,
// which constructs a MinIO Client AT MODULE LOAD from config.MINIO_ENDPOINT
// — several existing letters tests (letters.scopeWhere.test.ts,
// letters.byDocument.test.ts) mock `config/env.js` wholesale with an object
// that has no MINIO_ENDPOINT key at all, since they only exercise
// permission/scope logic and never touch storage. Those tests already mock
// documentCrypto.js/letterPdf.js specifically to keep the real minio.ts out
// of their import graph; this file has no equivalent mock anywhere, so a
// static import here would crash every one of them the moment
// letters.service.ts (which they DO import for real) pulled this file in —
// even though none of them ever call the two functions below. Deferring the
// import until a function actually runs keeps this file side-effect-free to
// merely require, matching what those tests already assume of every other
// module in this chain.
async function loadStorageAdapter() {
  const { getStorageAdapter } = await import('../../infrastructure/storage/StorageAdapter.js');
  return getStorageAdapter();
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function uploadLetterBodyImage(
  file: Express.Multer.File | undefined,
  user: CurrentUser,
): Promise<{ id: string; url: string; width: number; height: number }> {
  if (!file) throw new AppError(400, 'ERR-NO-FILE', 'No image file was uploaded');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new AppError(422, 'ERR-UNSUPPORTED-IMAGE-TYPE', 'Only PNG, JPEG, WEBP, and GIF images are supported');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AppError(422, 'ERR-IMAGE-TOO-LARGE', `Image exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`);
  }
  await scanBuffer(file.buffer); // throws ERR-AV-THREAT-DETECTED on a real hit

  // Normalized to PNG at rest — one decode path for the PDF renderer to
  // trust later (mirrors letterPdf.ts's embedSignatureImage, which does the
  // same for a captured e-signature image), and sidesteps GIF's PDF-drawing
  // path (pdf-lib has no native GIF embedder) entirely.
  let png: Buffer;
  let width: number;
  let height: number;
  try {
    const image = sharp(file.buffer);
    const metadata = await image.metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
    png = await image.png().toBuffer();
  } catch {
    throw new AppError(422, 'ERR-INVALID-IMAGE', 'The uploaded file is not a readable image');
  }

  const id = randomUUID();
  const storageKey = `letters/body-images/${user.tenantId}/${id}.png`;
  await (await loadStorageAdapter()).put(storageKey, png, 'image/png');

  await LetterBodyImage.create({
    id,
    tenantId: user.tenantId,
    uploadedBy: user.userId,
    mimeType: 'image/png',
    sizeBytes: String(png.length),
    storageKey,
  });

  return { id, url: `/letters/body-images/${id}`, width, height };
}

const IMAGE_SRC_PATTERN = /\/letters\/body-images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Every body image id a letter body refers to (structured JSON or legacy text alike). */
export function extractBodyImageIds(bodyHtml: string | null | undefined): string[] {
  if (!bodyHtml) return [];
  const ids = new Set<string>();
  for (const match of bodyHtml.matchAll(IMAGE_SRC_PATTERN)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}

/**
 * L13: a letter body may only embed images its own author uploaded in this tenant. Before this the
 * save accepted any id, and the final PDF then rendered whatever tenant image the id pointed at.
 * Unknown ids, other tenants' ids and other users' images all answer the same 422.
 */
export async function assertBodyImagesUsable(
  bodyHtml: string | null | undefined,
  user: Pick<CurrentUser, 'userId' | 'tenantId'>,
): Promise<string[]> {
  const ids = extractBodyImageIds(bodyHtml);
  if (ids.length === 0) return ids;
  const rows = await LetterBodyImage.findAll({
    where: { id: { [Op.in]: ids }, tenantId: user.tenantId, uploadedBy: user.userId },
    attributes: ['id'],
  });
  if (rows.length !== ids.length) {
    throw new AppError(
      422,
      'ERR-BODY-IMAGE-FORBIDDEN',
      'The letter body uses an image that was not uploaded by you. Remove it and insert the image again.',
    );
  }
  return ids;
}

/** Record that `letterId` embeds these images (insert-only, see migration 20261004000030). */
export async function linkBodyImagesToLetter(
  letterId: string,
  tenantId: string,
  imageIds: string[],
  tx?: Transaction,
): Promise<void> {
  if (imageIds.length === 0) return;
  await LetterBodyImageLink.bulkCreate(
    imageIds.map((imageId) => ({ imageId, letterId, tenantId })),
    { transaction: tx, ignoreDuplicates: true },
  );
}

/**
 * L13: the image's uploader may always fetch it (they are composing); anyone else only through a
 * letter that embeds it AND that they may read. `canReadAnyLetter` is supplied by letters.service
 * (the single owner of letter scope) so the scope rule is not copied here.
 */
export async function downloadLetterBodyImage(
  imageId: string,
  user: CurrentUser,
  canReadAnyLetter: (letterIds: string[], user: CurrentUser) => Promise<boolean>,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const row = await LetterBodyImage.findOne({ where: { id: imageId, tenantId: user.tenantId } });
  if (!row) throw new AppError(404, 'ERR-IMAGE-NOT-FOUND', 'Image not found');
  if (row.uploadedBy !== user.userId) {
    const links = await LetterBodyImageLink.findAll({ where: { imageId, tenantId: user.tenantId }, attributes: ['letterId'] });
    const readable = links.length > 0 && (await canReadAnyLetter(links.map((l) => l.letterId), user));
    // Same answer as a missing image: do not confirm that someone else's image id exists.
    if (!readable) throw new AppError(404, 'ERR-IMAGE-NOT-FOUND', 'Image not found');
  }
  const buffer = await (await loadStorageAdapter()).get(row.storageKey);
  return { buffer, mimeType: row.mimeType };
}

/** The PDF renderer's image-fetch callback (letterBodyPdfRenderer.ts's
 *  ImageResolver) — resolves an image node's `src` (as stored in a letter's
 *  bodyHtml JSON, `/letters/body-images/:id`) straight to bytes, in-process,
 *  without an HTTP round trip. Scoped to one tenant AND to the letter author's own uploads
 *  (L13), so a letter can never embed another tenant's or another user's image by id even if a
 *  `src` were hand-edited or predates the save-time check. */
export function makeLetterBodyImageResolver(tenantId: string, authorUserId: string): ImageResolver {
  return async (src: string): Promise<Buffer | null> => {
    const match = /\/letters\/body-images\/([0-9a-f-]{36})/i.exec(src);
    if (!match) return null;
    const row = await LetterBodyImage.findOne({ where: { id: match[1], tenantId, uploadedBy: authorUserId } });
    if (!row) return null;
    try {
      return await (await loadStorageAdapter()).get(row.storageKey);
    } catch {
      return null;
    }
  };
}
