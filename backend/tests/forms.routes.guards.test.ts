// HTTP-layer guards on the forms routes (2026-10-04 audit).
//
// Real router, stand-in authenticated user, faked services. "The service was (not)
// called" is the observable proof that the permission check ran first.
//
//   * POST /forms/templates/extract-from-image needs formtemplate:manage AND ai:use —
//     the AI egress permission added 2026-10-04 — and its upload is capped at the
//     15MB the extractor accepts, not the 100MB the other form uploads allow;
//   * every template-authoring route needs formtemplate:manage (an AUDITOR has
//     document:read but must not author);
//   * filing needs document:upload; a malformed dataJson is a 422, not a 500.

import express from "express";
import request from "supertest";

const mockService = {
  createFormTemplate: jest.fn().mockResolvedValue({ id: "ft" }),
  listFormTemplates: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  listFormTemplateCategories: jest.fn().mockResolvedValue([]),
  getFormTemplate: jest.fn().mockResolvedValue({ id: "ft" }),
  updateFormTemplateStatus: jest.fn().mockResolvedValue({ id: "ft" }),
  updateFormTemplateContent: jest.fn().mockResolvedValue({ id: "ft" }),
  createFormTemplateVersion: jest.fn().mockResolvedValue({ id: "ft2" }),
  createFormInstance: jest.fn().mockResolvedValue({ instance: { id: "fi" } }),
  getFormInstanceApprovalPrefill: jest.fn().mockResolvedValue({}),
  getFormInstance: jest.fn().mockResolvedValue({ id: "fi" }),
  listFormInstances: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  uploadFormBasePdf: jest.fn().mockResolvedValue("key"),
  previewFormTemplatePdf: jest.fn().mockResolvedValue(Buffer.from("%PDF")),
  getExampleCorpLetterheadObjectKey: jest.fn().mockResolvedValue("key"),
  assertOwnBasePdfKey: jest.fn(),
  validateTemplateSchemaJson: jest.fn(),
};
jest.mock("../src/modules/forms/forms.service.js", () => mockService);

const mockExtract = jest.fn().mockResolvedValue({ sections: [], fields: [] });
jest.mock("../src/modules/forms/formAiExtract.js", () => ({ extractFormFieldsFromImage: (...a: unknown[]) => mockExtract(...a) }));

