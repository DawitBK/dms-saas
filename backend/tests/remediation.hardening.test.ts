/**
 * L8: regression coverage for the 2026-07-16 hardening pass. Each block pins
 * a specific fix so a future refactor can't silently reopen it:
 *  - C2: manual status-change allowlist (engine-only transitions unreachable by hand)
 *  - L12: letter lifecycle enforced through the state machine
 *  - M11/H6: the new email templates are actually registered and render
 */
import { AppError } from "../src/core/AppError.js";
import {
  MANUAL_TRANSITION_PERMISSIONS,
  requiredPermissionForManualTransition,
} from "../src/modules/documents/DocumentStateMachine.js";
import { assertTransition, canTransition } from "../src/modules/letters/LetterStateMachine.js";
import { renderEmail, TEMPLATED_EVENT_TYPES } from "../src/infrastructure/email/templates.js";
import { isBlockedIp, assertSafeWebhookUrl, safeWebhookRequest } from "../src/shared/ssrf.js";

describe("C2 — manual transition permission allowlist", () => {
  it("refuses approval-engine transitions on the manual endpoint entirely", () => {
    // The self-approval walk the fix exists to stop:
    expect(requiredPermissionForManualTransition("DRAFT", "IN_REVIEW")).toBeNull();
    expect(requiredPermissionForManualTransition("IN_REVIEW", "APPROVED")).toBeNull();
    // Subsystem-owned lifecycle steps:
    expect(requiredPermissionForManualTransition("APPROVED", "PENDING_SIGNATURE")).toBeNull();
    expect(requiredPermissionForManualTransition("PENDING_SIGNATURE", "SIGNED")).toBeNull();
    expect(requiredPermissionForManualTransition("APPROVED", "PENDING_AUDIT")).toBeNull();
    expect(requiredPermissionForManualTransition("DISPOSAL_PENDING", "DISPOSED")).toBeNull();
    expect(requiredPermissionForManualTransition("ARCHIVED", "LEGAL_HOLD")).toBeNull();
  });

  it("maps allowed manual transitions to real permissions", () => {
    expect(requiredPermissionForManualTransition("APPROVED", "ACTIVE")).toBe("document:archive");
    expect(requiredPermissionForManualTransition("ARCHIVED", "DISPOSAL_PENDING")).toBe("retention:manage");
    expect(requiredPermissionForManualTransition("ACTIVE", "SUPERSEDED")).toBe("version:manage");
    expect(requiredPermissionForManualTransition("DRAFT", "CANCELLED")).toBe("document:upload");
  });

  it("never grants a manual path with an upload-only permission beyond DRAFT housekeeping", () => {
    for (const [key, permission] of Object.entries(MANUAL_TRANSITION_PERMISSIONS)) {
      if (permission === "document:upload") {
        const [from] = key.split("->");
        expect(["DRAFT", "REJECTED"]).toContain(from);
      }
    }
  });
});

describe("L12 — letter lifecycle goes through the state machine", () => {
  it("allows the documented outgoing lifecycle", () => {
    expect(() => assertTransition("DRAFT", "IN_REVIEW")).not.toThrow();
    expect(() => assertTransition("IN_REVIEW", "APPROVED")).not.toThrow();
    expect(() => assertTransition("APPROVED", "DISPATCHED")).not.toThrow();
    expect(() => assertTransition("DISPATCHED", "ARCHIVED")).not.toThrow();
  });

  it("allows the incoming lifecycle used by resolveIncomingLetter/archiveLetter", () => {
    expect(() => assertTransition("RECEIVED", "RESPONDED")).not.toThrow();
    expect(() => assertTransition("RECEIVED", "CLOSED")).not.toThrow();
    expect(() => assertTransition("RESPONDED", "CLOSED")).not.toThrow();
    expect(() => assertTransition("RESPONDED", "ARCHIVED")).not.toThrow();
  });

  it("rejects jumps that skip review or resurrect terminal letters", () => {
    expect(() => assertTransition("DRAFT", "APPROVED")).toThrow(AppError);
    expect(() => assertTransition("ARCHIVED", "IN_REVIEW")).toThrow(AppError);
    expect(() => assertTransition("CANCELLED", "DRAFT")).toThrow(AppError);
    expect(canTransition("CLOSED", "RESPONDED")).toBe(false);
  });

  it("treats a same-state write as a no-op, not an error", () => {
    expect(() => assertTransition("RESPONDED", "RESPONDED")).not.toThrow();
  });
});

