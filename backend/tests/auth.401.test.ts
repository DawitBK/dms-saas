import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { config } from "../src/config/env.js";

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

// Actually, I'll just use a very short valid RSA key for the test if possible, 
// but since I'm in a restricted environment, I'll mock the verification logic if I have to.
// However, the goal is to test the middleware.

describe("Auth 401 Gates (S1-04)", () => {
  let app: any;

  beforeAll(() => {
    app = createApp();
    // Configure env for testing
    config.LOCAL_JWT_MOCK = true;
    config.DEV_RSA_PUBLIC_KEY = Buffer.from(testPub).toString("base64");
    config.DEV_JWT_ISSUER = "test-issuer";
    config.DEV_JWT_AUDIENCE = "test-audience";
    config.AUTH_ISSUER = "test-issuer";
    config.AUTH_AUDIENCE = "test-audience";
  });

  it("returns 401 when no JWT is provided", async () => {
    const res = await request(app).get("/api/v1/documents");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ERR-AUTH-REQUIRED");
  });

  it("returns 401 when JWT is expired", async () => {
    const token = jwt.sign({ 
      user_id: "123", role: "EMPLOYEE", tenant_id: "ten-1",
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) - 3600 
    }, testPriv, { algorithm: "RS256" });

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${token}`);
    
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ERR-AUTH-EXPIRED");
  });

  it("returns 401 when JWT is tampered", async () => {
    const token = jwt.sign({ 
      user_id: "123", role: "EMPLOYEE", tenant_id: "ten-1",
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) + 3600 
    }, testPriv, { algorithm: "RS256" });

    const tamperedToken = token.substring(0, token.length - 5) + "abcde";

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${tamperedToken}`);
    
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ERR-AUTH-INVALID");
  });

  it("returns 401 when user_id claim is missing", async () => {
    const token = jwt.sign({ 
      role: "EMPLOYEE", tenant_id: "ten-1",
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) + 3600 
    }, testPriv, { algorithm: "RS256" });

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${token}`);
    
    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain("user_id");
  });

  it("returns 401 when role claim is missing", async () => {
    const token = jwt.sign({ 
      user_id: "123", tenant_id: "ten-1",
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) + 3600 
    }, testPriv, { algorithm: "RS256" });

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${token}`);
    
    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain("role");
  });

  it("returns 401 when tenant_id claim is missing", async () => {
    const token = jwt.sign({
      user_id: "123", role: "EMPLOYEE",
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) + 3600
    }, testPriv, { algorithm: "RS256" });

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toContain("tenant_id");
  });

  // Regression: a pre-role token (issued by loginMock/selectTenant when the
  // user holds more than one role) carries a valid tenant_id — role
  // selection happens after tenant is resolved — so it passes every
  // required-claims check above and must be rejected explicitly, the same
  // way mfa_pending tokens are, or it would silently fall through to "compute
  // permissions from the DB" and become a full bearer credential for the
  // union of every role the user holds without ever completing role
  // selection.
  it("returns 401 when token carries role_selection_required", async () => {
    const token = jwt.sign({
      user_id: "123", role: "EMPLOYEE", tenant_id: "ten-1",
      role_selection_required: true,
      available_roles: ["EMPLOYEE", "DEPT_MANAGER"],
      iss: "test-issuer", aud: "test-audience",
      exp: Math.floor(Date.now() / 1000) + 300,
    }, testPriv, { algorithm: "RS256" });

    const res = await request(app)
      .get("/api/v1/documents")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ERR-ROLE-SELECTION-REQUIRED");
  });
});
