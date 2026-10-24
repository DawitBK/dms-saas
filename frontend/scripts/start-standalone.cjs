// Launches a Next.js `output: "standalone"` build, handling the three things
// that make `npm run start` fail on a standalone build:
//
//  1. `next start` does not serve a standalone build at all (Next warns:
//     '"next start" does not work with "output: standalone"'). The real entry
//     point is the generated server.js.
//
//  2. That server.js is NOT always at .next/standalone/server.js. Next mirrors
//     the app's path relative to whatever it infers as the monorepo root, so in
//     an npm workspace (DMS declares workspaces:[backend,frontend] with
//     node_modules at DMS/) it lands at .next/standalone/frontend/server.js,
//     while a standalone app with its own node_modules gets the flat path. We
//     locate it instead of hardcoding either guess.
//
//  3. `next build` does NOT copy .next/static (or public/) into the standalone
//     folder — those files aren't traced. Miss that and the app boots fine but
//     every CSS/JS chunk 404s, so it renders unstyled and looks "broken" for a
//     reason that has nothing to do with the server.
//
// Port: taken from $PORT if set, else the default passed as argv[2].
// Usage: node scripts/start-standalone.cjs 7101
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkFingerprintOrExit } = require('./build-fingerprint.cjs');

const appDir = path.resolve(__dirname, '..');
const distDir = process.env.NEXT_DIST_DIR || '.next';
const standaloneDir = path.join(appDir, distDir, 'standalone');
// argv[2] is the port `npm run start` passes explicitly (7101, this
// system's documented port) — that's visible, intentional config, not a
// hidden fallback. No further default: if neither PORT (env) nor argv is
// given, error below rather than silently picking something like 3000.
const defaultPort = process.argv[2];

// Refuse to serve a build compiled against a different env file than the one
// active right now — see build-fingerprint.cjs for why a restart alone can't
// catch this. start-mirror.cjs sets NODE_ENV=mirror before requiring this
// file; a plain `npm run start` (production) never does.
checkFingerprintOrExit(process.env.NODE_ENV === 'mirror' ? '.env.mirror' : '.env.production');

// How deep the search goes. Next mirrors the app's path relative to whatever it
// infers as the workspace root, and that inference is not under our control: on
// one machine the root came out as C:\Users\admin, which put server.js six
// levels down, at .next/standalone/Downloads/Projects/
// <project folder>/frontend/server.js. The previous cap of 4
// missed it and reported "no server.js found ... Re-run `npm run build`" after a
// build that had in fact succeeded, which sends you to debug the wrong thing.
//
// A generous cap is cheap here: node_modules and dot-directories are skipped
// below, so what remains is a handful of path-mirror directories.
const MAX_DEPTH = 12;

function findServerJs(dir, depth) {
  if (depth > MAX_DEPTH) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Prefer a server.js in this directory before descending.
  for (const e of entries) {
    if (e.isFile() && e.name === 'server.js') return path.join(dir, e.name);
  }
  for (const e of entries) {
    // Skip node_modules and dot-dirs (.next inside standalone holds no entry point).
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const hit = findServerJs(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

if (!fs.existsSync(standaloneDir)) {
  console.error(
    `[start-standalone] ${standaloneDir} does not exist.\n` +
      `Run \`npm run build\` first, and confirm next.config sets output: "standalone".`,
  );
  process.exit(1);
}

const serverJs = findServerJs(standaloneDir, 0);
if (!serverJs) {
  // Show what IS there. "Re-run npm run build" is the wrong advice when the
  // build worked and the entry point is simply somewhere this did not look,
  // and a bare failure gives nothing to tell those two cases apart.
  let listing = '(could not read it)';
  try {
    listing = fs.readdirSync(standaloneDir).join(', ') || '(empty)';
  } catch {
    /* keep the placeholder */
  }
  console.error(
    `[start-standalone] no server.js found under ${standaloneDir} within ${MAX_DEPTH} levels.\n` +
      `  It contains: ${listing}\n` +
      `  If those look like path segments (a mirror of this checkout's location), the build is fine and\n` +
      `  MAX_DEPTH here is too small. If it is empty, the build emitted no standalone bundle —\n` +
      `  check that next.config sets output: "standalone".`,
  );
  process.exit(1);
}

// Mirror the untraced assets next to the server, every start — cheap, and it
// self-heals a build that was run without this step.
const serverDir = path.dirname(serverJs);
for (const [from, to] of [
  [path.join(appDir, distDir, 'static'), path.join(serverDir, distDir, 'static')],
  [path.join(appDir, 'public'), path.join(serverDir, 'public')],
]) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true });
}

const port = process.env.PORT || defaultPort;
if (!port) {
  console.error('[start-standalone] No PORT set (not in the environment, not passed as an argument). Not defaulting silently.');
  process.exit(1);
}
console.log(`[start-standalone] ${path.relative(appDir, serverJs)} on port ${port}`);

const result = spawnSync(process.execPath, [serverJs], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
});
process.exit(typeof result.status === 'number' ? result.status : 1);
