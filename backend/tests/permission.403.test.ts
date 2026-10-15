import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/config/permissions.js';

const testPriv = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC10FxO/RsS2HSV
tUZ4NnHv5CrQKmRxryMSooAnWkEWRiCG9rt93bkvI/p+Kh76DUR96XouqT5aIRz4
Ehth/bDJj95NSRaGjjYZNnVNmWbloRAWAl7CXbkSg2gVFKujuZMTYRnuV0i69Xzc
IdZ8EkI041t43tB+4//kJ7VMwaC0jMWzU/wBiwugp/bvJOBmRy9EUxRSTu5pJ+iW
T0MQzzWzqz//FIXqKNVhb8/ukE6ABBGuLS1UIYu795+9iKBBOEUAJ6uyFGD2kg9z
ieen7AjdhgyVNedCbW29Pk2NE+tOavLk1hwQx+97wmnkwFEPyLBKEK450fSfo1vB
WCxxcUcHAgMBAAECggEAB7AqmWPokHVNUMR3vay+kYUMnCG1ow9RSRJMn5Q9Blmr
Xrvxp7dQ8Tin1EyD9fYTqhWpPgC8r9D+W+Q7jQ1ghNV1BJtWc8uVsJ716FBF4p8R
8BDkKcQzYyBPrfyGxz5QF2b7UrrwuIhQqzExZj8kjUexpzyqhKevzWvpASZWXTU4
O/hKjV+9mHPcDXaW6QZu0V+KNdBD+qQJb0ZHPti3Z3IOJU2+MYS4PFfpT4kH/r/9
rmRTdCkrl9ZCzlfp7ElFeu3syZnaeBEgheRSqk12fwg2EwIbF1snHmNw3JhLNV6Z
s0o7kIqSFflhBeprhXiMpFfTRHyKOlW/JvLY/yV+MQKBgQD72TLiie7WRJ49ho2C
/wwvT1delvw7JCLUx/1Ve8O/unyrVN4lJTaYqaOu1ObwzYyoOsRhMiXJwhRBdmvF
rp9ElVXlxMvUTCX8sT2hOsQhrqX3rgDVR9D8HYaI9Serm7joaw2d0K362/E6Ajmn
YCSRTxqg7IiRrneiD/WbTWLuqQKBgQC4z52qlMK+xUcvzfyxb1dOyOMLXwI/MCr1
LKLNIi96O+1jTZHWRhHCk/flByDguDVPZE/UoD5Dw3qiQA1Sv5fZRVtH8Y17WJMo
5qsvoYVrU8lmcAaYkUsR0dbm41OpeR+UPqR0H4URHjye1zcZmlyZNByilDWk+dtC
s4k86GOGLwKBgQDFgMCx/Z+qsycxcsqZV3BzzZHj4R4vNxiFq8yU9Dk/q3zHVAfe
M3/MWwS9P8NYRqou599Hpe8SeTwvVjIQVfAa9c3mId4DQDBuKYT+Yrqa+362bOPE
XsyaWoE9+JvCrZ1lz0ZfY958o21ao5IZG4Gx3sowNy6mqJ6zHjbrMtYJ+QKBgQCh
zkyJg/M5mXmpFh0usH/tX57BXu6VqjOCMxFarpqI150Qu2J7CyATjv+USvhzJ3St
TPNEAwRgye49zfycPVjShpHT3F3152f4gHTSoAUzIcmMYXq060ihkmon/lJKZ9zJ
K0tKzCnyAdora9w3E1oNXH3RrheFmKhqrsvyQriYSwKBgGZoFcKqGfSM2bmY8QCC
4dErxKcP1n4R5eV9jDrYEf6P//giX5oZOCw/uxbYXlYeco/N5/vrGkoyEZxF1iXB
OAymMpxMOOB4VVK4wVzLmLu3vUJcTuFCEfTnivJRDM0V/pDxL/X4TKDj/Bbkq0bd
tO9bcpSoiTBllIOc29f37pll
-----END PRIVATE KEY-----`;

const testPub = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtdBcTv0bEth0lbVGeDZx
7+Qq0Cpkca8jEqKAJ1pBFkYghva7fd25LyP6fioe+g1Efel6Lqk+WiEc+BIbYf2w
yY/eTUkWho42GTZ1TZlm5aEQFgJewl25EoNoFRSro7mTE2EZ7ldIuvV83CHWfBJC
NONbeN7QfuP/5Ce1TMGgtIzFs1P8AYsLoKf27yTgZkcvRFMUUk7uaSfolk9DEM81
s6s//xSF6ijVYW/P7pBOgAQRri0tVCGLu/efvYigQThFACershRg9pIPc4nnp+wI
3YYMlTXnQm1tvT5NjRPrTmry5NYcEMfve8Jp5MBRD8iwShCuOdH0n6NbwVgscXFH
BwIDAQAB
-----END PUBLIC KEY-----`;

