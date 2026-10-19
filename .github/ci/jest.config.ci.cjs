// CI-only jest config: the repository's backend/jest.config.cjs with ts-jest in
// transpile-only mode. Used by the "unit tests" step of .github/workflows/ci.yml.
//
// Why: several test files declare top-level `const mockDocument = ...` and have
// no import/export statement (only dynamic import()), so ts-jest's per-worker
// language service reads them as global scripts and reports TS2451 "Cannot
// redeclare block-scoped variable" as soon as one worker has seen two of them.
// Whether it happens depends on how the files are spread over workers, so it is
// green on a many-core laptop and red on a 4-core runner. `tsc` (the
// `npm run typecheck` step, which includes tests/) reads them correctly as
// modules (backend/package.json "type": "module"), so type safety is still
// checked in full; this only stops the duplicate, order-dependent check.
// The proper fix is an `export {}` in those test files; they are product-repo
// files and were left alone on purpose.
const path = require('node:path');
const base = require('../../backend/jest.config.cjs');

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '../../backend'),
  transform: {
    '^.+\.tsx?$': [
      'ts-jest',
      {
        // Inline options, because transpile-only mode does not downlevel the
        // module format by itself: the real tsconfig says NodeNext, and
        // backend/package.json is "type": "module", so every file would come out
        // as ESM, which jest (not started with --experimental-vm-modules) cannot
        // load. Same target and interop as tsconfig.base.json.
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node10',
          esModuleInterop: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          types: ['node', 'jest'],
        },
        isolatedModules: true,
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
};
