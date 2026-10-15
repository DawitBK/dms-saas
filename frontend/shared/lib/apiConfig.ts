// Single source of truth for the backend API base URL. Every place that needs
// a fallback (when NEXT_PUBLIC_API_BASE_URL isn't set) imports this instead of
// re-typing the literal — one spot to change, and one thing to check if a
// deployment ever silently falls back to it instead of the real env var.
import { BASE_PATH } from './basePath';

export const DEFAULT_API_BASE_URL = 'http://localhost:7100/api/v1';

// A production bundle silently hardwired to localhost is a broken deployment,
// not a fallback — fail the build (NEXT_PUBLIC_* is inlined at build time, so
// this throw fires during `next build`, never in a correctly-built app).
if (!process.env.NEXT_PUBLIC_API_BASE_URL && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_API_BASE_URL must be set for production builds (see frontend/Dockerfile build args)');
}

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;

// The guard above catches an UNSET url. This one catches the far more likely
// failure: a url that is set, and set to localhost.
//
// Next.js loads `.env.local` on top of `.env.production` for `next build`, and
// `.env.local` wins. This repo used to keep a `frontend/.env.local` holding
// NEXT_PUBLIC_API_BASE_URL=http://localhost:7100/api/v1 for local work, so a
// production build performed anywhere that file existed silently baked
// `localhost:7100` into every bundle — measured 2026-09-05: 20 files contained
// `localhost:7100` and ZERO contained the production URL from `.env.production`.
//
// The result is a DMS that builds cleanly, starts cleanly, serves its pages,
// and is completely unusable, because every browser tries to reach port 7100 on
// the END USER'S OWN machine. Nothing in the server logs would show it.
//
// Gated on BASE_PATH (same idiom as the socket-path check below) so it only
// fires for a real production LAYOUT — a deployment served under /dms — and
// never during ordinary local development, where BASE_PATH is empty.
//
// GMS solved the same footgun by renaming its file to
// `.env.local.dev-only-not-for-prod-builds`, which Next does not load. DMS went
// further on 2026-09-05 and moved its dev values to `frontend/.env.development`,
// which Next reads ONLY when NODE_ENV=development — and `next build` always runs
// in production mode, so a dev value there structurally cannot reach a bundle.
// There is no longer a file to rename or move aside before a release build.
// This check stays as the backstop for the other ways the URL can be wrong (a
// mistyped `.env.production`, a stray `.env.local` someone re-creates).
// NEXT_PUBLIC_MIRROR_BUILD (set by scripts/mirror-env.cjs, never present in
// a real deployment) exempts a genuine mirror build: this machine has no
// public DNS name, so a localhost API URL under a real basePath is the
// CORRECT value here, not the footgun this guard exists to catch. Must be
// NEXT_PUBLIC_-prefixed — this check is bundled into the client too, and an
// unprefixed var would only be visible server-side at build time, not in
// the browser. See that file's comment for why NODE_ENV alone can't make
// this distinction.
if (process.env.NODE_ENV === 'production' && BASE_PATH && process.env.NEXT_PUBLIC_MIRROR_BUILD !== 'true') {
  const host = (() => {
    try {
      return new URL(API_BASE_URL).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    throw new Error(
      `NEXT_PUBLIC_API_BASE_URL is "${API_BASE_URL}" in a production build served under "${BASE_PATH}". ` +
        "That points every browser at the machine it is running on, producing a silently broken deployment. " +
        'The usual cause is a frontend/.env.local left in place: Next loads it in production builds too, on top of .env.production, and it wins. ' +
        'Development values belong in frontend/.env.development, which Next reads only when NODE_ENV=development. Delete frontend/.env.local and rebuild.',
    );
  }
}

// Socket.IO endpoint (the API origin, no /api/v1 path). Same build-time
// contract as API_BASE_URL: explicit in production, localhost only in dev.
export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ?? new URL(API_BASE_URL).origin;

// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO mount path.
//
// FIX (2026-09-03, F-06 follow-up): DMS realtime was completely dead in
// production, silently, and the fallback poll was the only thing keeping any
// view fresh. Two separate causes, both invisible from dev (where DMS owns
// localhost:7101 outright and nothing else answers on the origin):
//
//   1. Socket.IO treats a PATH in the connection URL as a NAMESPACE, not as a
//      path prefix. `SOCKET_URL` above is deliberately an ORIGIN, so the
//      client asked for `https://portal.examplecorp.com/socket.io/` — the
//      DEFAULT path, with no `/dms` on it.
//   2. On the shared reverse proxy all four systems live on ONE origin
//      separated by path only, and the unprefixed `/socket.io/` rule belongs
//      to GMS (`ws://127.0.0.1:7200/socket.io/`, it was live first). So every
//      DMS browser opened its realtime connection against GMS's Socket.IO
//      server, handed it a DMS access token, and got a failed handshake. The
//      Apache rule that points at DMS (`/dms/socket.io/` -> 7100) was correct
//      and present the whole time; nothing ever requested it.
//
// Derived from the same NEXT_PUBLIC_BASE_PATH that next.config.ts feeds to
// `basePath`, so the socket path cannot drift from the path the app is served
// under — which is exactly how these two got out of step.
export const SOCKET_PATH = normalizeSocketPath(
  process.env.NEXT_PUBLIC_SOCKET_PATH ?? `${BASE_PATH}/socket.io`,
);

function normalizeSocketPath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // Same build-time contract as API_BASE_URL: a production bundle whose
  // socket path does not sit under the deployment's basePath would route to
  // whichever sibling system owns that path on the shared origin, so fail the
  // build rather than ship a silently dead realtime pipeline.
  if (
    process.env.NODE_ENV === 'production' &&
    BASE_PATH &&
    !path.startsWith(`${BASE_PATH}/`)
  ) {
    throw new Error(
      `NEXT_PUBLIC_SOCKET_PATH ("${path}") must sit under NEXT_PUBLIC_BASE_PATH ("${BASE_PATH}") — ` +
        'on the shared reverse proxy an unprefixed /socket.io/ belongs to a sibling system',
    );
  }
  return path;
}
