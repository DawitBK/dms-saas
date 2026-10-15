// franc and its dependency trigram-utils are pure ESM with no CJS build;
// jest's ts-jest transform only covers .ts(x), so a bare `import` inside
// franc/index.js hits node's CJS loader and fails with "Cannot use import
// statement outside a module" the moment any test transitively imports
// shared/ocr.ts (acl.403, auth.401, permission.403 all do, via app.ts's
// route wiring — none of them exercise OCR language detection itself).
// Mocked the same way file-type/jwks-rsa are: a fixed return is enough
// since nothing here asserts on language detection.
export function franc(): string {
  return "eng";
}
