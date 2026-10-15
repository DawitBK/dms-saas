/**
 * Webhook fan-out idempotency regression.
 *
 * BUG: enqueueWebhookFanout() was gated in processEvent() by
 * `event.attempts === 1`. `attempts` is incremented at CLAIM time (the
 * atomic UPDATE in processOutbox's claim query), before processEvent ever
 * runs — so a process crash/restart between claiming a row (attempts -> 1)
 * and reaching the fan-out call left the row's fan-out never having
 * happened. The stale-PROCESSING reclaim logic then picks the row back up
 * with attempts now 2+, and the `=== 1` check permanently (silently) skipped
 * webhook fan-out for that event, forever.
 *
 * FIX: enqueueWebhookFanout is now idempotent by construction — a
 * self-referencing `sourceEventId` column plus a partial unique index on it
 * (scoped to WEBHOOK rows, see migrations/20260711000001-outbox-webhook-
 * fanout-idempotency.sql) guarantees at most one WEBHOOK fan-out row per
 * source event, and the `attempts === 1` gate at the call site was removed
 * entirely (processEvent no longer looks at attempts before calling it).
 *
 * These tests exercise enqueueWebhookFanout directly (exported for testing)
 * against a small in-memory stand-in for the outbox_events table that
 * enforces the same uniqueness rule the real partial unique index enforces,
 * so a regression here would be caught the same way the live DB would catch
 * it.
 */

import { UniqueConstraintError } from "sequelize";

type FakeRow = {
  id: string;
  documentId: string | null;
  type: string;
  channel: string;
  payload: string;
  sourceEventId: string | null;
};

let store: FakeRow[] = [];
let idCounter = 0;

const mockOutboxEvent = {
  findOne: jest.fn(async (opts: { where?: Partial<FakeRow> }) => {
    const where = opts?.where ?? {};
    return (
      store.find(
        (r) =>
          (where.sourceEventId === undefined || r.sourceEventId === where.sourceEventId) &&
          (where.channel === undefined || r.channel === where.channel)
      ) ?? null
    );
  }),
  create: jest.fn(async (attrs: Omit<FakeRow, "id">) => {
    // Mirrors the real partial unique index:
    //   CREATE UNIQUE INDEX outbox_events_source_event_webhook_key
    //     ON outbox_events (source_event_id)
    //     WHERE channel = 'WEBHOOK' AND source_event_id IS NOT NULL;
    if (attrs.channel === "WEBHOOK" && attrs.sourceEventId != null) {
      const duplicate = store.some(
        (r) => r.channel === "WEBHOOK" && r.sourceEventId === attrs.sourceEventId
      );
      if (duplicate) {
        throw new UniqueConstraintError({
          message: "duplicate key value violates unique constraint \"outbox_events_source_event_webhook_key\"",
        });
      }
    }
    const row: FakeRow = { id: `fanout-${++idCounter}`, ...attrs };
    store.push(row);
    return row;
  }),
};

const mockDocument = {
  findByPk: jest.fn(),
};

jest.mock("../src/infrastructure/database/index.js", () => ({
  OutboxEvent: mockOutboxEvent,
  WebhookSubscription: { findAll: jest.fn() },
  User: { findByPk: jest.fn() },
  Document: mockDocument,
  WorkflowTask: { findByPk: jest.fn() },
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../src/config/env.js", () => ({
  config: {
    ENABLE_OUTBOX_POLLING: false,
    OUTBOX_POLL_INTERVAL_MS: 5000,
    // outbox.ts now imports documentCrypto.ts (for email-attachment fetches),
    // which transitively imports StorageAdapter.ts -> minio.ts — that module
    // constructs its MinIO client at import time, so these need to exist
    // even though this test never actually talks to MinIO.
    MINIO_ENDPOINT: "localhost",
    MINIO_PORT: 9000,
    MINIO_USE_SSL: false,
    MINIO_ACCESS_KEY: "test-access-key",
    MINIO_SECRET_KEY: "test-secret-key",
    MINIO_BUCKET_DOCUMENTS: "test-documents",
    MINIO_BUCKET_ARCHIVE: "test-archive",
    STORAGE_DRIVER: "local",
    NODE_ENV: "test",
  },
}));

jest.mock("../src/infrastructure/queue/queues.js", () => ({
  createQueue: jest.fn(() => null),
}));

