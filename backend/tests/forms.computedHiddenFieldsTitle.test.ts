// Regression coverage for three forms/letters-adjacent fixes that landed
// back-to-back on 2026-08-28 and share the same generateFormPdf() pipeline
// (forms.service.ts): computed fields (57e54e9), the document-title stamp
// (c7eab79), and the hidden-conditional-field PDF data leak (840e7b3). Each
// commit's own message flagged the interaction with the others — this test
// exercises all three together through previewFormTemplatePdf(), the same
// no-DB entry point the template builder's live preview uses, mirroring
// tests/letters.reassignCancel.test.ts's mocking style.

const mockGenerate = jest.fn().mockResolvedValue(new Uint8Array(Buffer.from('%PDF-1.4 mock')));
jest.mock('@pdfme/generator', () => ({ generate: (...args: unknown[]) => mockGenerate(...args) }));

jest.mock("../src/infrastructure/database/index.js", () => ({
  FormTemplate: {},
  FormInstance: {},
  Document: {},
  DocumentType: {},
  DocumentVersion: {},
  DocumentDek: {},
  Department: {},
  OutboxEvent: {},
  SignatureRequest: {},
  SignatureRecipient: {},
}));

jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: jest.fn().mockResolvedValue([]) }));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
  fetchAndDecrypt: jest.fn(),
}));

// forms.service.ts imports getStorageAdapter() at module scope, which
// transitively constructs a real Minio Client from env config — not used by
// previewFormTemplatePdf() with no basePdfObjectKey, but the import alone
// throws under jest's env (no MINIO_ENDPOINT) without this mock.
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: jest.fn(),
}));

jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({
  scanBuffer: jest.fn(),
}));

jest.mock("../src/modules/documents/documents.service.js", () => ({
  filterDocsByDetailAcl: jest.fn(),
  grantDefaultDocumentAcl: jest.fn(),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

jest.mock("../src/modules/retention/retentionEngine.js", () => ({
  applyRetention: jest.fn(),
}));

jest.mock("../src/shared/resolveACL.js", () => ({
  assertACLAllow: jest.fn(),
}));

jest.mock("../src/config/env.js", () => ({
  config: { MINIO_BUCKET_DOCUMENTS: "bucket" },
}));

import type { previewFormTemplatePdf as PreviewFn } from "../src/modules/forms/forms.service.js";

let previewFormTemplatePdf: typeof PreviewFn;

beforeAll(async () => {
  const service = await import("../src/modules/forms/forms.service.js");
  previewFormTemplatePdf = service.previewFormTemplatePdf;
});

beforeEach(() => {
  mockGenerate.mockClear();
});

function lastGenerateArgs() {
  const call = mockGenerate.mock.calls.at(-1);
  if (!call) throw new Error("generate() was never called");
  return call[0] as { template: { schemas: unknown[][] }; inputs: [Record<string, string>] };
}

describe("forms.service — computed fields + hidden-field stripping + title stamp (interaction)", () => {
  it("computes a dateDiffDays field from its two date inputs instead of leaving the generic '42' sample", async () => {
    const schemaJson = [
      [
        { name: "date_from", type: "date", title: "From", position: { x: 20, y: 20 }, width: 80, height: 10 },
        { name: "date_to", type: "date", title: "To", position: { x: 110, y: 20 }, width: 80, height: 10 },
        {
          name: "no_of_days", type: "number", title: "No of days", position: { x: 20, y: 40 }, width: 80, height: 10,
          computed: { type: "dateDiffDays", fromField: "date_from", toField: "date_to", inclusive: true },
        },
      ],
    ];

    await previewFormTemplatePdf({ schemaJson, name: "Leave Request Format" });

    const { inputs } = lastGenerateArgs();
    // Sample dates are identical placeholders for every date field, so an
    // inclusive same-day diff is exactly 1 — the code's own comment notes
    // this is a known cosmetic preview limit, but it must never fall back to
    // sampleValueForField's generic number placeholder ('42'), which is
    // exactly the class of bug (an untrusted/uncomputed "No of days") this
    // feature closed.
    expect(inputs[0].no_of_days).toBe("1");
    expect(inputs[0].no_of_days).not.toBe("42");
  });

  it("strips a hidden conditional field's value from the printed PDF instead of leaking it", async () => {
    const schemaJson = [
      [
        {
          name: "category", type: "select", title: "Category", options: ["General", "Confidential"],
          position: { x: 20, y: 20 }, width: 80, height: 10,
        },
        {
          // Only shown when category === 'Confidential'; the select's sample
          // value is always options[0] ('General'), so this field is hidden
          // for the preview's own generated sample data — the exact scenario
          // the bug report described ("sample data fills every field
          // unconditionally regardless of visibility").
          name: "confidential_note", type: "text", title: "Confidential note",
          position: { x: 20, y: 40 }, width: 170, height: 10,
          conditionalOn: { field: "category", operator: "equals", value: "Confidential" },
        },
      ],
    ];

    await previewFormTemplatePdf({ schemaJson, name: "Disclosure Form" });

    const { inputs } = lastGenerateArgs();
    expect(inputs[0].confidential_note).toBe("");
  });

  it("still applies a computed field's value even when it is also conditionally hidden, then strips it (order-dependent per the fix's own doc comment)", async () => {
    const schemaJson = [
      [
        { name: "date_from", type: "date", title: "From", position: { x: 20, y: 20 }, width: 80, height: 10 },
        { name: "date_to", type: "date", title: "To", position: { x: 110, y: 20 }, width: 80, height: 10 },
        {
          name: "toggle", type: "select", title: "Show days?", options: ["No", "Yes"],
          position: { x: 20, y: 30 }, width: 80, height: 10,
        },
        {
          name: "no_of_days", type: "number", title: "No of days", position: { x: 20, y: 40 }, width: 80, height: 10,
          computed: { type: "dateDiffDays", fromField: "date_from", toField: "date_to", inclusive: true },
          conditionalOn: { field: "toggle", operator: "equals", value: "Yes" },
        },
      ],
    ];

    await previewFormTemplatePdf({ schemaJson, name: "Leave Request Format" });

    const { inputs } = lastGenerateArgs();
    // toggle's sample value is options[0] = 'No', so the condition is unmet —
    // stripHiddenFieldValues must win even though applyComputedFields ran
    // first and populated a real '1'.
    expect(inputs[0].no_of_days).toBe("");
  });

  it("stamps the template name as a page-1 title schema entry, distinct from every field", async () => {
    const schemaJson = [
      [{ name: "full_name", type: "text", title: "Full name", position: { x: 20, y: 20 }, width: 170, height: 10 }],
    ];

    await previewFormTemplatePdf({ schemaJson, name: "Leave Request Format" });

    const { template } = lastGenerateArgs();
    const page1Names = (template.schemas[0] as Array<{ name: string }>).map((entry) => entry.name);
    expect(page1Names).toContain("__form_title");

    const titleEntry = (template.schemas[0] as Array<{ name: string; content?: string }>).find(
      (e) => e.name === "__form_title",
    );
    expect(titleEntry?.content).toBe("Leave Request Format");
  });
});
