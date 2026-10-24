// F-06 follow-up (audit 2026-09-03): the realtime socket is the
// PRIMARY freshness mechanism for the UI — the frontend's interval polls are
// socket-down fallbacks — so its handshake is now on the authentication path
// proper, not a best-effort side channel.
//
// What it used to do: authenticate INSIDE the "connection" handler, after the
// socket was already established, and on any failure just `return` or log —
// leaving the connection OPEN. A peer with no token, a garbage token or an
// expired token got and kept a live socket. It received nothing (it joined no
// rooms), but it held a file descriptor, a heartbeat timer and, on the
// long-polling transport, a request slot — unauthenticated, with nothing
// bounding how many it could open.
//
// It also never re-checked anything: a socket authenticated once, at connect,
// and stayed subscribed for as long as it stayed open, so a user whose
// sessions had been revoked kept a working event feed until they happened to
// reconnect.

const mockVerifyAccessToken = jest.fn();
const mockGetUserRevocationCutoff = jest.fn();
const mockGetCachedUserDepartments = jest.fn();
const mockCacheUserDepartments = jest.fn();
const mockLoadUserDepartmentIds = jest.fn();

jest.mock("../src/shared/auth.js", () => ({
  verifyAccessToken: (...args: unknown[]) => mockVerifyAccessToken(...args),
  getUserRevocationCutoff: (...args: unknown[]) => mockGetUserRevocationCutoff(...args),
}));

jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: (...args: unknown[]) => mockGetCachedUserDepartments(...args),
  cacheUserDepartments: (...args: unknown[]) => mockCacheUserDepartments(...args),
  loadUserDepartmentIds: (...args: unknown[]) => mockLoadUserDepartmentIds(...args),
}));

jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getRedis: () => null,
  getCacheRedis: () => null,
}));

import { authenticateHandshake, resolveSocketRooms } from "../src/infrastructure/websocket/socket.js";
import { PERMISSIONS } from "../src/config/permissions.js";

const NOW_SEC = Math.floor(Date.now() / 1000);

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    role: "STAFF",
    permissions: [PERMISSIONS.DOCUMENT_READ],
    tenant_id: "test-tenant-1",
    iat: NOW_SEC,
    exp: NOW_SEC + 900,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserRevocationCutoff.mockResolvedValue(null);
  mockGetCachedUserDepartments.mockResolvedValue(null);
  mockLoadUserDepartmentIds.mockResolvedValue([]);
  mockCacheUserDepartments.mockResolvedValue(undefined);
});

