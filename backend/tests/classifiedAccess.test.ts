// The pure decision behind the classified-document rule (shared/classifiedAccess.ts), owner decision 2026-10-10.
jest.mock("../src/infrastructure/database/sequelize.js", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("../src/infrastructure/database/models/index.js", () => ({ AclEntry: { findAll: jest.fn() } }));

import {
  classifiedVerdict,
  holdsDepartmentManage,
  isClassified,
  isDeliberateDocumentGrant,
} from "../src/shared/classifiedAccess.js";
import { PERMISSIONS } from "../src/config/permissions.js";

const base = {
  classification: "CONFIDENTIAL" as string,
  ownerId: "owner",
  userId: "someone",
  documentDepartmentId: "dept-1",
  memberDepartmentIds: ["dept-1"] as string[],
  isDepartmentHead: false,
  hasDeliberateGrant: false,
  letterBacked: false,
};

describe("isClassified", () => {
  it("is true only for CONFIDENTIAL and RESTRICTED", () => {
    expect(isClassified("CONFIDENTIAL")).toBe(true);
    expect(isClassified("RESTRICTED")).toBe(true);
    expect(isClassified("INTERNAL")).toBe(false);
    expect(isClassified("PUBLIC")).toBe(false);
    expect(isClassified(null)).toBe(false);
    expect(isClassified(undefined)).toBe(false);
  });
});

describe("classifiedVerdict", () => {
  it("a plain department member is shut out of a CONFIDENTIAL document", () => {
    expect(classifiedVerdict(base)).toBe("closed");
  });
  it("and out of a RESTRICTED one", () => {
    expect(classifiedVerdict({ ...base, classification: "RESTRICTED" })).toBe("closed");
  });
  it("the owner is let in", () => {
    expect(classifiedVerdict({ ...base, userId: "owner" })).toBe("open");
  });
  it("a deliberate per-document grant lets someone in, even from another department", () => {
    expect(classifiedVerdict({ ...base, hasDeliberateGrant: true, memberDepartmentIds: [] })).toBe("open");
  });
  it("the head of the document's own department reads a CONFIDENTIAL document", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true })).toBe("head");
  });
  it("but not a RESTRICTED one", () => {
    expect(classifiedVerdict({ ...base, classification: "RESTRICTED", isDepartmentHead: true })).toBe("closed");
  });
  it("the head of a DIFFERENT department does not", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true, memberDepartmentIds: ["dept-2"] })).toBe("closed");
  });
  it("a head who is not a direct member does not (parent departments do not reach sub-departments)", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true, memberDepartmentIds: [] })).toBe("closed");
  });
  it("the head rule never applies to a letter's documents", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true, letterBacked: true })).toBe("closed");
  });
  it("a document with no department has no head", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true, documentDepartmentId: null })).toBe("closed");
  });
  it("accepts a Set of memberships as well as an array", () => {
    expect(classifiedVerdict({ ...base, isDepartmentHead: true, memberDepartmentIds: new Set(["dept-1"]) })).toBe("head");
  });
});

describe("isDeliberateDocumentGrant", () => {
  const user = { principalType: "user", effect: "ALLOW" };
  it("a manual grant counts", () => expect(isDeliberateDocumentGrant({ ...user, origin: null })).toBe(true));
  it("the automatic department snapshot does not", () => expect(isDeliberateDocumentGrant({ ...user, origin: "DEPT_SNAPSHOT" })).toBe(false));
  it("an expired grant does not", () => expect(isDeliberateDocumentGrant({ ...user, origin: null, expiresAt: new Date(Date.now() - 1000) })).toBe(false));
  it("a future expiry still counts", () => expect(isDeliberateDocumentGrant({ ...user, origin: null, expiresAt: new Date(Date.now() + 60_000) })).toBe(true));
  it("a DENY is not a grant", () => expect(isDeliberateDocumentGrant({ principalType: "user", effect: "DENY", origin: null })).toBe(false));
  it("a role grant is not a per-person grant", () => expect(isDeliberateDocumentGrant({ principalType: "role", effect: "ALLOW", origin: null })).toBe(false));
});

describe("holdsDepartmentManage", () => {
  it("reads the session's permission set when given", () => {
    expect(holdsDepartmentManage({ userPermissions: [PERMISSIONS.DEPT_MANAGE] })).toBe(true);
    expect(holdsDepartmentManage({ userPermissions: [PERMISSIONS.DOCUMENT_READ] })).toBe(false);
  });
  it("falls back to the role's default permissions", () => {
    expect(holdsDepartmentManage({ userRole: "DEPT_MANAGER" })).toBe(true);
    expect(holdsDepartmentManage({ userRole: "EMPLOYEE" })).toBe(false);
  });
});
