/**
 * ScanWorker: a finished scan may release a document from SCAN_PENDING (to DRAFT) and nothing else.
 * It used to also flip DRAFT/QUARANTINED documents to ACTIVE, so a >100 MB new version of a DRAFT
 * document published it the moment the scan finished, skipping the approval chain.
 */
let processor: (job: { data: Record<string, string> }) => Promise<void>;

jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation((_name: string, fn: typeof processor) => {
    processor = fn;
    return { on: jest.fn() };
  }),
  Job: class {},
}));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("../src/infrastructure/cache/redis.js", () => ({ getRedis: jest.fn().mockReturnValue({}) }));
const mockScan = jest.fn();
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: (...a: unknown[]) => mockScan(...a) }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: jest.fn() }));
const mockDocUpdate = jest.fn().mockResolvedValue([1]);
jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: { update: (...a: unknown[]) => mockDocUpdate(...a) },
  DocumentVersion: { update: jest.fn().mockResolvedValue([1]) },
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ fetchAndDecrypt: jest.fn().mockResolvedValue(Buffer.from("x")) }));
jest.mock("../src/shared/workerTenantContext.js", () => ({ withWorkerTenantContext: (_t: string, fn: () => Promise<unknown>) => fn() }));
jest.mock("../src/infrastructure/queue/queues.js", () => ({ attachErrorLogger: jest.fn(), reportJobFailure: jest.fn() }));

import { createScanWorker } from "../src/infrastructure/queue/workers/ScanWorker.js";

const job = { data: { documentId: "d1", versionId: "v1", storageKey: "k", tenantId: "t1", userId: "u1", userRole: "EMPLOYEE" } };

beforeEach(() => {
  jest.clearAllMocks();
  createScanWorker();
});

describe("ScanWorker status promotion", () => {
  it.each(["clean", "unscanned"])("a %s scan only moves SCAN_PENDING to DRAFT", async (result) => {
    mockScan.mockResolvedValue(result);
    await processor(job);
    expect(mockDocUpdate).toHaveBeenCalledTimes(1);
    const [patch, opts] = mockDocUpdate.mock.calls[0];
    expect(patch).toEqual({ status: "DRAFT" });
    expect(opts.where).toEqual({ id: "d1", status: "SCAN_PENDING" });
  });

  it("never writes ACTIVE", async () => {
    mockScan.mockResolvedValue("clean");
    await processor(job);
    expect(mockDocUpdate.mock.calls.some(([patch]) => (patch as { status?: string }).status === "ACTIVE")).toBe(false);
  });
});
