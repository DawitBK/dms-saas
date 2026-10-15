export {};

// Regression coverage for the FormTemplate.approvedBy -> approver association
// fix (the "*By field never resolved to a name" batch): approvedBy was a bare
// user id with no association, so the templates list could never show who
// approved a template.

const mockFormTemplate = { findAndCountAll: jest.fn(), findOne: jest.fn(), create: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  FormTemplate: mockFormTemplate,
  FormInstance: {},
  Document: {},
  DocumentType: {},
  DocumentVersion: {},
  DocumentDek: {},
  Department: {},
  OutboxEvent: {},
  SignatureRequest: {},
  SignatureRecipient: {},
  User: {},
}));

jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: jest.fn().mockResolvedValue([]) }));
// Template scope is covered by forms.templateScope.test.ts; this file is about the approver association.
jest.mock("../src/modules/forms/formTemplateScope.js", () => ({
  ...jest.requireActual("../src/modules/forms/formTemplateScope.js"),
  canViewFormTemplate: jest.fn().mockResolvedValue(true),
  templateVisibilityWhere: jest.fn().mockResolvedValue(null),
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
}));

jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: jest.fn(),
}));

jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({
  scanBuffer: jest.fn(),
}));

// forms.service.ts imports filterDocsByDetailAcl straight from
// documents.service.js — mock the whole module at that boundary rather than
// pulling in documents.service.ts's own (much larger) dependency graph.
jest.mock("../src/modules/documents/documents.service.js", () => ({
  filterDocsByDetailAcl: jest.fn((_user: unknown, docs: unknown[]) => docs),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../src/config/env.js", () => ({
  config: {},
}));

let listFormTemplates: typeof import("../src/modules/forms/forms.service.js").listFormTemplates;
let getFormTemplate: typeof import("../src/modules/forms/forms.service.js").getFormTemplate;

beforeAll(async () => {
  const service = await import("../src/modules/forms/forms.service.js");
  listFormTemplates = service.listFormTemplates;
  getFormTemplate = service.getFormTemplate;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const user = { userId: "u-1", role: "SYSTEM_ADMIN", tenantId: "t1", roles: [], permissions: [] } as never;

describe("forms.service — approver association is requested", () => {
  it("listFormTemplates includes the approver association", async () => {
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await listFormTemplates(user);

    const passedInclude = mockFormTemplate.findAndCountAll.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "approver" })]);
  });

  it("getFormTemplate includes the approver association", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "tpl-1", status: "active" });
    await getFormTemplate("tpl-1", user);

    const passedInclude = mockFormTemplate.findOne.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "approver" })]);
  });

  it("getFormTemplate 404s when no template matches this tenant", async () => {
    mockFormTemplate.findOne.mockResolvedValue(null);
    await expect(getFormTemplate("missing", user)).rejects.toMatchObject({ code: "ERR-NOT-FOUND" });
  });
});
