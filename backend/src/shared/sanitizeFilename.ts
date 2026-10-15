/**
 * Strips path separators and everything outside a safe [A-Za-z0-9._-] set
 * from a client-supplied filename before it becomes part of a storage key.
 * `path.join` does not strip ".." segments, so an unsanitized
 * `file.originalname` (e.g. `../../../../app/dist/main.js`) lets an
 * authenticated uploader write/overwrite arbitrary files under the local
 * storage driver. Collapsing every `/`/`\\` into `_` removes any path
 * segment boundary, so the result can never resolve outside the bucket dir
 * regardless of what the client sent.
 */
const MAX_BASENAME = 200;

export function sanitizeFilename(name: string): string {
  // Collapse every run of unsafe characters. `\w` is [A-Za-z0-9_], so every
  // path separator is already gone after this and the result cannot escape the
  // bucket directory regardless of what the client sent.
  let safe = name.replace(/[^\w.-]+/g, '_');

  // `..` survives the replace above (both characters are in the allowed set).
  // Traversal is already impossible without separators, but a literal `..` or a
  // leading dot still becomes a real, awkward path segment -- a hidden file, or
  // an entry that some tooling resolves as the parent. Collapse dot runs and
  // strip leading dots so the result is always an ordinary visible name.
  safe = safe.replace(/\.{2,}/g, '.').replace(/^\.+/, '');

  // Cap the length, preserving a short extension. Storage keys are built from
  // this, and there was no bound at all: a 10,000-character upload filename
  // became a 10,000-character key.
  if (safe.length > MAX_BASENAME) {
    const dot = safe.lastIndexOf('.');
    const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : '';
    safe = safe.slice(0, MAX_BASENAME - ext.length) + ext;
  }

  // Never return an empty string — the caller is about to use this as part of a
  // storage key.
  return safe.length > 0 ? safe : 'file';
}
