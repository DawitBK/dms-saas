import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { config } from "../../config/env.js";
import { PERMISSIONS, userHasPermission } from "../../config/permissions.js";
import { getUserRevocationCutoff, verifyAccessToken } from "../../shared/auth.js";
import { logger } from "../../core/logger.js";
import { getCachedUserDepartments, cacheUserDepartments, loadUserDepartmentIds } from "../cache/userDeptCache.js";
import { getRedis } from "../cache/redis.js";
import { withWorkerTenantContext } from "../../shared/workerTenantContext.js";
import { socketConnections, socketHandshakeRejections } from "../metrics.js";

let io: Server | null = null;

type VerifiedToken = Awaited<ReturnType<typeof verifyAccessToken>>;

/** What io.use() hands the connection handler on a successful handshake. */
type SocketAuth = {
  userId: VerifiedToken["user_id"];
  role: VerifiedToken["role"];
  permissions: VerifiedToken["permissions"];
  tenantId: VerifiedToken["tenant_id"];
  exp: VerifiedToken["exp"];
};

/**
 * Socket.IO tuning. These are load and correctness settings, not cosmetics —
 * this pipeline is the PRIMARY freshness mechanism for the UI (the interval
 * polls in the frontend are socket-down fallbacks, see
 * frontend/state/realtime.store.ts), so a socket that silently stops carrying
 * events is a correctness problem, not a performance one.
 */
const SOCKET_OPTIONS = {
  // Heartbeat. Engine.IO's defaults (25s interval / 20s timeout) are fine
  // behind a proxy that does not idle-close, but stated explicitly because the
  // whole fallback design depends on a dead connection being DETECTED: an
  // undetected half-open socket reports itself connected, so the UI stops
  // polling and shows stale data indefinitely. Faster than the proxy's own
  // idle timeout is the rule.
  pingInterval: 25_000,
  pingTimeout: 20_000,
  // Clients only ever send a handshake and heartbeats — they never emit
  // application payloads over this socket (every write goes through the REST
  // API). 100KB is generous for that and caps a trivially cheap memory
  // amplification from an unauthenticated peer; the default is 1MB.
  maxHttpBufferSize: 100_000,
  // Drop a peer that opens a connection and never completes the handshake,
  // instead of holding the slot indefinitely.
  connectTimeout: 20_000,
  // WebSocket first, long-polling only as the fallback for a network that
  // cannot carry a WebSocket at all. The client sets the same order (see
  // frontend/providers/RealtimeBridge.tsx) — that is the side that actually
  // decides, this is the server declaring both are allowed.
  //
  // NOTE ON `path`: left at the default "/socket.io". In production DMS is
  // reached at `/dms/socket.io/` on the shared origin, but Apache REWRITES
  // that to `/socket.io/` before proxying to 7100 (see
  // apache/conf/extra/httpd-ssl.conf), so the app never sees the prefix. The
  // browser-side path is set from NEXT_PUBLIC_BASE_PATH — see SOCKET_PATH in
  // frontend/shared/lib/apiConfig.ts, which is where that went wrong.
  transports: ["websocket", "polling"] as ("websocket" | "polling")[],
} as const;

export type HandshakeResult =
  | { ok: true; auth: SocketAuth }
  | { ok: false; reason: "missing_token" | "invalid_token" | "revoked"; code: string };

/**
 * Decide whether a handshake may open a socket.
 *
 * Extracted from the `io.use()` adapter below so this — the part that holds
 * the actual security decisions — is unit-testable without a live server, a
 * real client, and an undeclared socket.io-client dependency in the backend.
 * The adapter does nothing but translate the result into next()/next(err) and
 * count the rejection.
 */
export async function authenticateHandshake(token: unknown): Promise<HandshakeResult> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token", code: "ERR-AUTH-REQUIRED" };
  }

  let payload: VerifiedToken;
  try {
    payload = await verifyAccessToken(token);
  } catch (error) {
    logger.debug({ error }, "socket handshake rejected: token verification failed");
    return { ok: false, reason: "invalid_token", code: "ERR-AUTH-INVALID" };
  }

  // Same revocation gate the HTTP path applies (R-04): a user whose
  // permissions were changed or whose sessions were revoked must not keep a
  // live event feed just because their socket predates the change. Without
  // this, a demoted user's socket kept streaming their old rooms until they
  // happened to reconnect.
  try {
    const cutoff = await getUserRevocationCutoff(payload.user_id);
    if (cutoff !== null && payload.iat <= cutoff) {
      return { ok: false, reason: "revoked", code: "ERR-AUTH-REVOKED" };
    }
  } catch (error) {
    // Deliberately fail OPEN here, unlike the HTTP path. A socket carries only
    // cache-invalidation hints — it is not an authorization boundary, and every
    // action the client then takes is re-authorized over HTTP, where the same
    // lookup failing does fail closed. Refusing handshakes during a
    // Redis/Postgres blip would take realtime down estate-wide and push every
    // client onto the fallback poll, which is precisely the load spike such a
    // blip least needs.
    logger.warn({ error, userId: payload.user_id }, "socket revocation check unavailable; allowing handshake");
  }

  return {
    ok: true,
    auth: {
      userId: payload.user_id,
      role: payload.role,
      permissions: payload.permissions,
      tenantId: payload.tenant_id,
      exp: payload.exp,
    },
  };
}

