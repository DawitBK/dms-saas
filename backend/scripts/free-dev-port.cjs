// Runs automatically before `npm run dev` / `npm run dev:worker` (wired as
// "predev"/"predev:worker" in package.json) so a second invocation never
// silently piles up a second nodemon/tsx tree fighting the first one — the
// actual root cause of the earliest "backend keeps crashing" reports:
// multiple competing processes bound to (or racing for) the same resource,
// one of them losing and getting killed/restarted by nodemon's own
// crash-recovery loop, which reads as random instability.
//
// Two passes, because one alone isn't enough:
//   1. (API process only — it owns a port) whatever's actively LISTENING on
//      the port right now.
//   2. Any nodemon/tsx process rooted at THIS backend directory AND running
//      the same entry script as the process about to start, that is NOT
//      necessarily listening — e.g. nodemon whose child already died and
//      it's sitting idle in its own "waiting for file changes" state. Pass 1
//      alone misses this for the API process (nothing bound to the port, so
//      netstat finds nothing) and misses it ENTIRELY for the worker process
//      (it never binds a port at all). Confirmed live: three orphaned
//      nodemon trees accumulated this exact way before pass 2 existed.
//
// Matched by directory AND entry script, not just process name — so this
// never touches SSO's/GMS's own nodemon dev servers (same command line
// shape, different repo path), and so starting the API dev server never
// kills the separate worker process (or vice versa) even though both are
// "nodemon ... tsx ..." rooted at this same backend directory.
//
// Cross-platform (Windows dev machines, Linux CI/prod). Never throws — a
// clean environment or a lookup failure both just let `dev` proceed; this
// only ever prevents a collision, never blocks a legitimate first start.
const { execSync } = require('node:child_process');
const path = require('node:path');

// argv[2]: 'main' (default, has a port) or 'worker' (no port — process-only).
const TARGET = process.argv[2] || 'main';
const ENTRY_SCRIPT = TARGET === 'worker' ? 'bin/worker.ts' : 'main.ts';
const PORT = process.env.PORT || 7100;
const BACKEND_DIR = path.resolve(__dirname, '..');

function killWindowsPortListener(port) {
  let out;
  try {
    out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  } catch {
    return; // findstr exits non-zero when nothing matches — port is free
  }
  const pids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/LISTENING\s+(\d+)\s*$/);
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) killWindowsPid(pid, `holding :${port}`);
}

function killWindowsOrphans() {
  // PowerShell, not wmic — wmic is removed on current Windows builds.
  const entryLike = ENTRY_SCRIPT.replace(/\//g, '\\');
  const psFilter = `Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -match 'nodemon|tsx') -and ($_.CommandLine -like '*${BACKEND_DIR.replace(/'/g, "''")}*') -and ($_.CommandLine -like '*${entryLike.replace(/'/g, "''")}*') } | Select-Object -ExpandProperty ProcessId`;
  let out;
  try {
    out = execSync(`powershell -NoProfile -NonInteractive -Command "${psFilter}"`, { encoding: 'utf8' });
  } catch {
    return;
  }
  const myPid = String(process.pid);
  const pids = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== myPid);
  for (const pid of pids) killWindowsPid(pid, 'orphaned watcher (no live listener)');
}

function killWindowsPid(pid, reason) {
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
    console.log(`[free-dev-port] killed stale process ${pid} — ${reason}`);
  } catch {
    // already gone — fine
  }
}

function killPosix(port) {
  const myPid = String(process.pid);
  const pids = new Set();

  if (TARGET === 'main') {
    try {
      const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
      out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((p) => pids.add(p));
    } catch {
      // nothing listening — fine
    }
  }

  try {
    // pgrep -f matches against the full command line, so this only catches
    // nodemon/tsx invocations rooted at this backend's own directory AND
    // running this specific entry script.
    const out = execSync(`pgrep -f "${BACKEND_DIR}.*(nodemon|tsx).*${ENTRY_SCRIPT}"`, { encoding: 'utf8' });
    out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((p) => pids.add(p));
  } catch {
    // no matches — fine
  }

  pids.delete(myPid);
  for (const pid of pids) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      console.log(`[free-dev-port] killed stale process ${pid}`);
    } catch {
      // already gone — fine
    }
  }
}

try {
  if (process.platform === 'win32') {
    if (TARGET === 'main') killWindowsPortListener(PORT);
    killWindowsOrphans();
  } else {
    killPosix(PORT);
  }
} catch (err) {
  console.warn(`[free-dev-port] check failed, continuing anyway: ${err.message}`);
}