jest.mock("../src/shared/auth.js", () => {
  const { AppError } = jest.requireActual("../src/core/AppError.js");
  return {
    requirePermission: (p: string) => (req: { user: { permissions: string[] } }, _res: unknown, next: (e?: unknown) => void) =>
      req.user.permissions.includes(p) ? next() : next(new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${p}`)),
  };
});

import { formsRoutes } from "../src/modules/forms/forms.routes.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/config/permissions.js";
import { AppError } from "../src/core/AppError.js";

function appFor(permissions: string[]) {
  const app = express();
  const use = app.use.bind(app) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  use(express.json());
  use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { userId: "actor", tenantId: "t1", role: "X", roles: ["X"], permissions };
    next();
  });
  use("/forms", formsRoutes);
  use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: "ERR-INTERNAL", message: String(error) } });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

const png = Buffer.from("89504e470d0a1a0a", "hex");

describe("POST /forms/templates/extract-from-image — AI egress guard", () => {
  const MANAGE = PERMISSIONS.FORM_TEMPLATE_MANAGE;

  it("needs ai:use even for someone who may author templates", async () => {
    const res = await request(appFor([MANAGE])).post("/forms/templates/extract-from-image").attach("file", png, "f.png");
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(PERMISSIONS.AI_USE);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("needs formtemplate:manage even for someone who may use AI", async () => {
    const res = await request(appFor([PERMISSIONS.AI_USE])).post("/forms/templates/extract-from-image").attach("file", png, "f.png");
    expect(res.status).toBe(403);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("an AUDITOR (ai:use, no authoring) is refused", async () => {
    const res = await request(appFor(ROLE_PERMISSIONS.AUDITOR!)).post("/forms/templates/extract-from-image").attach("file", png, "f.png");
    expect(res.status).toBe(403);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("with both permissions the request reaches the extractor, carrying the caller's identity", async () => {
    const res = await request(appFor([MANAGE, PERMISSIONS.AI_USE])).post("/forms/templates/extract-from-image").attach("file", png, "f.png");
    expect(res.status).toBe(200);
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockExtract.mock.calls[0][1]).toMatchObject({ userId: "actor", tenantId: "t1" });
  });

  it("caps the upload at the extractor's own 15MB (it used to buffer 100MB first)", async () => {
    const res = await request(appFor([MANAGE, PERMISSIONS.AI_USE]))
      .post("/forms/templates/extract-from-image")
      .attach("file", Buffer.alloc(16 * 1024 * 1024), "big.png");
    expect(res.status).toBe(413);
    expect(res.body.error.message).toContain("15MB");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("requires a file", async () => {
    const res = await request(appFor([MANAGE, PERMISSIONS.AI_USE])).post("/forms/templates/extract-from-image");
    expect(res.status).toBe(422);
  });
});

describe("template authoring routes need formtemplate:manage", () => {
  const readOnly = ROLE_PERMISSIONS.AUDITOR!.filter((p) => p !== PERMISSIONS.FORM_TEMPLATE_MANAGE);

  it.each([
    ["post", "/forms/templates"],
    ["patch", "/forms/templates/ft/status"],
    ["patch", "/forms/templates/ft/content"],
    ["post", "/forms/templates/ft/versions"],
    ["post", "/forms/templates/preview"],
    ["get", "/forms/templates/letterhead"],
    ["get", "/forms/templates/categories"],
    ["post", "/forms/templates/base-pdf"],
  ] as const)("%s %s is refused without it", async (method, url) => {
    const res = await request(appFor(readOnly))[method](url).send({});
    expect(res.status).toBe(403);
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  it("reading templates and instances needs only document:read", async () => {
    const app = appFor([PERMISSIONS.DOCUMENT_READ]);
    expect((await request(app).get("/forms/templates")).status).toBe(200);
    expect((await request(app).get("/forms/templates/ft")).status).toBe(200);
    expect((await request(app).get("/forms/instances")).status).toBe(200);
    expect((await request(app).get("/forms/instances/fi")).status).toBe(200);
  });

  it("a read-only user cannot reach the filing routes", async () => {
    const app = appFor([PERMISSIONS.DOCUMENT_READ]);
    expect((await request(app).get("/forms/templates/ft/approval-prefill")).status).toBe(403);
    expect((await request(app).post("/forms/instances").field("templateId", "ft")).status).toBe(403);
    expect(mockService.createFormInstance).not.toHaveBeenCalled();
  });
});

describe("POST /forms/instances", () => {
  const app = () => appFor([PERMISSIONS.DOCUMENT_UPLOAD]);

  it("answers a malformed dataJson with 422, not a 500", async () => {
    const res = await request(app()).post("/forms/instances").field("templateId", "ft").field("dataJson", "{not json");
    expect(res.status).toBe(422);
    expect(mockService.createFormInstance).not.toHaveBeenCalled();
  });

  it("refuses a dataJson that is not an object", async () => {
    const res = await request(app()).post("/forms/instances").field("templateId", "ft").field("dataJson", "[1,2]");
    expect(res.status).toBe(422);
    expect(mockService.createFormInstance).not.toHaveBeenCalled();
  });

  it("passes a valid submission to the service", async () => {
    const res = await request(app()).post("/forms/instances").field("templateId", "ft").field("dataJson", JSON.stringify({ a: "1" }));
    expect(res.status).toBe(201);
    expect(mockService.createFormInstance).toHaveBeenCalledWith("ft", { a: "1" }, expect.anything(), undefined, {}, undefined, { saveAsDraft: false });
  });

  it("bounds the number of uploaded parts", async () => {
    let req = request(app()).post("/forms/instances").field("templateId", "ft").field("dataJson", "{}");
    for (let i = 0; i < 26; i++) req = req.attach(`f${i}`, Buffer.from("x"), `f${i}.txt`);
    const res = await req;
    expect(res.status).toBe(400);
    expect(mockService.createFormInstance).not.toHaveBeenCalled();
  });
});

describe("POST /forms/templates/preview", () => {
  it("applies the same schema and base-file checks as a save", async () => {
    const res = await request(appFor([PERMISSIONS.FORM_TEMPLATE_MANAGE]))
      .post("/forms/templates/preview")
      .send({ schemaJson: [[]], basePdfObjectKey: "t2/forms/base-pdfs/x.pdf" });
    expect(res.status).toBe(200);
    expect(mockService.validateTemplateSchemaJson).toHaveBeenCalledWith([[]]);
    expect(mockService.assertOwnBasePdfKey).toHaveBeenCalledWith("t2/forms/base-pdfs/x.pdf", "t1");
  });

  it("surfaces a rejected base-file key as the 422 the service raises", async () => {
    mockService.assertOwnBasePdfKey.mockImplementationOnce(() => {
      throw new AppError(422, "ERR-FORM-BASE-PDF-INVALID", "no");
    });
    const res = await request(appFor([PERMISSIONS.FORM_TEMPLATE_MANAGE]))
      .post("/forms/templates/preview")
      .send({ schemaJson: [[]], basePdfObjectKey: "t2/x" });
    expect(res.status).toBe(422);
    expect(mockService.previewFormTemplatePdf).not.toHaveBeenCalled();
  });
});
