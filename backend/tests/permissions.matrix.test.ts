import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/config/permissions.js";

const ALL_ROLES = [
  "PLATFORM_ADMIN",
  "SYSTEM_ADMIN",
  "RECORDS_OFFICER",
  "DEPT_MANAGER",
  "APPROVER",
  "EMPLOYEE",
  "AUDITOR",
  "EXECUTIVE",
] as const;

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

describe("ROLE_PERMISSIONS matrix", () => {
  it("defines exactly eight system roles", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it("assigns only known permissions to each role", () => {
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  // SYSTEM_ADMIN deliberately excludes PLATFORM_ADMIN's own permission
  // (platform:admin) — that flag is cross-tenant/platform-operator scope,
  // not part of "administer my own tenant." See config/permissions.ts's
  // PLATFORM_ONLY_PERMISSIONS comment.
  it("SYSTEM_ADMIN holds every ordinary permission, but not platform:admin", () => {
    const ordinaryPermissions = ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.PLATFORM_ADMIN);
    expect(ROLE_PERMISSIONS.SYSTEM_ADMIN.sort()).toEqual([...ordinaryPermissions].sort());
    expect(ROLE_PERMISSIONS.SYSTEM_ADMIN).not.toContain(PERMISSIONS.PLATFORM_ADMIN);
  });

  it("PLATFORM_ADMIN holds every permission, including platform:admin", () => {
    expect(ROLE_PERMISSIONS.PLATFORM_ADMIN.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("AUDITOR cannot mutate documents or manage users", () => {
    const auditor = ROLE_PERMISSIONS.AUDITOR;
    expect(auditor).not.toContain(PERMISSIONS.DOCUMENT_UPLOAD);
    expect(auditor).not.toContain(PERMISSIONS.USER_MANAGE);
    expect(auditor).not.toContain(PERMISSIONS.ACL_MANAGE);
  });

  // Read-only means no create/update/delete/manage/approve grant of any kind,
  // apart from the audit-stage PASS/FLAG decision that is the auditor's job.
  it("AUDITOR holds no write or manage permission beyond the audit-stage decision", () => {
    const writeLike = /:(upload|archive|purge|checkout|manage|create|delete|approve|dispatch|register|review|submit|decide)$|^approval:|^version:manage$/;
    const offenders = ROLE_PERMISSIONS.AUDITOR.filter((p) => writeLike.test(p) && p !== PERMISSIONS.AUDIT_STAGE_DECIDE);
    expect(offenders).toEqual([]);
  });

  it("AUDITOR can read every module it oversees", () => {
    for (const p of [
      PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.FOLDER_READ, PERMISSIONS.DEPT_READ, PERMISSIONS.ORG_UNIT_READ,
      PERMISSIONS.DOCTYPE_READ, PERMISSIONS.WORKFLOW_READ, PERMISSIONS.RETENTION_READ, PERMISSIONS.LEGAL_HOLD_READ,
      PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.SIGNING_READ, PERMISSIONS.AUDIT_READ,
    ]) {
      expect(ROLE_PERMISSIONS.AUDITOR).toContain(p);
    }
  });

  // An executive sees everything on every module. It must not be able to
  // administer or destroy: that stays with SYSTEM_ADMIN / RECORDS_OFFICER.
  it("EXECUTIVE can see every module tenant-wide", () => {
    for (const p of [
      PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.FOLDER_READ, PERMISSIONS.SEARCH_SCOPE_ALL,
      PERMISSIONS.DEPT_READ, PERMISSIONS.ORG_UNIT_READ, PERMISSIONS.DOCTYPE_READ, PERMISSIONS.WORKFLOW_READ,
      PERMISSIONS.RETENTION_READ, PERMISSIONS.LEGAL_HOLD_READ, PERMISSIONS.AUDIT_READ, PERMISSIONS.OPERATIONS_READ,
      PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.SIGNING_READ,
    ]) {
      expect(ROLE_PERMISSIONS.EXECUTIVE).toContain(p);
    }
  });

  it("EXECUTIVE can act on what reaches them: approve, sign, decide, upload and fill forms", () => {
    for (const p of [
      PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE, PERMISSIONS.LETTER_CREATE,
      PERMISSIONS.WORKFLOW_APPROVE, PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE,
      PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.DOCUMENT_UPLOAD,
    ]) {
      expect(ROLE_PERMISSIONS.EXECUTIVE).toContain(p);
    }
  });

  it("EXECUTIVE cannot administer or destroy anything", () => {
    for (const p of [
      PERMISSIONS.USER_MANAGE, PERMISSIONS.ROLE_MANAGE, PERMISSIONS.ACL_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN,
      PERMISSIONS.TENANT_MANAGE, PERMISSIONS.ORG_UNIT_MANAGE, PERMISSIONS.DEPT_MANAGE, PERMISSIONS.DOCTYPE_MANAGE,
      PERMISSIONS.WORKFLOW_MANAGE, PERMISSIONS.RETENTION_MANAGE, PERMISSIONS.LEGAL_HOLD_MANAGE,
      PERMISSIONS.DOCUMENT_PURGE, PERMISSIONS.DOCUMENT_ARCHIVE, PERMISSIONS.FOLDER_DELETE,
      PERMISSIONS.OPERATIONS_MANAGE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.PLATFORM_ADMIN,
    ]) {
      expect(ROLE_PERMISSIONS.EXECUTIVE).not.toContain(p);
    }
  });

  // The oversight roles must be a superset of what an ordinary employee can do
  // for themselves, otherwise promoting someone to EXECUTIVE would take things
  // away (this is exactly how the old EXECUTIVE default was wrong).
  it("EXECUTIVE holds everything an EMPLOYEE holds", () => {
    const missing = ROLE_PERMISSIONS.EMPLOYEE.filter((p) => !ROLE_PERMISSIONS.EXECUTIVE.includes(p));
    expect(missing).toEqual([]);
  });

  it("EMPLOYEE can read folders and document types but not manage users", () => {
    const employee = ROLE_PERMISSIONS.EMPLOYEE;
    expect(employee).toContain(PERMISSIONS.FOLDER_READ);
    expect(employee).toContain(PERMISSIONS.DOCTYPE_READ);
    expect(employee).not.toContain(PERMISSIONS.USER_MANAGE);
  });

  // 2026-09-16: ordinary staff (not just RECORDS_OFFICER) can build form
  // templates and create their own e-signing requests — but form-template
  // authoring must NOT come bundled with the tenant's document-type
  // taxonomy (DOCTYPE_MANAGE), which is a separate, more admin-ish grant.
  it("EMPLOYEE, APPROVER and DEPT_MANAGER can build form templates and manage signing requests, but not the document-type taxonomy", () => {
    for (const role of ["EMPLOYEE", "APPROVER", "DEPT_MANAGER"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.FORM_TEMPLATE_MANAGE);
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.SIGNING_MANAGE);
      expect(ROLE_PERMISSIONS[role]).not.toContain(PERMISSIONS.DOCTYPE_MANAGE);
    }
  });
});

// Who may build the organisation (see Documentations/ROLE-SCOPE-MATRIX.md). The
// PERMISSION says a role may administer at all; WHERE is enforced by
// shared/orgScope.ts, which these tests do not cover — they pin the grants.
describe("organisation-building permissions by role", () => {
  const has = (role: string, p: string) => (ROLE_PERMISSIONS[role] ?? []).includes(p as never);

  it("only SYSTEM_ADMIN (and PLATFORM_ADMIN) can create organisation units", () => {
    for (const role of ALL_ROLES) {
      expect(has(role, PERMISSIONS.ORG_UNIT_MANAGE)).toBe(role === "SYSTEM_ADMIN" || role === "PLATFORM_ADMIN");
    }
  });

  it("DEPT_MANAGER can create sub-departments, folders and assign members, scoped to their own department", () => {
    for (const p of [PERMISSIONS.DEPT_MANAGE, PERMISSIONS.FOLDER_CREATE, PERMISSIONS.USER_MANAGE, PERMISSIONS.ROLE_READ]) {
      expect(ROLE_PERMISSIONS.DEPT_MANAGER).toContain(p);
    }
  });

  it("DEPT_MANAGER holds no organisation-level or governance permission", () => {
    for (const p of [
      PERMISSIONS.ORG_UNIT_MANAGE, PERMISSIONS.ROLE_MANAGE, PERMISSIONS.DOCTYPE_MANAGE, PERMISSIONS.WORKFLOW_MANAGE,
      PERMISSIONS.ACL_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.FOLDER_DELETE, PERMISSIONS.DOCUMENT_READ_ALL,
      PERMISSIONS.TENANT_MANAGE, PERMISSIONS.PLATFORM_ADMIN,
    ]) {
      expect(ROLE_PERMISSIONS.DEPT_MANAGER).not.toContain(p);
    }
  });

  it("only SYSTEM_ADMIN and RECORDS_OFFICER define document types and workflow templates", () => {
    for (const role of ALL_ROLES) {
      const expected = ["PLATFORM_ADMIN", "SYSTEM_ADMIN", "RECORDS_OFFICER"].includes(role);
      expect(has(role, PERMISSIONS.DOCTYPE_MANAGE)).toBe(expected);
      expect(has(role, PERMISSIONS.WORKFLOW_MANAGE)).toBe(expected);
    }
  });

  it("only the oversight roles read every document (document:read_all)", () => {
    for (const role of ALL_ROLES) {
      const expected = ["PLATFORM_ADMIN", "SYSTEM_ADMIN", "RECORDS_OFFICER", "AUDITOR", "EXECUTIVE"].includes(role);
      expect(has(role, PERMISSIONS.DOCUMENT_READ_ALL)).toBe(expected);
    }
  });

  it("nobody but SYSTEM_ADMIN/PLATFORM_ADMIN holds user:manage over the whole tenant's ACLs or tenant settings", () => {
    for (const role of ALL_ROLES) {
      const admin = role === "SYSTEM_ADMIN" || role === "PLATFORM_ADMIN";
      expect(has(role, PERMISSIONS.ACL_MANAGE)).toBe(admin);
      expect(has(role, PERMISSIONS.TENANT_MANAGE)).toBe(admin);
    }
  });
});
