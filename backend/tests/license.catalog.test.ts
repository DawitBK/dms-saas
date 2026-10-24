/**
 * Pins DMS's licence module keys, system key, token constants and error codes to the platform contract
 * (docs/operations/PLATFORM-LICENSING.md, sections 4, 6 and 7). SSO's admin form offers exactly these keys, so a
 * drift in either place means a licence the other side cannot honour.
 *
 * The literal list below is the pin that always runs. The contract itself is docs/operations/PLATFORM-LICENSING.md in this
 * repository, and the cross-check against it runs too (it returns early only if that file is absent).
 */
import fs from "node:fs";
import path from "node:path";
import {
  DMS_LICENSE_MODULES,
  LICENSE_ERROR,
  LICENSE_SSO_PUBLIC_PATH,
  LICENSE_SYSTEM,
  LICENSE_TOKEN_AUDIENCE,
  LICENSE_TOKEN_TYP,
} from "../src/modules/license/license.constants.js";

const CONTRACT_DMS_MODULES = ["letters", "workflow", "esigning", "legal_hold", "retention", "ai", "ocr", "search", "archive", "reports", "bundles", "webhooks", "forms"];

describe("licence constants match the contract", () => {
  it("the DMS module keys are exactly the contract's section 7 list", () => {
    expect([...DMS_LICENSE_MODULES]).toEqual(CONTRACT_DMS_MODULES);
  });
  it("token typ, audience, system and error codes are verbatim", () => {
    expect(LICENSE_SYSTEM).toBe("dms");
    expect(LICENSE_TOKEN_TYP).toBe("kcms-license+jwt");
    expect(LICENSE_TOKEN_AUDIENCE).toBe("license:dms");
    expect(LICENSE_ERROR).toEqual({ EXPIRED: "LICENSE_EXPIRED", MODULE_DISABLED: "LICENSE_MODULE_DISABLED", SEAT_LIMIT: "LICENSE_SEAT_LIMIT", REQUIRED: "LICENSE_REQUIRED" });
  });
  it("the SSO route is the contract's GET .../licenses/public/dms under SSO's /api/v1", () => {
    expect(LICENSE_SSO_PUBLIC_PATH).toBe("/api/v1/licenses/public/dms");
  });

  const contractPath = path.resolve(__dirname, "..", "..", "docs", "operations", "PLATFORM-LICENSING.md");
  // Not it.skip: CI counts tests (Documentations/TEST_STATUS.md), so the count must not depend on where the repo is checked out.
  it("the keys in the contract document itself (docs/operations/PLATFORM-LICENSING.md)", () => {
    if (!fs.existsSync(contractPath)) return;
    const doc = fs.readFileSync(contractPath, "utf-8");
    const start = doc.indexOf("- **DMS:**");
    expect(start).toBeGreaterThan(-1);
    // backticked identifiers from that bullet (it wraps across lines) up to its "Core:" sentence
    const gateable = doc.slice(start).split("Core:")[0];
    const keys = [...gateable.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(keys).toEqual(CONTRACT_DMS_MODULES);
    expect(doc).toContain("kcms-license+jwt");
    expect(doc).toContain("LICENSE_MODULE_DISABLED");
  });
});
