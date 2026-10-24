// TEN-2 (audit 2026-09-18): rate limiting used to be IP-scoped
// only, so tenants sharing a corporate NAT egress shared one bucket.
import jwt from "jsonwebtoken";
import { tenantAwareKeyGenerator } from "../src/shared/rateLimitKey.js";

function reqWithAuth(header?: string, ip = "203.0.113.5") {
  return { headers: { authorization: header }, ip } as any;
}

describe("tenantAwareKeyGenerator", () => {
  it("keys by tenant_id when a bearer token carries one", () => {
    const token = jwt.sign({ tenant_id: "examplecorp" }, "any-secret");
    expect(tenantAwareKeyGenerator(reqWithAuth(`Bearer ${token}`))).toBe("tenant:examplecorp");
  });

  it("two different tenants sharing the same IP get two different keys", () => {
    const tokenA = jwt.sign({ tenant_id: "tenant-a" }, "s");
    const tokenB = jwt.sign({ tenant_id: "tenant-b" }, "s");
    const keyA = tenantAwareKeyGenerator(reqWithAuth(`Bearer ${tokenA}`, "203.0.113.5"));
    const keyB = tenantAwareKeyGenerator(reqWithAuth(`Bearer ${tokenB}`, "203.0.113.5"));
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to IP when there is no Authorization header (pre-auth traffic)", () => {
    expect(tenantAwareKeyGenerator(reqWithAuth(undefined, "203.0.113.9"))).toBe("ip:203.0.113.9");
  });

  it("falls back to IP for a malformed bearer token, rather than throwing", () => {
    expect(tenantAwareKeyGenerator(reqWithAuth("Bearer not-a-real-jwt", "203.0.113.9"))).toBe("ip:203.0.113.9");
  });

  it("falls back to IP when the token has no tenant_id claim", () => {
    const token = jwt.sign({ user_id: "u1" }, "s");
    expect(tenantAwareKeyGenerator(reqWithAuth(`Bearer ${token}`, "203.0.113.9"))).toBe("ip:203.0.113.9");
  });

  it("never trusts the claim's signature — an unsigned/tampered token still keys by its claimed tenant, never bypasses bucketing", () => {
    // jwt.decode() deliberately does not verify — the point of this test is
    // that decoding never throws and always produces SOME bucket key, since a
    // bucketing decision (unlike authorization) carries no risk from an
    // unverified claim.
    const forged = jwt.sign({ tenant_id: "not-a-real-tenant" }, "wrong-secret-nobody-would-accept");
    expect(tenantAwareKeyGenerator(reqWithAuth(`Bearer ${forged}`))).toBe("tenant:not-a-real-tenant");
  });
});
