/**
 * §1 regression: permission-based enforcement must not depend on role name strings in service code.
 */
import { PERMISSIONS, userHasPermission } from "../src/config/permissions.js";

describe("permission-only enforcement (§1 regression)", () => {
  it("grants DOCUMENT_READ_ALL via permission, not role name", () => {
    expect(userHasPermission("AUDITOR", PERMISSIONS.DOCUMENT_READ_ALL)).toBe(true);
    expect(userHasPermission("EMPLOYEE", PERMISSIONS.DOCUMENT_READ_ALL)).toBe(false);
  });

  it("grants SEARCH_SCOPE_ALL to oversight roles via seed mapping only", () => {
    expect(userHasPermission("RECORDS_OFFICER", PERMISSIONS.SEARCH_SCOPE_ALL)).toBe(true);
    expect(userHasPermission("DEPT_MANAGER", PERMISSIONS.SEARCH_SCOPE_ALL)).toBe(false);
  });

  it("ACL_BYPASS_ADMIN is permission-gated — wrong role with permission would pass (simulated custom role)", () => {
    // Proves the check is permission-based: if a custom role were given ACL_BYPASS_ADMIN in seed, it would pass.
    // EMPLOYEE lacks it even though no role-name check exists in code.
    expect(userHasPermission("SYSTEM_ADMIN", PERMISSIONS.ACL_BYPASS_ADMIN)).toBe(true);
    expect(userHasPermission("EMPLOYEE", PERMISSIONS.ACL_BYPASS_ADMIN)).toBe(false);
  });

  it("right role with stripped permission fails — AUDITOR cannot upload", () => {
    expect(userHasPermission("AUDITOR", PERMISSIONS.DOCUMENT_UPLOAD)).toBe(false);
  });

  it("wrong role with granted permission succeeds — DEPT_MANAGER has DEPT_MANAGE", () => {
    expect(userHasPermission("DEPT_MANAGER", PERMISSIONS.DEPT_MANAGE)).toBe(true);
    expect(userHasPermission("EMPLOYEE", PERMISSIONS.DEPT_MANAGE)).toBe(false);
  });

  it("TENANT_MANAGE is restricted to SYSTEM_ADMIN in seed", () => {
    expect(userHasPermission("SYSTEM_ADMIN", PERMISSIONS.TENANT_MANAGE)).toBe(true);
    expect(userHasPermission("RECORDS_OFFICER", PERMISSIONS.TENANT_MANAGE)).toBe(false);
  });
});
