// Mock for file-type module to make ESM import work in Jest
export async function fileTypeFromBuffer(buffer: Buffer) {
  // Simple mock implementation that returns PDF by default
  // Tests can override this if needed
  return {
    ext: "pdf",
    mime: "application/pdf"
  };
}