/**
 * The rooms a socket should join, given its verified handshake.
 *
 * Also extracted for testability: the admin room's tenant scoping is a
 * cross-tenant isolation boundary — it was once a single global "admin" room,
 * which leaked every other tenant's system events to a multi-tenant admin —
 * and that deserves a test that does not need a socket to run.
 */
export async function resolveSocketRooms(auth: SocketAuth): Promise<string[]> {
  let departmentIds = auth.tenantId ? await getCachedUserDepartments(auth.tenantId, auth.userId) : [];
  if (!departmentIds) {
    // FIX (2026-09-21, live mirror incident): a socket handshake runs outside
    // Express's tenantContext middleware, so there was never a transaction
    // with `SET LOCAL app.current_tenant` for this query to join — under real
    // RLS enforcement (the mirror/production DB role, unlike dev's superuser)
    // the RLS-protected join inside loadUserDepartmentIds() silently returned
    // zero rows every time, and that EMPTY list then got cached in Redis for
    // 300s under the same key every HTTP request reads
    // (shared/resolveACL.ts, letters/documents/folders/departments services).
    // One socket connection was enough to poison department-scoped reads
    // platform-wide for that user until the TTL expired — surfaced live as a
    // real letter, in the viewer's own department, reporting "Letter not
    // found". withWorkerTenantContext (shared/workerTenantContext.ts) is the
    // existing helper for exactly this "no HTTP request, but need the RLS
    // tenant GUC" situation — reuse it instead of querying bare.
    departmentIds = await withWorkerTenantContext(auth.tenantId, () => loadUserDepartmentIds(auth.tenantId, auth.userId));
    await cacheUserDepartments(auth.tenantId, auth.userId, departmentIds);
  }

  const rooms = [`user_${auth.userId}`, ...departmentIds.map((id) => `department_${id}`)];
  // FIX: was a single global "admin" room with no tenant in its name — a
  // system admin who belongs to more than one tenant received every OTHER
  // tenant's system-scoped events and cache-invalidation triggers too. Scope
  // it per tenant, matching every other room here.
  if (
    userHasPermission({ role: auth.role, permissions: auth.permissions }, PERMISSIONS.ACL_BYPASS_ADMIN) &&
    auth.tenantId
  ) {
    rooms.push(`admin_${auth.tenantId}`);
  }
  return rooms;
}

