/**
 * A header-safe Content-Disposition for a stored, user-supplied filename.
 *
 * Node refuses any header value holding a character above U+00FF (ERR_INVALID_CHAR), so a document
 * whose name is Amharic, Arabic or Chinese — which a resumable (tus) upload stores as typed — made its
 * download answer 500; quotes and backslashes in a name also broke the quoted-string. Send a quoted
 * ASCII fallback for old clients and carry the real name as RFC 5987 `filename*`.
 */
export function attachmentDisposition(filename: string | null | undefined): string {
  const name = (filename ?? "").trim() || "document";
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * unescaped; RFC 5987 attr-char does not allow ' ( ) *.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
