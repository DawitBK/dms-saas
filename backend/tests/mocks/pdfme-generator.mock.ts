export async function generate(_input: unknown): Promise<Uint8Array> {
  return new Uint8Array(Buffer.from('%PDF-1.4 mock'));
}