describe("socket handshake authentication", () => {
  it("refuses a handshake with no token", async () => {
    const result = await authenticateHandshake(undefined);
    expect(result).toEqual({ ok: false, reason: "missing_token", code: "ERR-AUTH-REQUIRED" });
    // And must not have spent a token verification on it.
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it("refuses a handshake with an empty-string token", async () => {
    const result = await authenticateHandshake("");
    expect(result).toEqual({ ok: false, reason: "missing_token", code: "ERR-AUTH-REQUIRED" });
  });

  it("refuses a non-string token without calling the verifier", async () => {
    // socket.handshake.auth is client-controlled JSON, so the token can be any
    // shape at all. Passing an object straight into jwt.decode is how a
    // handshake turns into an unhandled type error.
    for (const token of [42, {}, [], true, null]) {
      const result = await authenticateHandshake(token);
      expect(result).toMatchObject({ ok: false, reason: "missing_token" });
    }
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it("refuses a handshake whose token fails verification", async () => {
    mockVerifyAccessToken.mockRejectedValue(new Error("invalid signature"));
    const result = await authenticateHandshake("garbage.token.here");
    expect(result).toEqual({ ok: false, reason: "invalid_token", code: "ERR-AUTH-INVALID" });
  });

  it("refuses a handshake whose token is expired", async () => {
    // verifyAccessToken enforces exp itself and throws; the point of this case
    // is that an expired token yields a REFUSAL rather than an open socket.
    mockVerifyAccessToken.mockRejectedValue(
      Object.assign(new Error("jwt expired"), { name: "TokenExpiredError" }),
    );
    const result = await authenticateHandshake("expired.token");
    expect(result).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("accepts a handshake with a valid token and carries the claims forward", async () => {
    mockVerifyAccessToken.mockResolvedValue(validPayload());
    const result = await authenticateHandshake("good.token");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.auth).toEqual({
      userId: "user-1",
      role: "STAFF",
      permissions: [PERMISSIONS.DOCUMENT_READ],
      tenantId: "test-tenant-1",
      // exp is carried so the connection handler can schedule the disconnect
      // that stops a socket outliving the token that opened it.
      exp: NOW_SEC + 900,
    });
  });

  it("refuses a token issued at or before the user's revocation cutoff", async () => {
    // R-04's durable cutoff must gate the socket too, not just HTTP. Without
    // this a demoted user's already-open socket kept streaming their old rooms.
    mockVerifyAccessToken.mockResolvedValue(validPayload({ iat: NOW_SEC - 10 }));
    mockGetUserRevocationCutoff.mockResolvedValue(NOW_SEC - 10); // iat === cutoff
    const result = await authenticateHandshake("revoked.token");
    expect(result).toEqual({ ok: false, reason: "revoked", code: "ERR-AUTH-REVOKED" });
  });

  it("accepts a token issued after the cutoff", async () => {
    // The re-login after a revocation must work, or a permission change locks
    // the user out of realtime permanently.
    mockVerifyAccessToken.mockResolvedValue(validPayload({ iat: NOW_SEC }));
    mockGetUserRevocationCutoff.mockResolvedValue(NOW_SEC - 60);
    const result = await authenticateHandshake("fresh.token");
    expect(result.ok).toBe(true);
  });

  it("allows the handshake when the revocation lookup itself fails", async () => {
    // Deliberately fails OPEN, unlike the HTTP path. A socket carries only
    // cache-invalidation hints and is not an authorization boundary; every
    // action taken afterwards is re-authorized over HTTP, where the same
    // lookup failing DOES fail closed. Refusing handshakes during a Redis or
    // Postgres blip would push the whole estate onto its fallback polls, which
    // is the load spike such a blip least needs.
    mockVerifyAccessToken.mockResolvedValue(validPayload());
    mockGetUserRevocationCutoff.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await authenticateHandshake("good.token");
    expect(result.ok).toBe(true);
  });

  it("checks revocation for the user named by the token, not by the client", async () => {
    mockVerifyAccessToken.mockResolvedValue(validPayload({ user_id: "user-42" }));
    await authenticateHandshake("good.token");
    expect(mockGetUserRevocationCutoff).toHaveBeenCalledWith("user-42");
  });
});

describe("socket room subscription", () => {
  const staffAuth = {
    userId: "user-1",
    role: "STAFF",
    permissions: [PERMISSIONS.DOCUMENT_READ],
    tenantId: "test-tenant-1",
    exp: NOW_SEC + 900,
  } as Parameters<typeof resolveSocketRooms>[0];

  it("always joins the user's own room", async () => {
    const rooms = await resolveSocketRooms(staffAuth);
    expect(rooms).toContain("user_user-1");
  });

  it("joins a room per department the user belongs to", async () => {
    mockGetCachedUserDepartments.mockResolvedValue(["dept-a", "dept-b"]);
    const rooms = await resolveSocketRooms(staffAuth);
    expect(rooms).toEqual(["user_user-1", "department_dept-a", "department_dept-b"]);
  });

  it("reads departments from the DB and caches them on a cache miss", async () => {
    mockGetCachedUserDepartments.mockResolvedValue(null);
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-c"]);
    const rooms = await resolveSocketRooms(staffAuth);
    expect(rooms).toContain("department_dept-c");
    expect(mockCacheUserDepartments).toHaveBeenCalledWith("test-tenant-1", "user-1", ["dept-c"]);
  });

  it("does not join an admin room without the bypass permission", async () => {
    const rooms = await resolveSocketRooms(staffAuth);
    expect(rooms.some((r) => r.startsWith("admin_"))).toBe(false);
  });

  it("scopes the admin room to the acting tenant", async () => {
    // This is a cross-tenant isolation boundary. It was once a single global
    // "admin" room, so an admin who belonged to more than one tenant received
    // every OTHER tenant's system-scoped events and cache invalidations.
    const rooms = await resolveSocketRooms({
      ...staffAuth,
      role: "SYSTEM_ADMIN",
      permissions: [PERMISSIONS.ACL_BYPASS_ADMIN],
    } as Parameters<typeof resolveSocketRooms>[0]);
    expect(rooms).toContain("admin_test-tenant-1");
    expect(rooms).not.toContain("admin");
  });

  it("joins no admin room when an admin has no tenant on the token", async () => {
    // A bare "admin_undefined" room would be a cross-tenant collection point.
    const rooms = await resolveSocketRooms({
      ...staffAuth,
      role: "SYSTEM_ADMIN",
      permissions: [PERMISSIONS.ACL_BYPASS_ADMIN],
      tenantId: undefined,
    } as unknown as Parameters<typeof resolveSocketRooms>[0]);
    expect(rooms.some((r) => r.startsWith("admin_"))).toBe(false);
  });
});
