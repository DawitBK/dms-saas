import { AppError } from "../src/core/AppError.js";
import { mandatoryMetadataFields, validateUploadInput } from "../src/modules/documents/documentValidation.js";

const validInput = Object.fromEntries(mandatoryMetadataFields.map((field: string) => [field, `${field}-value`]));
const validFile = {
  buffer: Buffer.from("%PDF-1.4"),
  mimetype: "application/pdf",
  size: 1024,
  originalname: "contract.pdf"
};

describe("document upload validation", () => {
  it("accepts permitted files with complete mandatory metadata", async () => {
    await expect(validateUploadInput(validInput, validFile)).resolves.not.toThrow();
  });

  it("rejects unsupported MIME types", async () => {
    await expect(validateUploadInput(validInput, { ...validFile, mimetype: "application/x-msdownload" })).rejects.toThrow(AppError);
  });

  it("rejects files over 500 MB", async () => {
    await expect(validateUploadInput(validInput, { ...validFile, size: 501 * 1024 * 1024 })).rejects.toThrow(AppError);
  });

  it("rejects missing mandatory metadata", async () => {
    const input = { ...validInput };
    delete (input as any).title;
    await expect(validateUploadInput(input, validFile)).rejects.toThrow(AppError);
  });

  it("rejects missing explicit security classification", async () => {
    const input = { ...validInput, securityClassification: "" };
    await expect(validateUploadInput(input, validFile)).rejects.toThrow(AppError);
  });

  it("rejects filenames over 255 chars", async () => {
    await expect(validateUploadInput(validInput, { ...validFile, originalname: `${"a".repeat(256)}.pdf` })).rejects.toThrow(AppError);
  });
});
