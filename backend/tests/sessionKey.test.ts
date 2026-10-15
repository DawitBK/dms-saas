/**
 * DMS verifies its own session tokens whether or not LOCAL_JWT_MOCK is on.
 *
 * Every sign-in, SSO or not, ends with DMS minting its own RS256 token under keyid
 * 'dev-key'. Before 2026-10-04 that key was only reachable through the
 * LOCAL_JWT_MOCK branch of getPublicKey, so setting LOCAL_JWT_MOCK=false (to close
 * the passwordless /auth/login) would have rejected every request from every user.
 * These pin the corrected behaviour, including that turning the flag off did not
 * open anything.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: () => ({
    getSigningKey: async () => { throw new Error('no such key in the IdP JWKS'); },
  }),
}));

import { config } from '../src/config/env.js';
import { verifyAccessToken } from '../src/shared/auth.js';

const ISS = 'https://idp.example.test';
const AUD = 'dms-api';

function pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

const ours = pair();
const attacker = pair();

function sign(privateKey: string, keyid?: string) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { user_id: 'u1', role: 'EMPLOYEE', roles: ['EMPLOYEE'], tenant_id: 't1', permissions: [], iss: ISS, aud: AUD, iat: now, exp: now + 300 },
    privateKey,
    { algorithm: 'RS256', ...(keyid ? { keyid } : {}) },
  );
}

const saved = { ...config };

beforeEach(() => {
  Object.assign(config, {
    NODE_ENV: 'production',
    LOCAL_JWT_MOCK: false,
    AUTH_ISSUER: ISS,
    AUTH_AUDIENCE: AUD,
    DEV_JWT_ISSUER: undefined,
    DEV_JWT_AUDIENCE: undefined,
    DEV_RSA_PUBLIC_KEY: Buffer.from(ours.publicKey).toString('base64'),
    AUTH_JWKS_URI: 'https://idp.example.test/jwks',
  });
});

afterAll(() => {
  Object.assign(config, saved);
});

describe('verifying DMS session tokens with LOCAL_JWT_MOCK off, in production', () => {
  it("accepts a token DMS signed itself under keyid 'dev-key'", async () => {
    const payload = await verifyAccessToken(sign(ours.privateKey, 'dev-key'));
    expect(payload.user_id).toBe('u1');
  });

  it('rejects a token carrying the same keyid but signed with someone else\'s key', async () => {
    await expect(verifyAccessToken(sign(attacker.privateKey, 'dev-key'))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('does NOT accept our key for a token with any other keyid (those go to the IdP JWKS and fail there)', async () => {
    await expect(verifyAccessToken(sign(ours.privateKey, 'some-idp-kid'))).rejects.toBeDefined();
  });

  it('does NOT accept a token with no keyid at all in production (that path is test/dev-only)', async () => {
    await expect(verifyAccessToken(sign(ours.privateKey))).rejects.toBeDefined();
  });

  it('is unchanged when the mock flag is on', async () => {
    config.LOCAL_JWT_MOCK = true;
    expect((await verifyAccessToken(sign(ours.privateKey, 'dev-key'))).user_id).toBe('u1');
    await expect(verifyAccessToken(sign(ours.privateKey, 'some-idp-kid'))).rejects.toBeDefined();
  });
});

describe('outside production the mock flag still governs key-less test tokens', () => {
  beforeEach(() => { config.NODE_ENV = 'test'; });

  it('accepts a key-less token only while LOCAL_JWT_MOCK is on', async () => {
    config.LOCAL_JWT_MOCK = true;
    expect((await verifyAccessToken(sign(ours.privateKey))).user_id).toBe('u1');
    config.LOCAL_JWT_MOCK = false;
    await expect(verifyAccessToken(sign(ours.privateKey))).rejects.toBeDefined();
  });
});
