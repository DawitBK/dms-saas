/**
 * Perf fix: when clamd is unreachable, scanBuffer() used to reattempt a full
 * connect (up to the clamscan lib's 60s default timeout) on EVERY upload.
 * These tests pin the fast-fail behavior: after a connection attempt fails
 * (at init, or mid-session when a previously-good connection's scanStream
 * call itself fails), subsequent scanBuffer calls within the cooldown window
 * must NOT reattempt connecting — they return "unscanned" immediately — and
 * a call after the cooldown elapses DOES attempt again.
 */
const mockInit = jest.fn();
const mockScanStream = jest.fn();
const mockNodeClamCtor = jest.fn().mockImplementation(() => ({ init: mockInit }));

jest.mock("clamscan", () => ({
  __esModule: true,
  default: mockNodeClamCtor,
}));
jest.mock("../src/config/env.js", () => ({
  config: { CLAMAV_ENABLED: true, CLAMAV_HOST: "localhost", CLAMAV_PORT: 3310 },
}));
jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type ScanBufferFn = typeof import("../src/infrastructure/antivirus/clamscan.js").scanBuffer;
let scanBuffer: ScanBufferFn;

async function freshImport() {
  jest.resetModules();
  ({ scanBuffer } = await import("../src/infrastructure/antivirus/clamscan.js"));
}

beforeEach(async () => {
  mockInit.mockReset();
  mockScanStream.mockReset();
  mockNodeClamCtor.mockClear();
  mockNodeClamCtor.mockImplementation(() => ({ init: mockInit }));
  jest.restoreAllMocks();
  await freshImport();
});

describe("scanBuffer fast-fail on a dead clamd", () => {
  it("returns clean on a successful scan without touching the failure path", async () => {
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });

    const result = await scanBuffer(Buffer.from("hello"));

    expect(result).toBe("clean");
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1);
  });

  it("does not reattempt connecting during the cooldown window after an init failure", async () => {
    mockInit.mockRejectedValue(new Error("ECONNREFUSED"));

    const first = await scanBuffer(Buffer.from("a"));
    const second = await scanBuffer(Buffer.from("b"));

    expect(first).toBe("unscanned");
    expect(second).toBe("unscanned");
    // Second call must skip straight to "unscanned" — no second connect attempt.
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1);
  });

  it("reattempts connecting once the cooldown window has elapsed", async () => {
    mockInit.mockRejectedValue(new Error("ECONNREFUSED"));
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);

    await scanBuffer(Buffer.from("a"));
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1);

    // Still within the 60s cooldown — no reattempt.
    nowSpy.mockReturnValue(1_000_000 + 30_000);
    await scanBuffer(Buffer.from("b"));
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1);

    // Past the cooldown — attempts again.
    nowSpy.mockReturnValue(1_000_000 + 60_001);
    await scanBuffer(Buffer.from("c"));
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(2);
  });

  it("drops the cached client and starts the cooldown when scanStream itself fails after a successful init", async () => {
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockRejectedValue(new Error("daemon connection reset"));
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(2_000_000);

    const first = await scanBuffer(Buffer.from("a"));
    expect(first).toBe("unscanned");
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1); // init succeeded, cached

    // A second scan within cooldown must not reinitialize (client was dropped,
    // but the cooldown still blocks a fresh connect attempt).
    nowSpy.mockReturnValue(2_000_000 + 10_000);
    const second = await scanBuffer(Buffer.from("b"));
    expect(second).toBe("unscanned");
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(1);

    // After cooldown, reconnects.
    nowSpy.mockReturnValue(2_000_000 + 60_001);
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
    const third = await scanBuffer(Buffer.from("c"));
    expect(third).toBe("clean");
    expect(mockNodeClamCtor).toHaveBeenCalledTimes(2);
  });

  it("caps the clamdscan connect timeout well below the library's 60s default", async () => {
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });

    await scanBuffer(Buffer.from("a"));

    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({ clamdscan: expect.objectContaining({ timeout: expect.any(Number) }) }),
    );
    const timeout = mockInit.mock.calls[0][0].clamdscan.timeout;
    expect(timeout).toBeLessThan(60_000);
  });
});

describe("CLAMAV_FAIL_CLOSED (opt-in): refuse the upload instead of accepting it unscanned", () => {
  async function failClosed() {
    const { config } = (await import("../src/config/env.js")) as unknown as { config: Record<string, unknown> };
    config.CLAMAV_FAIL_CLOSED = true;
  }

  it("refuses with 503 ERR-AV-UNAVAILABLE when clamd cannot be reached at all", async () => {
    await failClosed();
    mockInit.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(scanBuffer(Buffer.from("a"))).rejects.toMatchObject({ statusCode: 503, code: "ERR-AV-UNAVAILABLE" });
  });

  it("refuses with 503 when a previously good connection fails mid-scan", async () => {
    await failClosed();
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockRejectedValue(new Error("socket hang up"));
    await expect(scanBuffer(Buffer.from("a"))).rejects.toMatchObject({ statusCode: 503, code: "ERR-AV-UNAVAILABLE" });
  });

  it("still scans normally when clamd is healthy", async () => {
    await failClosed();
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
    await expect(scanBuffer(Buffer.from("fine"))).resolves.toBe("clean");
  });

  it("the default (switch off) still accepts the upload as unscanned", async () => {
    mockInit.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(scanBuffer(Buffer.from("a"))).resolves.toBe("unscanned");
  });
});
