/**
 * Prefixes a root-relative app path with this deployment's basePath.
 *
 * DMS is served at https://portal.examplecorp.com/dms in production but sits at
 * the root of localhost:7101 in development. `next.config.ts`'s `basePath`
 * already rewrites pages, `next/link`, and the router — this helper covers
 * everything Next does NOT auto-prefix: manifest/icon hrefs in metadata and
 * the service worker registration URL.
 *
 * NEXT_PUBLIC_BASE_PATH is read at build time and inlined into the browser
 * bundle, and is the same value next.config.ts feeds to `basePath` — the two
 * cannot disagree. Empty in dev.
 *
 * Use for manifest/icon metadata and sw.js registration only. Do not use for
 * `next/link` hrefs or `router.push()` — Next already prefixes those.
 */
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

export function withBasePath(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

export { BASE_PATH };