jest.mock("../src/infrastructure/websocket/socket.js", () => ({
  emitDomainEvent: jest.fn(),
}));

jest.mock("../src/infrastructure/email/mailer.js", () => ({
  sendEmail: jest.fn(),
}));

jest.mock("../src/infrastructure/email/templates.js", () => ({
  renderEmail: jest.fn(),
}));

jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getRedis: jest.fn(() => null),
  getCacheRedis: jest.fn(() => null),
}));

let enqueueWebhookFanout: typeof import("../src/infrastructure/queue/outbox.js").enqueueWebhookFanout;

beforeAll(async () => {
  const mod = await import("../src/infrastructure/queue/outbox.js");
  enqueueWebhookFanout = mod.enqueueWebhookFanout;
});

beforeEach(() => {
  store = [];
  idCounter = 0;
  jest.clearAllMocks();
  mockDocument.findByPk.mockResolvedValue({ tenantId: "tenant-1" });
});

describe("enqueueWebhookFanout idempotency", () => {
  const sourceEvent = {
    id: "source-event-1",
    documentId: "doc-1",
    type: "DOCUMENT.CREATED",
    channel: "WEBSOCKET",
  } as any;

  const payload = { documentId: "doc-1", tenantId: "tenant-1" };

  it("creates exactly one WEBHOOK fan-out row for a single call", async () => {
    await enqueueWebhookFanout(sourceEvent, payload);

    const fanoutRows = store.filter((r) => r.channel === "WEBHOOK" && r.sourceEventId === sourceEvent.id);
    expect(fanoutRows).toHaveLength(1);
    expect(mockOutboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it("does not create a second row when the same source event fans out twice (crash-and-reclaim simulation)", async () => {
    // First call: the original processing attempt, which fans out successfully.
    await enqueueWebhookFanout(sourceEvent, payload);
    expect(mockOutboxEvent.create).toHaveBeenCalledTimes(1);

    // Second call: simulates the exact bug scenario — the process crashed
    // right after the first call above, the row got reclaimed by the
    // stale-PROCESSING logic with attempts now > 1, and processEvent calls
    // enqueueWebhookFanout again for the SAME source event. Pre-fix this
    // path was never reached at all (blocked by `attempts === 1`); post-fix
    // it's reached but must be a no-op because fan-out already happened.
    await enqueueWebhookFanout(sourceEvent, payload);

    const fanoutRows = store.filter((r) => r.channel === "WEBHOOK" && r.sourceEventId === sourceEvent.id);
    expect(fanoutRows).toHaveLength(1);
    // The existence check short-circuits before ever calling create() again.
    expect(mockOutboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it("still results in exactly one row when two calls race past the existence check concurrently", async () => {
    // Force both calls' existence checks to see "nothing yet" — the
    // scenario the partial unique index (not the existence check) has to
    // catch: two nearly-simultaneous fan-out attempts for the same source
    // event (e.g. two poller instances).
    mockOutboxEvent.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await Promise.all([
      enqueueWebhookFanout(sourceEvent, payload),
      enqueueWebhookFanout(sourceEvent, payload),
    ]);

    const fanoutRows = store.filter((r) => r.channel === "WEBHOOK" && r.sourceEventId === sourceEvent.id);
    expect(fanoutRows).toHaveLength(1);
    // Both calls attempted create(); the loser's UniqueConstraintError was
    // caught internally and swallowed (enqueueWebhookFanout never throws).
    expect(mockOutboxEvent.create).toHaveBeenCalledTimes(2);
  });

  it("does not fan out at all when no tenantId is resolvable, and a later retry with a resolvable tenant still succeeds exactly once", async () => {
    mockDocument.findByPk.mockResolvedValueOnce({ tenantId: null });

    await enqueueWebhookFanout(sourceEvent, { documentId: "doc-1" });
    expect(store.filter((r) => r.channel === "WEBHOOK")).toHaveLength(0);
    expect(mockOutboxEvent.create).not.toHaveBeenCalled();

    // A subsequent attempt (e.g. after the document gets a tenantId, or the
    // payload now carries one) resolves and fans out exactly once.
    await enqueueWebhookFanout(sourceEvent, payload);
    expect(store.filter((r) => r.channel === "WEBHOOK" && r.sourceEventId === sourceEvent.id)).toHaveLength(1);
  });
});
