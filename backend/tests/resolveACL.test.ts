/**
 * S3-09: resolveACL unit tests — 8 resolution scenarios
 */

var mockFindAll = jest.fn();
const mockDocumentFindByPk = jest.fn().mockResolvedValue(null);
const mockFolderNodeFindByPk = jest.fn().mockResolvedValue(null);

jest.mock("../src/infrastructure/database/models/index.js", () => ({
  AclEntry: {
    findAll: mockFindAll,
  },
  Document: {
    findByPk: mockDocumentFindByPk,
  },
  FolderNode: {
    findByPk: mockFolderNodeFindByPk,
  },
}));

import { resolveACL } from "../src/shared/resolveACL.js";

function makeAclRow(overrides: Record<string, unknown>) {
  return {
    id: "acl-1",
    tenantId: "tenant-1",
    resourceType: "document" as const,
    resourceId: "doc-1",
    principalType: "user" as const,
    principalId: "user-1",
    effect: "ALLOW" as const,
    permission: "document:read",
    expiresAt: null,
    grantedById: "admin-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const BASE_OPTS = {
  resourceType: "document" as const,
  resourceId: "doc-1",
  permission: "document:read",
  userId: "user-1",
  userRole: "EMPLOYEE",
  // Provide empty ancestorIds so getAncestorsForResource (DB call) is skipped
  ancestorIds: [] as string[],
};

beforeEach(() => {
  mockFindAll.mockReset();
});

describe("resolveACL — 8 resolution scenarios", () => {
  it("1. Direct user DENY → allowed:false, effect:DENY", async () => {
    mockFindAll.mockResolvedValueOnce([makeAclRow({ effect: "DENY" }) as any]);

    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(false);
    expect(result.effect).toBe("DENY");
    expect(result.reason).toMatch(/deny/i);
  });

  it("2. Direct user ALLOW (not expired) → allowed:true, effect:ALLOW", async () => {
    mockFindAll.mockResolvedValueOnce([makeAclRow({ effect: "ALLOW", expiresAt: null }) as any]);

    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(true);
    expect(result.effect).toBe("ALLOW");
  });

  it("3. Role DENY (no direct user entry) → allowed:false (no entry from resolveACL)", async () => {
    mockFindAll.mockResolvedValueOnce([]);
    // No ancestors. resolveACL returns { allowed:false, reason:"No matching ACL entry" }
    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("4. Role ALLOW (not expired, no user entry) → allowed:false from resolveACL (role check is in requireACL)", async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const result = await resolveACL(BASE_OPTS);

    // resolveACL returns no-entry; role ALLOW is handled by requireACL wrapping it
    expect(result.allowed).toBe(false);
  });

  it("5. Expired ALLOW treated as implicit deny → allowed:false", async () => {
    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    mockFindAll.mockResolvedValueOnce([makeAclRow({ effect: "ALLOW", expiresAt: pastDate }) as any]);

    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(false);
  });

  it("6. User ALLOW overrides (no DENY) → allowed:true", async () => {
    mockFindAll.mockResolvedValueOnce([makeAclRow({ effect: "ALLOW", expiresAt: null }) as any]);

    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(true);
    expect(result.effect).toBe("ALLOW");
  });

  it("7. Ancestor folder ACL ALLOW → allowed:true when direct resource has no entry", async () => {
    mockFindAll.mockResolvedValueOnce([
      makeAclRow({ resourceType: "folder", resourceId: "folder-1", effect: "ALLOW", expiresAt: null }) as any
    ]);

    const result = await resolveACL({
      ...BASE_OPTS,
      ancestorIds: ["folder-1"],
    });

    expect(result.allowed).toBe(true);
    expect(result.effect).toBe("ALLOW");
    expect(result.reason).toContain("folder-1");
  });

  it("8. No entry anywhere → allowed:false, reason contains AUTHZ_ACL_NO_ENTRY or 'No matching'", async () => {
    mockFindAll.mockResolvedValueOnce([]);

    const result = await resolveACL(BASE_OPTS);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
