// Shared loader for the two mirror-mode scripts (build-mirror.cjs,
// start-mirror.cjs). Next's OWN env-file convention only covers
// .env.development (next dev) and .env.production (next build/start) — there
// is no built-in way to make `next build`/`next start` consult an arbitrary
// third file, so this parses .env.mirror by hand and sets it on
// process.env before Next ever runs. No `dotenv` dependency: this app never
// added it (unlike GMS's frontend, which already depends on it for the same
// job via scripts/run-next-with-env.js), and a ~15-line parser isn't worth a
// new dependency for one file.
'use strict';
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(__dirname, '..');
const mirrorEnvPath = path.join(appDir, '.env.mirror');

function loadMirrorEnv() {
  if (!fs.existsSync(mirrorEnvPath)) {
    console.error(
      `[mirror] ${mirrorEnvPath} does not exist.\n` +
        'This is the isolated local prod-mirror environment — ' +
        'it is never `.env`/`.env.development` or `.env.production`.',
    );
    process.exit(1);
  }
  for (const rawLine of fs.readFileSync(mirrorEnvPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  process.env.NODE_ENV = 'mirror';
  process.env.NEXT_DIST_DIR = '.next-mirror';
  // `next build` forces its OWN process.env.NODE_ENV back to 'production'
  // internally regardless of what's set beforehand, clobbering the line
  // above — so apiConfig.ts's build-time localhost guards (which key off
  // NODE_ENV==='production') cannot tell "a genuine mirror build, where
  // localhost is the correct value because this machine has no public DNS
  // name" apart from "a real prod build with a leftover dev value". This
  // marker survives that clobber (Next only touches NODE_ENV, not arbitrary
  // vars) and lets those guards make that distinction.
  // NEXT_PUBLIC_-prefixed and not just MIRROR_BUILD: apiConfig.ts's guard
  // gets bundled into the CLIENT too, and Next only inlines NEXT_PUBLIC_*
  // vars into that bundle — an unprefixed var is only ever visible to the
  // server-side build-time evaluation, so the client copy of the same check
  // would see it as undefined and throw in the browser even though the
  // server-side build passed. Found the hard way: build succeeded, then the
  // exact same error surfaced as a client runtime exception on every page.
  process.env.NEXT_PUBLIC_MIRROR_BUILD = 'true';
}

module.exports = { loadMirrorEnv, appDir };
