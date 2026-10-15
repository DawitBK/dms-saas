// ts-jest's own module resolution (separate from Jest's moduleNameMapper,
// which only swaps the runtime import) cannot find the real "file-type"
// package even though plain `tsc` resolves it fine via the same NodeNext
// config — a known ts-jest quirk with npm-workspace-hoisted packages. This
// ambient declaration is the type-checking-side fallback for the mock
// moduleNameMapper already substitutes at runtime; without it every test
// that transitively imports mimeValidation.ts fails at compile time with
// "Cannot find module 'file-type'" before any test code runs.
//
// NOTE: this file's basename must not collide with file-type.mock.ts in
// this same directory — TypeScript silently drops a .d.ts whose basename
// (after stripping .d.ts) matches a sibling .ts file, which is why an
// earlier attempt named file-type.mock.d.ts had no effect at all.
declare module "file-type" {
  export function fileTypeFromBuffer(
    buffer: Buffer | Uint8Array | ArrayBuffer,
  ): Promise<{ ext: string; mime: string } | undefined>;
}

// franc has real types shipped (@types-free, own .d.ts), and plain `tsc`
// resolves them fine, but ts-jest hits the same resolution gap it hits for
// file-type — see this file's header comment. Same fallback, same fix.
declare module "franc" {
  export function franc(text: string, options?: { minLength?: number }): string;
}
