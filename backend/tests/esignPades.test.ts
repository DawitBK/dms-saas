// PAdES flattened-copy generation (esignPades.ts): flattens signed fields,
// appends the certificate-of-completion page, and embeds a real byte-range
// signature using a PKCS#12 cert generated in-test with node-forge.

import crypto from "node:crypto";
import forge from "node-forge";

function makeP12(): { b64: string; passphrase: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + crypto.randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: "commonName", value: "DMS Test Signer" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const passphrase = "test-passphrase";
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, { algorithm: "3des" });
  return { b64: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64"), passphrase };
}

const p12 = makeP12();

jest.mock("../src/config/env.js", () => ({
  config: {
    ESIGN_P12_B64: p12.b64,
    ESIGN_P12_PASSPHRASE: p12.passphrase,
  },
}));

import { PDFDocument, StandardFonts } from "pdf-lib";
import { generatePadesSignedPdf, padesConfigured } from "../src/modules/esigning/esignPades.js";

async function makeOriginalPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Agreement body text — sign below.", { x: 56, y: 700, size: 12, font });
  return Buffer.from(await pdf.save());
}

// 1x1 transparent PNG
const TINY_PNG_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("generatePadesSignedPdf", () => {
  jest.setTimeout(30_000);

  it("padesConfigured reflects the mocked cert", () => {
    expect(padesConfigured()).toBe(true);
  });

  it("flattens fields, appends the certificate page, and embeds a byte-range signature", async () => {
    const original = await makeOriginalPdf();

    const signed = await generatePadesSignedPdf({
      originalPdf: original,
      fields: [
        { pageNumber: 1, x: 56, y: 650, width: 160, height: 48, fieldType: "signature", value: TINY_PNG_DATAURL },
        { pageNumber: 1, x: 300, y: 650, width: 120, height: 20, fieldType: "date", value: "2026-07-18" },
        { pageNumber: 1, x: 56, y: 600, width: 200, height: 20, fieldType: "text", value: null }, // unsigned → skipped
      ],
      signers: [
        { name: "Daniel Bekele", email: "daniel@examplecorp.com", signedAt: new Date("2026-07-18T10:00:00Z"), ipAddress: "10.0.0.5" },
        { name: "External Party", email: "partner@example.com", signedAt: new Date("2026-07-18T11:00:00Z"), ipAddress: null },
      ],
      requestId: "req-test-0001",
      requestTitle: "Supply agreement",
    });

    expect(signed.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const raw = signed.toString("latin1");
    // The PAdES signature dictionary: byte range + a non-placeholder Contents blob.
    expect(raw).toContain("/ByteRange");
    expect(raw).toContain("/SubFilter /adbe.pkcs7.detached");
    // The signature must actually be written over the placeholder zeros.
    const contentsMatch = /\/Contents\s*<([0-9A-Fa-f]+)>/.exec(raw);
    expect(contentsMatch).toBeTruthy();
    expect(/^0+$/.test(contentsMatch![1])).toBe(false);

    // Certificate page appended: original 1 page -> 2 pages.
    const reloaded = await PDFDocument.load(signed, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("handles an Amharic signer name and typed field (certificate page and flattened field both render)", async () => {
    const original = await makeOriginalPdf();
    const base = {
      originalPdf: original,
      requestId: "req-am-0001",
      requestTitle: "Supply agreement",
    };
    const latin = await generatePadesSignedPdf({
      ...base,
      fields: [{ pageNumber: 1, x: 56, y: 600, width: 200, height: 20, fieldType: "text", value: "Daniel Bekele" }],
      signers: [{ name: "Daniel Bekele", email: "daniel@examplecorp.com", signedAt: new Date("2026-07-18T10:00:00Z"), ipAddress: "10.0.0.5" }],
    });
    const amharic = await generatePadesSignedPdf({
      ...base,
      fields: [{ pageNumber: 1, x: 56, y: 600, width: 200, height: 20, fieldType: "text", value: "ዳንኤል በቀለ" }],
      signers: [{ name: "ዳንኤል በቀለ", email: "daniel@examplecorp.com", signedAt: new Date("2026-07-18T10:00:00Z"), ipAddress: "10.0.0.5" }],
    });
    expect(amharic.toString("latin1")).toContain("/ByteRange");
    expect(amharic.length).toBeGreaterThan(latin.length + 2000);
    expect((await PDFDocument.load(amharic, { updateMetadata: false })).getPageCount()).toBe(2);
  });

  it("throws when the cert is not configured", async () => {
    const { config } = jest.requireMock("../src/config/env.js") as { config: Record<string, unknown> };
    const saved = config.ESIGN_P12_B64;
    config.ESIGN_P12_B64 = undefined;
    try {
      await expect(
        generatePadesSignedPdf({
          originalPdf: await makeOriginalPdf(),
          fields: [], signers: [], requestId: "x", requestTitle: "x",
        }),
      ).rejects.toThrow(/ESIGN_P12_B64/);
      expect(padesConfigured()).toBe(false);
    } finally {
      config.ESIGN_P12_B64 = saved;
    }
  });
});
