import {
  runWithContext,
  getRequestSourceIp,
  getRequestTenantId,
  setRequestTenantId,
  sequelizeClsNamespace,
} from "../src/shared/requestContext.js";

// Regression cover for the 2026-09-03 audit finding: 172 of the 175
// writeAuditLog call sites never passed `sourceIp`, so audit_logs.source_ip
// was NULL for every event except two authz-denial paths and one folders
// route — "who did this, from where" was absent from the trail. The fix
// carries req.ip in the same AsyncLocalStorage context that already carries
// tenantId, and writeAuditLog defaults from it.
//
// The subtle part these tests pin is the CLS child frame: writeAuditLog often
// runs inside a MANAGED sequelize.transaction(), whose callback gets its own
// nested context (see sequelizeClsNamespace.run's doc comment). If the child
// frame didn't inherit sourceIp, every audit row written inside a managed
// transaction would silently go back to NULL — which is most of them.
describe("request context: sourceIp", () => {
  it("is readable anywhere inside the request's async context", async () => {
    await runWithContext("corr-1", "198.51.100.4", async () => {
      expect(getRequestSourceIp()).toBe("198.51.100.4");
      await Promise.resolve();
      // Still there after an await — the whole point of using ALS.
      expect(getRequestSourceIp()).toBe("198.51.100.4");
    });
  });

  it("is undefined outside any request context (worker writes stay NULL)", () => {
    expect(getRequestSourceIp()).toBeUndefined();
  });

  it("tolerates a request with no resolvable address", async () => {
    await runWithContext("corr-2", undefined, async () => {
      expect(getRequestSourceIp()).toBeUndefined();
    });
  });

  it("does not leak between two concurrent requests", async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithContext("a", "10.0.0.1", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`a=${getRequestSourceIp()}`);
      }),
      runWithContext("b", "10.0.0.2", async () => {
        seen.push(`b=${getRequestSourceIp()}`);
      }),
    ]);
    expect(seen.sort()).toEqual(["a=10.0.0.1", "b=10.0.0.2"]);
  });

  it("is inherited by the nested CLS frame a managed transaction runs in", () => {
    runWithContext("corr-3", "203.0.113.9", () => {
      setRequestTenantId("examplecorp");
      sequelizeClsNamespace.run(() => {
        // This is the frame writeAuditLog executes in when it is called from
        // inside sequelize.transaction(async (t) => ...).
        expect(getRequestSourceIp()).toBe("203.0.113.9");
        expect(getRequestTenantId()).toBe("examplecorp");
      });
      // …and the parent frame is intact afterwards.
      expect(getRequestSourceIp()).toBe("203.0.113.9");
    });
  });
});
