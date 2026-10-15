// Guards the part of the self-diagnosing ERR-DEPT-INVALID that is reachable
// by an unvalidated client: the submitted code is echoed into a response body
// and a log line, and POST /signing/uploads reads it straight off req.body
// with no zod schema at all (esigning.routes.ts). So the sanitizer — not the
// caller — is what keeps an arbitrary value from steering either one.
import { sanitizeCodeForDisplay } from "../src/shared/departmentCodeError.js";

describe("sanitizeCodeForDisplay", () => {
  it("passes an ordinary code through unchanged", () => {
    expect(sanitizeCodeForDisplay("IT")).toBe("IT");
  });

  it("preserves the difference that makes a rejection diagnosable", () => {
    // The whole point: "IT " and "it" must not print as "IT".
    expect(sanitizeCodeForDisplay("IT ")).toBe("IT ");
    expect(sanitizeCodeForDisplay("it")).toBe("it");
  });

  it("strips control characters so a code cannot forge a log line", () => {
    expect(sanitizeCodeForDisplay("IT\n2026-01-01 FAKE LOG LINE")).toBe("IT2026-01-01 FAKE LOG LINE");
    expect(sanitizeCodeForDisplay("A\u0000B\u007fC")).toBe("ABC");
  });

  it("truncates a long code and says so, rather than looking short and wrong", () => {
    const result = sanitizeCodeForDisplay("X".repeat(500));
    expect(result).toMatch(/^X{32}… \(truncated, 500 chars\)$/);
  });

  it("reports a non-string instead of throwing on .length", () => {
    // POST /signing/uploads applies no schema, so req.body.departmentCode can
    // arrive as an object or an array from a JSON client.
    expect(sanitizeCodeForDisplay(undefined)).toBe("(not a string)");
    expect(sanitizeCodeForDisplay(42)).toBe("(not a string)");
    expect(sanitizeCodeForDisplay({ code: "IT" })).toBe("(not a string)");
  });

  it("distinguishes an empty code from a missing one", () => {
    expect(sanitizeCodeForDisplay("")).toBe("(empty)");
    expect(sanitizeCodeForDisplay("\u0000")).toBe("(empty)");
  });
});
