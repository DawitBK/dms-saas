import { AUDIT_EVENTS } from "../src/modules/audit/auditEvents.js";

describe("Audit Event Catalog", () => {
  it("should have all required event types", () => {
    const requiredEvents = [
      "AUTH_LOGIN",
      "AUTH_LOGOUT",
      "AUTHN_FAILURE",
      "AUTHZ_ROLE_DENIED",
      "AUTHZ_ACL_DENIED",
      "AUTHZ_ACL_NO_ENTRY",
      "DOCUMENT_CREATED",
      "DOCUMENT_UPDATED",
      "DOCUMENT_DOWNLOADED",
      "DOCUMENT_TRASHED",
      "DOCUMENT_RESTORED",
      "DOCUMENT_ROLLED_BACK",
      "LOCK_ACQUIRED",
      "LOCK_RELEASED",
      "LOCK_AUTO_RELEASED",
      "LOCK_FORCE_RELEASED",
      "LOCK_EXPIRY_WARNING",
      "RETENTION_APPLIED",
      "COLD_STORAGE_MOVED",
      "COLD_RESTORE_TRIGGERED",
      "DISPOSAL_AUTHORIZED",
      "DISPOSAL_REJECTED",
      "PURGE_STAGED",
      "PURGE_EXECUTED",
      "LEGAL_HOLD_PLACED",
      "LEGAL_HOLD_RELEASED",
      "LEGAL_HOLD_ACTIVE",
      "VIRUS_DETECTED",
      "MIME_REJECTED",
      "QUOTA_EXCEEDED",
      "AUDIT_CHAIN_VERIFIED",
      "AUDIT_CHAIN_BROKEN",
      "WORKFLOW_DEFINITION_CREATED",
      "WORKFLOW_INSTANCE_STARTED",
      "WORKFLOW_TASK_DECIDED",
      "WORKFLOW_INSTANCE_COMPLETED",
      "WEBHOOK_DELIVERED",
      "WEBHOOK_FAILED",
      "DOCUMENT_SIGNED",
      "HSM_UNAVAILABLE",
      "KEY_ROTATION_COMPLETE",
    ];

    for (const event of requiredEvents) {
      expect(AUDIT_EVENTS).toHaveProperty(event);
    }
  });
});
