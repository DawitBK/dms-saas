// forceUnlock regression coverage (found via live browser testing, 2026-08-11):
// the everyday "Check Out" flow (documents.service.ts's checkoutDocument) and
// the doc_locks table forceUnlock originally checked are two independent
// mechanisms — nothing in the UI ever creates a doc_locks row, so Force Unlock
// always 409'd "Document is not locked" against the one state it's shown for.
// forceUnlock must release a DocumentCheckout row too, not only a DocLock row.

const mockDocLockFindOne = jest.fn();
const mockCheckoutFindOne = jest.fn();
const mockDocumentFindByPk = jest.fn();
const writeAuditLog = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/infrastructure/database/index.js", () => ({
  DocLock: { findOne: mockDocLockFindOne },
  DocumentCheckout: { findOne: mockCheckoutFindOne },
  Document: { findByPk: mockDocumentFindByPk },
  Tenant: { findOne: jest.fn() },
  // forceUnlock now also runs assertStatusPermission (statusPermissions.service.js),
  // which queries this model when its cache misses. Resolving to no rows means
  // "no status-conditioned rule configured" — the correct default, and what
  // every one of these tests implicitly assumes since none of them configure
  // a rule.
  DocumentStatusActionRole: { findAll: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog,
}));

jest.mock("../src/shared/documentGuards.js", () => ({
  requireDocumentAccess: jest.fn(),
  requireLegalHoldClear: jest.fn(),
  assertNotTerminalState: jest.fn(),
}));

jest.mock("../src/modules/notifications/notifications.service.js", () => ({
  fanOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/shared/workerTenantContext.js", () => ({
  withWorkerTenantContext: jest.fn((_tenantId: string, fn: () => unknown) => fn()),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { PERMISSIONS } from "../src/config/permissions.js";

let forceUnlock: typeof import("../src/modules/documents/lockService.js").forceUnlock;

beforeAll(async () => {
  const service = await import("../src/modules/documents/lockService.js");
  forceUnlock = service.forceUnlock;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDocumentFindByPk.mockResolvedValue({ id: "doc-1", tenantId: "t1" });
});

const adminUser = {
  userId: "admin-1",
  role: "SYSTEM_ADMIN",
  tenantId: "t1",
  permissions: [PERMISSIONS.ACL_BYPASS_ADMIN],
};

describe("lockService.forceUnlock", () => {
  it("releases a DocumentCheckout row when that's the only thing locking the document", async () => {
    mockDocLockFindOne.mockResolvedValue(null);
    const destroy = jest.fn().mockResolvedValue(undefined);
    mockCheckoutFindOne.mockResolvedValue({ checkedOutBy: "user-2", destroy });

    const result = await forceUnlock("doc-1", adminUser, "Owner is on leave, document needed urgently");

    expect(result.success).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionDetails: expect.objectContaining({
          originalOwner: "user-2",
          releasedDocLock: false,
          releasedCheckout: true,
        }),
      }),
    );
  });

  it("still releases a DocLock row when that's what's present (legacy path)", async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    mockDocLockFindOne.mockResolvedValue({ lockedBy: "user-3", destroy });
    mockCheckoutFindOne.mockResolvedValue(null);

    const result = await forceUnlock("doc-1", adminUser, "Stuck lock reported by user-3's manager");

    expect(result.success).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionDetails: expect.objectContaining({
          originalOwner: "user-3",
          releasedDocLock: true,
          releasedCheckout: false,
        }),
      }),
    );
  });

  it("releases both when both a DocLock and a DocumentCheckout exist", async () => {
    const lockDestroy = jest.fn().mockResolvedValue(undefined);
    const checkoutDestroy = jest.fn().mockResolvedValue(undefined);
    mockDocLockFindOne.mockResolvedValue({ lockedBy: "user-3", destroy: lockDestroy });
    mockCheckoutFindOne.mockResolvedValue({ checkedOutBy: "user-2", destroy: checkoutDestroy });

    const result = await forceUnlock("doc-1", adminUser, "Both records were stuck for this document");

    expect(result.success).toBe(true);
    expect(lockDestroy).toHaveBeenCalledTimes(1);
    expect(checkoutDestroy).toHaveBeenCalledTimes(1);
  });

  it("rejects with ERR-NOT-LOCKED when neither a DocLock nor a DocumentCheckout exists", async () => {
    mockDocLockFindOne.mockResolvedValue(null);
    mockCheckoutFindOne.mockResolvedValue(null);

    await expect(forceUnlock("doc-1", adminUser, "This document is not actually locked")).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-NOT-LOCKED",
    });
  });

  it("rejects without a sufficiently long reason", async () => {
    mockDocLockFindOne.mockResolvedValue({ lockedBy: "user-3", destroy: jest.fn() });
    mockCheckoutFindOne.mockResolvedValue(null);

    await expect(forceUnlock("doc-1", adminUser, "short")).rejects.toMatchObject({
      statusCode: 422,
      code: "ERR-REASON-REQUIRED",
    });
  });

  it("rejects a caller without department-manage or admin-bypass permission", async () => {
    const unprivileged = { userId: "u-4", role: "EMPLOYEE", tenantId: "t1", permissions: [] };
    await expect(forceUnlock("doc-1", unprivileged, "I would like to force unlock this document")).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
