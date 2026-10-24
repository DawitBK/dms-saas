import express from "express";
import request from "supertest";

// Regression cover for the 2026-09-03 audit finding: app.ts never called
// app.set('trust proxy', ...), so with Express's default of false, `req.ip`
// was the Apache proxy's own loopback address for EVERY user in production
// (7100 is loopback-only and Apache is the sole entry point —
// pre-deploy check C5). Three things keyed off that one collapsed value:
// the /api/v1/auth 20-req/min and /api 800-req/min IP limiters (an
// organisation-wide budget, i.e. an outage at real concurrency),
// audit_logs.source_ip, and the AUTHN_FAILURE audit sampler's per-source
// bucket.
//
// These assert the SETTING's semantics against Express itself rather than
// booting the whole app: what has to hold is (a) an X-Forwarded-For from the
// loopback hop is honoured, and (b) the same header from a non-loopback peer
// is ignored, so a client can never assert its own address.
describe("trust proxy semantics (config.TRUST_PROXY)", () => {
  function appWith(trust: unknown) {
    const app = express();
    app.set("trust proxy", trust);
    app.get("/whoami", (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  it("with the default 'loopback', honours X-Forwarded-For from the loopback hop", async () => {
    // supertest connects over loopback, which is exactly the Apache hop in
    // production, so the forwarded address is the one that must win.
    const res = await request(appWith("loopback"))
      .get("/whoami")
      .set("X-Forwarded-For", "10.20.30.40");
    expect(res.body.ip).toBe("10.20.30.40");
  });

  it("takes the right-most UNTRUSTED hop, so a client cannot prepend its own", async () => {
    // The security-relevant nuance of `loopback` over a hop count. Express
    // walks X-Forwarded-For from the RIGHT and stops at the first entry that
    // is not itself a trusted address, so with the single Apache hop the
    // value that wins is the one Apache appended — the socket peer it
    // actually saw. A client that sends its own `X-Forwarded-For: 10.20.30.40`
    // just gets it prepended to the real address by Apache, and is ignored.
    const res = await request(appWith("loopback"))
      .get("/whoami")
      .set("X-Forwarded-For", "10.20.30.40, 172.16.0.1");
    expect(res.body.ip).toBe("172.16.0.1");
  });

  it("still reports the peer when no proxy header is present", async () => {
    const res = await request(appWith("loopback")).get("/whoami");
    expect(res.body.ip).toMatch(/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/);
  });

  it("IGNORES a spoofed X-Forwarded-For when the peer is not trusted", async () => {
    // '203.0.113.7' as the trust list means only that address's hops count;
    // a loopback peer is untrusted, so its header must not move req.ip. This
    // is the property that makes 'loopback' safe to enable at all — widening
    // TRUST_PROXY to `true` would break it and hand every per-IP limit to the
    // caller.
    const res = await request(appWith("203.0.113.7"))
      .get("/whoami")
      .set("X-Forwarded-For", "10.20.30.40");
    expect(res.body.ip).not.toBe("10.20.30.40");
  });

  it("with the setting off entirely, the header is ignored (the old behaviour)", async () => {
    const res = await request(appWith(false))
      .get("/whoami")
      .set("X-Forwarded-For", "10.20.30.40");
    expect(res.body.ip).not.toBe("10.20.30.40");
  });
});

// The parsing in app.ts turns the env string into the value Express wants.
// Kept in lockstep with that block: "false" must disable, a bare number must
// be a HOP COUNT (Express reads the string "1" as a literal IP address, which
// would silently trust nothing), a comma list must become an array, and
// anything else — notably the `loopback` default — must pass through.
describe("TRUST_PROXY string parsing", () => {
  function parse(raw: string): boolean | number | string | string[] {
    const trustProxy = raw.trim();
    if (trustProxy === "false") return false;
    if (/^\d+$/.test(trustProxy)) return Number(trustProxy);
    if (trustProxy.includes(",")) {
      return trustProxy.split(",").map((v) => v.trim()).filter(Boolean);
    }
    return trustProxy;
  }

  it("passes 'loopback' (the default) through unchanged", () => {
    expect(parse("loopback")).toBe("loopback");
  });

  it("maps 'false' to the boolean, not the string", () => {
    expect(parse("false")).toBe(false);
  });

  it("maps a bare number to a hop count, not to an address", () => {
    expect(parse("1")).toBe(1);
    expect(parse("2")).toBe(2);
  });

  it("maps a comma-separated list to an array of trimmed entries", () => {
    expect(parse("127.0.0.1, 10.0.0.0/8")).toEqual(["127.0.0.1", "10.0.0.0/8"]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parse("  loopback  ")).toBe("loopback");
  });
});