describe("M11/H6 — new outbox email templates are registered and render", () => {
  it("registers the trash/purge/SLA templates", () => {
    for (const type of ["TRASH.SCHEDULED_PURGE", "DOCUMENT.PURGED", "APPROVAL.SLA_BREACH"]) {
      expect(TEMPLATED_EVENT_TYPES).toContain(type);
    }
  });

  it("renders the scheduled-purge warning with the purge date", () => {
    const email = renderEmail("TRASH.SCHEDULED_PURGE", {
      documentName: "Q3 Budget.xlsx",
      documentId: "doc-1",
      purgeAfter: "2026-08-15T00:00:00.000Z",
      retentionDays: 30,
    });
    expect(email.subject).toContain("permanent deletion scheduled");
    expect(email.text).toContain("Q3 Budget.xlsx");
    expect(email.text).toContain("2026-08-15");
  });

  it("renders the certificate reference on the purge notice", () => {
    const email = renderEmail("DOCUMENT.PURGED", {
      documentName: "Old contract",
      certificateReference: "COD-2026-ABCD1234",
      disposalMethod: "CERTIFIED_DELETION",
    });
    expect(email.text).toContain("COD-2026-ABCD1234");
    expect(email.html).toContain("COD-2026-ABCD1234");
  });

  it("escapes HTML in payload values (no injection through document names)", () => {
    const email = renderEmail("DOCUMENT.PURGED", {
      documentName: '<script>alert(1)</script>',
      certificateReference: "COD-X",
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("falls back to a sendable generic email for unknown types", () => {
    const email = renderEmail("SOME.FUTURE_EVENT", { anything: "x" });
    expect(email.subject).toContain("SOME.FUTURE_EVENT");
    expect(email.html).toContain("<!doctype html>");
  });
});

describe("S19 — webhook SSRF address classifier (isBlockedIp)", () => {
  it("blocks loopback, private, link-local, CGNAT, unspecified and reserved v4", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.5.4", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks IPv6 loopback, link-local, unique-local and unspecified", () => {
    for (const ip of ["::1", "::", "fe80::1", "fe9a::1", "feb0::1", "fc00::1", "fd12:3456::1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 in BOTH dotted and hex form, plus NAT64", () => {
    // The gap the S19 hardening closed: ::ffff:7f00:1 == 127.0.0.1 slipped past
    // the old dotted-only regex.
    for (const ip of [
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("allows genuinely public v4 and v6 addresses (no false positives)", () => {
    for (const ip of [
      "8.8.8.8", "1.1.1.1", "93.184.216.34", "203.0.113.5",
      "172.32.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1",
      "2001:4860:4860::8888", "2606:4700:4700::1111", "2001:db8::1",
    ]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  it("rejects non-http(s) schemes and embedded credentials at registration", () => {
    expect(() => assertSafeWebhookUrl("ftp://example.com/hook")).toThrow(AppError);
    expect(() => assertSafeWebhookUrl("file:///etc/passwd")).toThrow(AppError);
    expect(() => assertSafeWebhookUrl("https://user:pass@example.com/hook")).toThrow(AppError);
    expect(() => assertSafeWebhookUrl("not-a-url")).toThrow(AppError);
  });

  it("rejects bracketed IPv6 literals for internal hosts at registration", () => {
    // Node keeps the brackets on URL hostnames; stripBrackets must run before
    // net.isIP or these fall through the literal check. Uses non-loopback
    // internal hosts so the assertion holds regardless of NODE_ENV (loopback is
    // deliberately exempt outside production for local integration tests).
    expect(() => assertSafeWebhookUrl("http://[fd00::1]/hook")).toThrow(AppError);
    expect(() => assertSafeWebhookUrl("http://[fc00::1]/hook")).toThrow(AppError);
    expect(() => assertSafeWebhookUrl("http://[::ffff:169.254.169.254]/hook")).toThrow(AppError);
    // hex-form IPv4-mapped metadata address, bracketed
    expect(() => assertSafeWebhookUrl("http://[::ffff:a9fe:a9fe]/hook")).toThrow(AppError);
  });

  it("accepts a well-formed public webhook URL", () => {
    expect(() => assertSafeWebhookUrl("https://hooks.example.com/edms")).not.toThrow();
  });

  it("safeWebhookRequest defends itself against a literal internal IP before connecting (S19 re-audit)", async () => {
    // The delivery client must not rely solely on registration-time validation:
    // a literal-IP host bypasses the connect-time DNS lookup, so safeWebhookRequest
    // validates the URL up front. A private 10.x literal is blocked in ALL envs
    // (only 127.0.0.1/::1 are env-gated), so this is deterministic in test env and
    // rejects synchronously — no socket is ever opened to the internal host.
    await expect(
      safeWebhookRequest("http://10.255.255.1/hook", { method: "POST", headers: {}, body: "{}", timeoutMs: 2000 }),
    ).rejects.toThrow(AppError);
  });
});