export function initializeSocket(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: config.CLIENT_URL, credentials: true },
    ...SOCKET_OPTIONS,
  });

  const pubClient = getRedis();
  if (pubClient) {
    const subClient = pubClient.duplicate();
    subClient.on("error", (error: unknown) => logger.warn({ error }, "socket redis adapter subscriber unavailable"));
    io.adapter(createAdapter(pubClient, subClient));
    // Both clients are lazyConnect (see cache/redis.ts), so each needs an
    // explicit connect() — but ONLY while still unconnected. createAdapter()
    // above subscribes on subClient straight away, and that command
    // auto-connects the lazy client; the explicit connect() then rejects with
    // "Redis is already connecting/connected". The guard was applied to
    // pubClient but not subClient, so in production every boot logged
    // "realtime is local-only" even though Redis was up and the adapter had in
    // fact attached — a real error and a false alarm are indistinguishable in
    // that log line. Same guard on both.
    const connectIfIdle = (client: { status: string; connect: () => Promise<unknown> }) =>
      client.status === "wait" ? client.connect() : Promise.resolve();
    Promise.all([connectIfIdle(pubClient), connectIfIdle(subClient)])
      .then(() => logger.info("socket.io redis adapter attached"))
      // `err`, not `error`: pino only auto-serializes a key literally named
      // `err`, so this used to log an empty {} with no message or stack.
      .catch((err) => logger.warn({ err }, "socket.io redis adapter could not connect; realtime is local-only"));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Handshake authentication.
  //
  // This was previously done INSIDE the "connection" handler, which meant a
  // socket was already fully established before its token was looked at — and
  // on any failure the handler just `return`ed or logged, leaving the
  // connection OPEN. So a peer with no token, an expired token, or a garbage
  // token got and kept a live socket: joined to no rooms, so it received
  // nothing, but still holding a file descriptor, a heartbeat timer and (on
  // the long-polling transport) a request slot, with no authentication and
  // nothing to bound how many it could open. Rejecting during `io.use()`
  // refuses the handshake outright and surfaces a real `connect_error` to the
  // client instead of a connection that looks fine and silently never works.
  // ───────────────────────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const result = await authenticateHandshake(socket.handshake.auth?.token);
    if (!result.ok) {
      socketHandshakeRejections.inc({ reason: result.reason });
      next(new Error(result.code));
      return;
    }
    socket.data.auth = result.auth;
    next();
  });

  io.on("connection", async (socket) => {
    const auth = socket.data.auth as SocketAuth | undefined;
    // io.use() above guarantees this, but a socket with no auth must never
    // reach the room joins below.
    if (!auth) {
      socket.disconnect(true);
      return;
    }

    socketConnections.inc();
    socket.on("disconnect", () => socketConnections.dec());

    // A socket outlives the access token that opened it. Without this it stayed
    // connected and subscribed indefinitely — hours after its token expired —
    // because authentication happened once, at connect, and never again. Cut it
    // at expiry and let the client reconnect with a fresh token (the frontend
    // rebuilds the socket whenever the access token changes, so this is a
    // no-op for a healthy session and a hard stop for an abandoned one).
    const msUntilExpiry = auth.exp * 1000 - Date.now();
    const expiryTimer = setTimeout(
      () => {
        logger.debug({ userId: auth.userId }, "socket access token expired; disconnecting");
        socket.disconnect(true);
      },
      Math.max(msUntilExpiry, 0),
    );
    // Never hold the event loop open on this timer during shutdown.
    expiryTimer.unref?.();
    socket.on("disconnect", () => clearTimeout(expiryTimer));

    try {
      // NOTE: this used to call `initModels()` and `connectDB()` here, per
      // connection. Both are bootstrap concerns that main.ts has already done
      // before the server listens, and doing them per socket was actively
      // harmful:
      //   - `connectDB()` issues `sequelize.authenticate()` — a DB round trip
      //     for every socket that connects, so a reconnect storm (a deploy, a
      //     proxy restart, a Redis blip) became a burst of pointless
      //     authentication queries on the pool that the same storm's HTTP
      //     traffic needs.
      //   - in production/mirror `connectDB()` additionally runs the RLS
      //     enforcement probe, which opens a TRANSACTION and runs two queries
      //     — per socket connection.
      //   - worst: both failure paths call `process.exit(1)`. A transient DB
      //     error during a socket handshake would kill the entire API process,
      //     taking every in-flight HTTP request with it. A boot-time guard is
      //     the right thing; running it on a hot path turned it into a remote
      //     kill switch.
      for (const room of await resolveSocketRooms(auth)) socket.join(room);
    } catch (error) {
      // Room joins failed, so this socket would receive nothing while still
      // reporting itself connected — which would stop the client's fallback
      // poll and leave the UI silently stale. Disconnect instead, so the
      // client either retries into a working socket or stays on the poll.
      logger.error({ error, userId: auth.userId }, "socket room subscription failed; disconnecting");
      socket.disconnect(true);
    }
  });

  return io;
}

export function emitDomainEvent(room: string | string[], type: string, payload: unknown) {
  io?.to(room).emit("domain_event", { type, payload, room });
}

/**
 * Drop every live socket belonging to a user.
 *
 * Called from `revokeAllUserSessions` (shared/auth.ts). The durable cutoff it
 * writes is what stops FUTURE handshakes and HTTP requests, but a socket that
 * is already open was authenticated once, at connect, and would otherwise keep
 * streaming that user's rooms until it happened to reconnect. With the Redis
 * adapter attached this reaches sockets on every API process, not just this
 * one; without it, only local sockets, which is also the only place sockets
 * exist in a single-process deployment.
 *
 * Best-effort by design: the cutoff is the authority, this is the immediate
 * effect. A failure here must never roll back the permission change that
 * prompted it.
 */
export async function disconnectUserSockets(userId: string): Promise<void> {
  if (!io) return;
  try {
    await io.in(`user_${userId}`).disconnectSockets(true);
  } catch (error) {
    logger.warn(
      { error, userId },
      "failed to disconnect live sockets for a revoked user; their durable cutoff still bars every new request and handshake",
    );
  }
}

export async function closeSocket() {
  if (!io) return;
  const current = io;
  io = null;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
