module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // Must run before test modules import src/config/env.ts. These are
  // deliberately non-production values and keep unit tests hermetic even
  // when a test changes process.cwd() away from backend/.env.
  setupFiles: ["<rootDir>/tests/setup-env.cjs"],
  // Jest's 5s default is too tight for the suites that mount the real Express
  // app and drive it through supertest (acl.granter, access-rules.granter,
  // permission.enforcement, ...). Alone they finish in ~5s; with 52 suites in
  // flight on a busy machine the same tests were taking 35-57s and failing on
  // the timeout, not on an assertion — a false alarm that costs a re-run every
  // time. A real failure still fails on its assertion, so this hides nothing.
  testTimeout: 60_000,
  forceExit: true,
  roots: ["<rootDir>/tests"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^jwks-rsa$": "<rootDir>/tests/mocks/jwks-rsa.mock.ts",
    "^file-type$": "<rootDir>/tests/mocks/file-type.mock.ts",
    "^franc$": "<rootDir>/tests/mocks/franc.mock.ts",
    "^@pdfme/generator$": "<rootDir>/tests/mocks/pdfme-generator.mock.ts",
    "^@pdfme/common$": "<rootDir>/tests/mocks/pdfme-common.mock.ts",
    "^@pdfme/schemas$": "<rootDir>/tests/mocks/pdfme-schemas.mock.ts",
    "^@tus/server$": "<rootDir>/tests/mocks/tus-server.mock.ts",
    "^@tus/file-store$": "<rootDir>/tests/mocks/tus-file-store.mock.ts"
  },
  transformIgnorePatterns: [
    "/node_modules/(?!(jwks-rsa|jose|file-type)/)"
  ],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.json",
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  // TEST-3: Coverage is now a CI contract, not an informational artifact.
  // These are deliberately below the measured post-remediation baseline
  // (37.80/20.07/24.54/39.43) to leave a small margin for legitimate new
  // modules while preventing an unreviewed suite-wide regression. Raise this
  // ratchet as each module family gains focused tests; do not lower it.
  coverageThreshold: {
    global: {
      statements: 37,
      branches: 19,
      functions: 23,
      lines: 39,
    },
  },
};
