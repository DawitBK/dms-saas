// `next build` auto-loads .env.production regardless of NODE_ENV, so a mirror
// build needs .env.mirror's NEXT_PUBLIC_* values injected into process.env
// BEFORE Next starts, or the build would silently bake in production's (or
// nothing's) values. Usage: node scripts/build-mirror.cjs
'use strict';
const { spawnSync } = require('child_process');
const { loadMirrorEnv, appDir } = require('./mirror-env.cjs');
const { writeFingerprint } = require('./build-fingerprint.cjs');

loadMirrorEnv();
process.env.NODE_ENV = 'production';

// require.resolve (not a hardcoded appDir/node_modules path) because DMS is
// an npm workspaces repo — `next` hoists to the workspace root's
// node_modules, not frontend/node_modules, so a direct path 404s here even
// though the exact same path works for GMS/SSO (not workspaces).
const nextBin = require.resolve('next/dist/bin/next', { paths: [appDir] });
const result = spawnSync(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  cwd: appDir,
  env: process.env,
});
const status = typeof result.status === 'number' ? result.status : 1;
if (status === 0) writeFingerprint('.env.mirror');
process.exit(status);
