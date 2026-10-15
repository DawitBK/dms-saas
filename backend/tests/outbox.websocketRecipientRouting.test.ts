/**
 * WEBSOCKET room-routing regression (found via live two-browser-context
 * testing, 2026-08-11): a WEBSOCKET outbox event with a departmentId routed
 * to that department's room ONLY. Approval-chain/signing events name a
 * specific assignee via recipientUserIds — and that assignee is not
 * guaranteed to be a member of the item's department (the whole point of the
 * named-person assignee picker). A second approver/signer outside the
 * document's department got no live update at all: My Work's counter didn't
 * move and an open document's Workflow tab didn't refresh, until a reload.
 *
 * FIX: processEvent's WEBSOCKET branch now unions the department room with a
 * `user_<id>` room per entry in recipientUserIds, instead of routing by
 * departmentId alone. These tests exercise processEvent directly (exported
 * for testing, same rationale as enqueueWebhookFanout) and assert on exactly
 * which rooms emitDomainEvent was called with.
 */

import { emitDomainEvent } from "../src/infrastructure/websocket/socket.js";

jest.mock("../src/infrastructure/database/index.js", () => ({
  OutboxEvent: { findOne: jest.fn() },
  WebhookSubscription: { findAll: jest.fn() },
  User: { findByPk: jest.fn() },
  Document: { findByPk: jest.fn() },
  DocumentVersion: { findByPk: jest.fn() },
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
  // No dedupe guard in these tests — hasDispatched always resolves false,
  // markDispatched is a no-op, so the routing branch runs deterministically.
  getCacheRedis: jest.fn(() => null),
}));

let processEvent: typeof import("../src/infrastructure/queue/outbox.js").processEvent;

beforeAll(async () => {
  const mod = await import("../src/infrastructure/queue/outbox.js");
  processEvent = mod.processEvent;
});

beforeEach(() => {
  jest.clearAllMocks();
});

function fakeEvent(payload: Record<string, unknown>, type = "APPROVAL_CHAIN.UPDATED") {
  return {
    id: "evt-1",
    type,
    channel: "WEBSOCKET",
    payload: JSON.stringify(payload),
    attempts: 1,
    maxAttempts: 3,
    processAfter: new Date(),
    update: jest.fn(),
  } as unknown as Parameters<typeof processEvent>[0];
}

describe("outbox processEvent — WEBSOCKET recipient routing", () => {
  it("reaches a named recipient's own room in addition to the department room", async () => {
    await processEvent(
      fakeEvent({
        itemType: "DOCUMENT",
        itemId: "doc-1",
        departmentId: "dept-1",
        tenantId: "t1",
        recipientUserIds: ["approver-1", "submitter-1"],
      }),
    );

    expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    const [rooms] = (emitDomainEvent as jest.Mock).mock.calls[0];
    expect(rooms).toEqual(
      expect.arrayContaining(["department_dept-1", "user_approver-1", "user_submitter-1"]),
    );
    expect(rooms).toHaveLength(3);
  });

  it("still reaches the recipient when the item has no department at all (e.g. a form template)", async () => {
    await processEvent(
      fakeEvent({
        itemType: "FORM_TEMPLATE",
        itemId: "tpl-1",
        departmentId: null,
        tenantId: "t1",
        recipientUserIds: ["approver-1"],
      }),
    );

    expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    const [rooms] = (emitDomainEvent as jest.Mock).mock.calls[0];
    expect(rooms).toEqual(["user_approver-1"]);
  });

  it("routes by department alone when no recipientUserIds are given (unaffected pre-existing behavior)", async () => {
    await processEvent(
      fakeEvent({
        documentId: "doc-2",
        departmentId: "dept-2",
        tenantId: "t1",
      }, "DOCUMENT.STATUS_CHANGED"),
    );

    expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    const [rooms] = (emitDomainEvent as jest.Mock).mock.calls[0];
    expect(rooms).toEqual(["department_dept-2"]);
  });

  it("falls back to the tenant admin room when neither a room, a department, nor recipients are given", async () => {
    await processEvent(fakeEvent({ tenantId: "t1" }));

    expect(emitDomainEvent).toHaveBeenCalledWith("admin_t1", "APPROVAL_CHAIN.UPDATED", expect.anything());
  });

  it("does not dispatch at all when there is nowhere to route the event", async () => {
    await processEvent(fakeEvent({}));
    expect(emitDomainEvent).not.toHaveBeenCalled();
  });
});
