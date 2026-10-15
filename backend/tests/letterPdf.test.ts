// CAMS letter PDF rendering — Amharic (Ethiopic script) support. Composed
// letters at Example Corp are routinely Amharic; the renderer must embed the
// Unicode font rather than stripping the script to "?" (the old WinAnsi-only
// behavior). These tests exercise the real font assets in backend/assets/fonts.

import { PDFDocument } from "pdf-lib";
import { generateLetterPdf, generateLetterCoverSheet, generateLetterSignableDraft, htmlToPlainText } from "../src/modules/letters/letterPdf.js";

/** Font BaseFont names in the PDF (names live inside compressed object
 *  streams, so raw-byte matching can't see them — reload and enumerate). */
async function embeddedFontNames(pdfBytes: Buffer): Promise<string[]> {
  const loaded = await PDFDocument.load(pdfBytes);
  const names: string[] = [];
  loaded.context.enumerateIndirectObjects().forEach(([, obj]) => {
    const s = (obj as { toString?: () => string })?.toString?.() ?? "";
    const m = /\/BaseFont\s*\/([^\s/>]+)/.exec(s);
    if (m) names.push(m[1]);
  });
  return names;
}

const AMHARIC_SUBJECT = "የደብዳቤ ርዕስ — ትብብር ስምምነት";
const AMHARIC_BODY = "<p>ለክቡር አቶ ተስፋዬ፣</p><p>ይህ ደብዳቤ በኩባንያችን እና በድርጅትዎ መካከል ስለሚደረገው ትብብር ነው።</p>";

function baseInput() {
  return {
    referenceNumber: "REF/HQ/HR/OUT/2026/00042",
    subject: AMHARIC_SUBJECT,
    bodyHtml: AMHARIC_BODY,
    unitName: "Head Quarters",
    departmentName: "Human Resources",
    correspondent: "አቶ ተስፋዬ በቀለ",
    correspondentOrganization: "Ministry of Trade",
    signatoryName: "Daniel Bekele",
    signatoryTitle: "Managing Director",
    approvedAt: new Date("2026-07-18T09:00:00Z"),
    confidentiality: "INTERNAL",
    qrUrl: "https://dms.examplecorp.com/verify?ref=REF%2FHQ%2FHR%2FOUT%2F2026%2F00042&hash=abc",
  };
}

describe("generateLetterPdf — Amharic support", () => {
  it("renders an Amharic letter with the embedded Noto Sans Ethiopic font", async () => {
    const pdf = await generateLetterPdf(baseInput());

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const fonts = await embeddedFontNames(pdf);
    expect(fonts.some((n) => n.includes("NotoSansEthiopic"))).toBe(true);
    // Latin portions still use Helvetica alongside it.
    expect(fonts.some((n) => n.includes("Helvetica"))).toBe(true);
  });

  it("still renders a pure-Latin letter", async () => {
    const pdf = await generateLetterPdf({
      ...baseInput(),
      subject: "Partnership agreement",
      bodyHtml: "<p>Dear Sir, this letter concerns our partnership.</p>",
      correspondent: "Mr. John Doe",
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders an Amharic cover sheet for scanned-origin letters", async () => {
    const pdf = await generateLetterCoverSheet({
      referenceNumber: "REF/HQ/HR/IN/2026/00007",
      direction: "INCOMING",
      subject: AMHARIC_SUBJECT,
      unitName: "Head Quarters",
      departmentName: null,
      correspondent: "አቶ ተስፋዬ በቀለ",
      correspondentOrganization: null,
      attachmentFilename: "scan-0007.pdf",
      confidentiality: "PUBLIC",
      stampedAt: new Date("2026-07-18T09:00:00Z"),
      qrUrl: "https://dms.examplecorp.com/verify?ref=x&hash=y",
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const fonts = await embeddedFontNames(pdf);
    expect(fonts.some((n) => n.includes("NotoSansEthiopic"))).toBe(true);
  });

  it("htmlToPlainText preserves Amharic text", () => {
    expect(htmlToPlainText("<p>ሰላም ለሁሉም</p>")).toBe("ሰላም ለሁሉም");
  });
});

describe("generateLetterSignableDraft", () => {
  it("renders a draft with no reference number, date, or QR — and a valid signature field placement", async () => {
    const { pdf, signatureField } = await generateLetterSignableDraft({
      subject: AMHARIC_SUBJECT,
      bodyHtml: AMHARIC_BODY,
      unitName: "Head Quarters",
      departmentName: "Human Resources",
      correspondent: "አቶ ተስፋዬ በቀለ",
      correspondentOrganization: "Ministry of Trade",
    });

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const fonts = await embeddedFontNames(pdf);
    expect(fonts.some((n) => n.includes("NotoSansEthiopic"))).toBe(true);

    expect(signatureField.pageNumber).toBeGreaterThanOrEqual(1);
    expect(signatureField.width).toBeGreaterThan(0);
    expect(signatureField.height).toBeGreaterThan(0);

    const loaded = await PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(signatureField.pageNumber);
  });

  it("still renders a pure-Latin draft with a sane field position", async () => {
    const { pdf, signatureField } = await generateLetterSignableDraft({
      subject: "Partnership agreement",
      bodyHtml: "<p>Dear Sir, this letter concerns our partnership.</p>",
      unitName: "Head Quarters",
      departmentName: null,
      correspondent: "Mr. John Doe",
      correspondentOrganization: null,
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(signatureField.pageNumber).toBe(1);
  });
});
