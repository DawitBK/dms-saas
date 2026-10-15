// AI "build a form from a photo" — authorisation order and ledger (2026-10-04 audit).
//
// aiPolicy.service.ts is the one place that decides whether a request may reach the
// external provider (tenant consent flag, feature switch, quota). For form extraction
// the contract is:
//   1. consent + feature are verified BEFORE any bytes are looked at (mode 'verify':
//      refusals are recorded, nothing is debited);
//   2. a bad file (wrong type, too big, undecodable) is rejected WITHOUT using up one
//      of the user's daily AI requests;
//   3. the quota is debited immediately BEFORE the first call that leaves the building;
//   4. how the request ended (completed / failed) is written to the same ledger.
// Previously the single, debiting call came first, so every rejected upload cost a
// request and the ledger only ever showed "allowed".

const events: string[] = [];

const mockAuthorize = jest.fn(async (req: { mode?: string }) => {
  events.push(`authorize:${req.mode ?? "debit"}`);
  return {};
});
const mockRecord = jest.fn(async (r: { outcome: string }) => {
  events.push(`record:${r.outcome}`);
});
jest.mock("../src/modules/ai/aiPolicy.service.js", () => ({
  authorizeAiRequest: (...a: unknown[]) => (mockAuthorize as (...x: unknown[]) => unknown)(...a),
  recordAiUsage: (...a: unknown[]) => (mockRecord as (...x: unknown[]) => unknown)(...a),
}));

const mockScan = jest.fn(async () => {
  events.push("scan");
  return "clean";
});
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: (...a: unknown[]) => (mockScan as (...x: unknown[]) => unknown)(...a) }));

const mockSharp = jest.fn();
jest.mock("sharp", () => ({ __esModule: true, default: (...a: unknown[]) => mockSharp(...a) }));
jest.mock("../src/shared/pdfRasterize.js", () => ({ rasterizeFirstPdfPage: jest.fn() }));
jest.mock("../src/shared/ocr.js", () => ({ ocrImage: jest.fn() }));

const mockLlmExtract = jest.fn();
jest.mock("../src/modules/ai/llmClient.js", () => ({
  llmExtractStructured: (...a: unknown[]) => (mockLlmExtract as (...x: unknown[]) => unknown)(...a),
  llmChat: jest.fn(),
}));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { AppError } from "../src/core/AppError.js";

type Extract = typeof import("../src/modules/forms/formAiExtract.js").extractFormFieldsFromImage;
let extract: Extract;

beforeAll(async () => {
  ({ extractFormFieldsFromImage: extract } = await import("../src/modules/forms/formAiExtract.js"));
});

beforeEach(() => {
  events.length = 0;
  jest.clearAllMocks();
  // sharp(buffer).png().toBuffer() and the resize/png chain all resolve to a buffer.
  const chain: Record<string, unknown> = {};
  for (const m of ["png", "resize", "grayscale", "median", "normalize", "sharpen", "threshold"]) chain[m] = () => chain;
  chain.toBuffer = async () => Buffer.from("png");
  mockSharp.mockReturnValue(chain);
  mockLlmExtract.mockImplementation(async () => {
    events.push("llm");
    return { fields: [{ label: "Name", type: "text", required: true, layoutWidth: "full" }] };
  });
});

const user = { userId: "u-1", tenantId: "t1", role: "EMPLOYEE", roles: ["EMPLOYEE"], permissions: [] } as never;
const file = (over: Record<string, unknown> = {}) => ({
  buffer: Buffer.from("x"), mimetype: "image/png", originalname: "form.png", size: 1, ...over,
});

describe("extractFormFieldsFromImage — authorisation order", () => {
  it("verifies consent and the feature switch first, in verify mode (no quota debit)", async () => {
    await extract(file(), user);
    expect(mockAuthorize.mock.calls[0]![0]).toMatchObject({ tenantId: "t1", userId: "u-1", feature: "form_extraction", mode: "verify" });
  });

  it("a tenant that has not consented is refused before the file is scanned or decoded", async () => {
    mockAuthorize.mockRejectedValueOnce(new AppError(403, "ERR-AI-NOT-ENABLED", "off"));
    await expect(extract(file(), user)).rejects.toMatchObject({ code: "ERR-AI-NOT-ENABLED" });
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]); // no scan, no decode, no provider call
    expect(mockSharp).not.toHaveBeenCalled();
    expect(mockLlmExtract).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsupported type", { mimetype: "application/zip" }, "ERR-FORM-EXTRACT-TYPE"],
    ["an oversized file", { size: 16 * 1024 * 1024 }, "ERR-FORM-EXTRACT-TOO-LARGE"],
  ])("%s is rejected without debiting the user's quota or reaching the provider", async (_label, over, code) => {
    await expect(extract(file(over), user)).rejects.toMatchObject({ statusCode: 422, code });
    expect(mockAuthorize.mock.calls.map((c) => (c[0] as { mode?: string }).mode)).toEqual(["verify"]);
    expect(mockLlmExtract).not.toHaveBeenCalled();
  });

  it("an undecodable image is rejected without a debit", async () => {
    mockSharp.mockImplementation(() => {
      throw new Error("vipspng: libpng read error");
    });
    await expect(extract(file(), user)).rejects.toMatchObject({ code: "ERR-FORM-EXTRACT-UNREADABLE" });
    expect(mockAuthorize.mock.calls.map((c) => (c[0] as { mode?: string }).mode)).toEqual(["verify"]);
    expect(mockLlmExtract).not.toHaveBeenCalled();
  });

  it("debits the quota immediately before the provider is called, and records completion", async () => {
    const result = await extract(file(), user);
    expect(result.fields).toHaveLength(1);
    expect(events).toEqual(["authorize:verify", "scan", "authorize:debit", "llm", "record:completed"]);
    // The debiting call is the default mode (no `mode`), i.e. it counts against the quota.
    expect((mockAuthorize.mock.calls[1]![0] as { mode?: string }).mode).toBeUndefined();
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({ tenantId: "t1", userId: "u-1", feature: "form_extraction", outcome: "completed" });
  });

  it("a quota refusal at the debit step stops the request before the provider and is not recorded as a failure", async () => {
    mockAuthorize.mockImplementationOnce(async () => ({})); // verify passes
    mockAuthorize.mockRejectedValueOnce(new AppError(403, "ERR-AI-USER-LIMIT", "limit"));
    await expect(extract(file(), user)).rejects.toMatchObject({ code: "ERR-AI-USER-LIMIT" });
    expect(mockLlmExtract).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("records a provider failure in the ledger as 'failed'", async () => {
    mockLlmExtract.mockRejectedValue(new AppError(502, "ERR-AI-EXTRACTION-FAILED", "boom"));
    // The OCR fallback also fails here (no OCR text), which is the terminal error.
    const { ocrImage } = await import("../src/shared/ocr.js");
    (ocrImage as jest.Mock).mockResolvedValue("");
    await expect(extract(file(), user)).rejects.toMatchObject({ code: "ERR-FORM-EXTRACT-UNREADABLE" });
    expect(events).toContain("authorize:debit");
    expect(mockRecord.mock.calls.at(-1)![0]).toMatchObject({ outcome: "failed", feature: "form_extraction" });
  });
});
