// F-06 follow-up (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): DMS realtime was completely
// dead in production, silently, and the fallback poll was the only thing
// keeping any view fresh. Nothing in dev could show it — on localhost:7101 DMS
// owns the origin and nothing else answers on it.
//
// Two causes:
//   1. Socket.IO treats a PATH in the connection URL as a NAMESPACE, not as a
//      path prefix. SOCKET_URL is deliberately an ORIGIN, so the client asked
//      for `https://portal.examplecorp.com/socket.io/` — the DEFAULT path, with
//      no `/dms` on it.
//   2. On the shared reverse proxy all four systems live on ONE origin
//      separated by path only, and the unprefixed `/socket.io/` rule belongs
//      to GMS. So every DMS browser opened its realtime connection against
//      GMS's Socket.IO server and handed it a DMS token. The Apache rule that
//      points at DMS (`/dms/socket.io/` -> 7100) was correct and present the
//      whole time; nothing ever requested it.
//
// These tests pin the derivation, because the failure mode is invisible: a
// wrong path does not error, it connects somewhere else (or nowhere) and the
// UI just quietly stops updating.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Re-import the module under a specific env. NEXT_PUBLIC_* values are inlined
 * at build time, so the module reads them at evaluation — the module registry
 * has to be reset between cases.
 */
async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import('./apiConfig');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PROD_ENV = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_BASE_PATH: '/dms',
  NEXT_PUBLIC_API_BASE_URL: 'https://portal.examplecorp.com/dms/api/v1',
  NEXT_PUBLIC_SOCKET_PATH: undefined,
};

const DEV_ENV = {
  NODE_ENV: 'development',
  NEXT_PUBLIC_BASE_PATH: undefined,
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:7100/api/v1',
  NEXT_PUBLIC_SOCKET_PATH: undefined,
};

describe('SOCKET_PATH derivation', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it('prefixes the socket path with the deployment basePath in production', async () => {
    const { SOCKET_PATH } = await loadWithEnv(PROD_ENV);
    // The whole bug in one assertion: it must NOT be "/socket.io", which on
    // the shared origin is GMS's endpoint.
    expect(SOCKET_PATH).toBe('/dms/socket.io');
    expect(SOCKET_PATH).not.toBe('/socket.io');
  });

  it('keeps SOCKET_URL an origin, with no path on it', async () => {
    const { SOCKET_URL } = await loadWithEnv(PROD_ENV);
    // A path here would be read as a Socket.IO NAMESPACE, not a prefix, which
    // is the trap that produced the bug.
    expect(SOCKET_URL).toBe('https://portal.examplecorp.com');
    expect(new URL(SOCKET_URL).pathname).toBe('/');
  });

  it('uses the bare default path in dev, where there is no basePath', async () => {
    const { SOCKET_PATH } = await loadWithEnv(DEV_ENV);
    expect(SOCKET_PATH).toBe('/socket.io');
  });

  it('honours an explicit NEXT_PUBLIC_SOCKET_PATH override', async () => {
    const { SOCKET_PATH } = await loadWithEnv({
      ...PROD_ENV,
      NEXT_PUBLIC_SOCKET_PATH: '/dms/realtime',
    });
    expect(SOCKET_PATH).toBe('/dms/realtime');
  });

  it('normalises a trailing slash and a missing leading slash', async () => {
    // Socket.IO compares the path literally, so "/dms/socket.io/" and
    // "dms/socket.io" are both wrong in ways that fail silently.
    const trailing = await loadWithEnv({ ...PROD_ENV, NEXT_PUBLIC_SOCKET_PATH: '/dms/socket.io/' });
    expect(trailing.SOCKET_PATH).toBe('/dms/socket.io');

    const noLeading = await loadWithEnv({ ...PROD_ENV, NEXT_PUBLIC_SOCKET_PATH: 'dms/socket.io' });
    expect(noLeading.SOCKET_PATH).toBe('/dms/socket.io');
  });

  it('fails the production build if the socket path escapes the basePath', async () => {
    // The build-time guard. Shipping this would point every browser's realtime
    // connection at whichever sibling system owns that path on the shared
    // origin — which is exactly what happened, and it produced no error at
    // all, just a UI that stopped updating.
    await expect(
      loadWithEnv({ ...PROD_ENV, NEXT_PUBLIC_SOCKET_PATH: '/socket.io' }),
    ).rejects.toThrow(/must sit under NEXT_PUBLIC_BASE_PATH/);
  });

  it('allows an unprefixed path in dev, where nothing shares the origin', async () => {
    const { SOCKET_PATH } = await loadWithEnv({
      ...DEV_ENV,
      NEXT_PUBLIC_SOCKET_PATH: '/socket.io',
    });
    expect(SOCKET_PATH).toBe('/socket.io');
  });
});
