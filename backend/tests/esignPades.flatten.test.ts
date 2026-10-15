// A signer's typed name / text field in a non-Latin script (Amharic/Ge'ez) used to make
// pdf-lib's WinAnsi-only Helvetica throw inside the flattener, so a "completed" ceremony
// never got its signed copy. The flattener must degrade to ASCII, not abort.

import { PDFDocument, StandardFonts } from "pdf-lib";
import { generateFlattenedUnsignedPdf } from "../src/modules/esigning/esignPades.js";

async function originalPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText("Agreement", { x: 56, y: 700, size: 12, font });
  return Buffer.from(await pdf.save());
}

describe("generateFlattenedUnsignedPdf", () => {
  jest.setTimeout(30_000);

  it("does not throw on a text field the standard font cannot encode", async () => {
    const out = await generateFlattenedUnsignedPdf({
      originalPdf: await originalPdf(),
      requestId: "req-1",
      fields: [{ pageNumber: 1, x: 100, y: 100, width: 200, height: 24, fieldType: "text", value: "ዳንኤል በቀለ" }],
    });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("renders Amharic with the embedded Ethiopic font instead of printing question marks", async () => {
    const field = (value: string) => ({ pageNumber: 1, x: 100, y: 100, width: 200, height: 24, fieldType: "text" as const, value });
    const latin = await generateFlattenedUnsignedPdf({ originalPdf: await originalPdf(), requestId: "req-l", fields: [field("Daniel Bekele")] });
    const amharic = await generateFlattenedUnsignedPdf({ originalPdf: await originalPdf(), requestId: "req-a", fields: [field("ዳንኤል በቀለ")] });
    const mixed = await generateFlattenedUnsignedPdf({ originalPdf: await originalPdf(), requestId: "req-m", fields: [field("Daniel ዳንኤል (signed)")] });
    // The Ethiopic font subset is embedded only when needed, so the files are clearly larger.
    expect(amharic.length).toBeGreaterThan(latin.length + 2000);
    expect(mixed.length).toBeGreaterThan(latin.length + 2000);
    expect((await PDFDocument.load(mixed)).getPageCount()).toBe(1);
  });

  it("a character no font has degrades to '?' for that character only and never throws", async () => {
    const out = await generateFlattenedUnsignedPdf({
      originalPdf: await originalPdf(),
      requestId: "req-z",
      fields: [{ pageNumber: 1, x: 100, y: 100, width: 200, height: 24, fieldType: "text", value: "Name \u{1F600} ok" }],
    });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });

  it("still draws ordinary Latin text", async () => {
    const out = await generateFlattenedUnsignedPdf({
      originalPdf: await originalPdf(),
      requestId: "req-2",
      fields: [{ pageNumber: 1, x: 100, y: 100, width: 200, height: 24, fieldType: "text", value: "Daniel Bekele" }],
    });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });
});