function signToken(
  claims: { user_id: string; role: string; tenant_id: string },
  permissions = ROLE_PERMISSIONS[claims.role] ?? [],
) {
  return jwt.sign(
    {
      ...claims,
      permissions,
      iss: 'test-issuer',
      aud: 'test-audience',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    testPriv,
    { algorithm: 'RS256' },
  );
}

describe('Permission denial (403)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
    config.LOCAL_JWT_MOCK = true;
    config.DEV_RSA_PUBLIC_KEY = Buffer.from(testPub).toString('base64');
    config.DEV_JWT_ISSUER = 'test-issuer';
    config.DEV_JWT_AUDIENCE = 'test-audience';
    config.AUTH_ISSUER = 'test-issuer';
    config.AUTH_AUDIENCE = 'test-audience';
  });

  it('AUDITOR cannot upload a document (POST /documents) → 403', async () => {
    const token = signToken({
      user_id: 'u1',
      role: 'AUDITOR',
      tenant_id: 't1',
    });
    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('EMPLOYEE cannot access audit log (GET /audit) → 403', async () => {
    const token = signToken({
      user_id: 'u2',
      role: 'EMPLOYEE',
      tenant_id: 't1',
    });
    const res = await request(app)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('APPROVER cannot create a folder (POST /folders) → 403', async () => {
    const token = signToken({
      user_id: 'u3',
      role: 'APPROVER',
      tenant_id: 't1',
    });
    const res = await request(app)
      .post('/api/v1/folders')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('EMPLOYEE cannot manage retention (POST /retention) → 403', async () => {
    const token = signToken({
      user_id: 'u4',
      role: 'EMPLOYEE',
      tenant_id: 't1',
    });
    const res = await request(app)
      .post('/api/v1/retention')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('EMPLOYEE cannot manage users (DELETE /users/:id) → 403', async () => {
    const token = signToken({
      user_id: 'u5',
      role: 'EMPLOYEE',
      tenant_id: 't1',
    });
    const res = await request(app)
      .delete('/api/v1/users/some-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('EMPLOYEE cannot read another user (GET /users/:id) → 403', async () => {
    const token = signToken({
      user_id: 'u6',
      role: 'EMPLOYEE',
      tenant_id: 't1',
    });
    const res = await request(app)
      .get('/api/v1/users/other-user-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('EMPLOYEE cannot manage legal hold (POST /legal-hold) → 403', async () => {
    const token = signToken({
      user_id: 'u7',
      role: 'EMPLOYEE',
      tenant_id: 't1',
    });
    const res = await request(app)
      .post('/api/v1/legal-hold')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  // 2026-09-16: EMPLOYEE (along with APPROVER/DEPT_MANAGER) was deliberately
  // granted SIGNING_MANAGE so ordinary staff can create their own e-signing
  // requests, not just RECORDS_OFFICER — see permissions.matrix.test.ts's
  // "can build form templates and manage signing requests" case. AUDITOR
  // remains a read-only oversight role by design, so it's the one this
  // negative case should assert against now.
  it('AUDITOR cannot manage signing (POST /signing/:id/sign) → 403', async () => {
    const token = signToken({
      user_id: 'u8',
      role: 'AUDITOR',
      tenant_id: 't1',
    });
    const res = await request(app)
      .post('/api/v1/signing/doc-id/sign')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('AUDITOR cannot access operations metrics (GET /metrics) → 403', async () => {
    const token = signToken({
      user_id: 'u9',
      role: 'AUDITOR',
      tenant_id: 't1',
    });
    const res = await request(app)
      .get('/api/v1/metrics')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a principal with no report permissions cannot list reports (GET /reports) → 403', async () => {
    const token = signToken(
      { user_id: 'u10', role: 'NOACCESS', tenant_id: 't1' },
      [PERMISSIONS.DOCUMENT_READ],
    );
    const res = await request(app)
      .get('/api/v1/reports')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a principal with no report permissions cannot run a report (GET /reports/:key) → 403', async () => {
    const token = signToken(
      { user_id: 'u11', role: 'NOACCESS', tenant_id: 't1' },
      [PERMISSIONS.DOCUMENT_READ],
    );
    const res = await request(app)
      .get('/api/v1/reports/document-inventory')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a principal with no letter-decision permission cannot decide a letter step → 403', async () => {
    const token = signToken(
      { user_id: 'u12', role: 'NOACCESS', tenant_id: 't1' },
      [PERMISSIONS.DOCUMENT_READ],
    );
    const res = await request(app)
      .post('/api/v1/letters/letter-id/steps/step-id/decision')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a principal with no step-reassignment permission cannot reassign a letter step → 403', async () => {
    const token = signToken(
      { user_id: 'u13', role: 'NOACCESS', tenant_id: 't1' },
      [PERMISSIONS.DOCUMENT_READ],
    );
    const res = await request(app)
      .post('/api/v1/letters/letter-id/steps/step-id/reassign')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
