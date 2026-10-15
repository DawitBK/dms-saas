import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const backend = resolve(root, 'backend');
const testScripts = resolve(backend, 'test-scripts');
const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// The master runner only invokes these three scripts and swallows a phase's
// error so it can print a combined summary. CI deliberately runs every
// executable verifier directly, including those phases, and fails immediately.
const scripts = readdirSync(testScripts)
  .filter((name) => name.endsWith('.ts') && name !== 'run-all-verifications.ts')
  .sort();

if (process.argv.includes('--list')) {
  console.log(`CI will run ${scripts.length} backend verifiers:`);
  for (const script of scripts) console.log(`- ${script}`);
  process.exit(0);
}

for (const [index, script] of scripts.entries()) {
  console.log(`\n[${index + 1}/${scripts.length}] ${script}`);
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [tsx, resolve(testScripts, script)], {
      cwd: backend,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${script} failed with exit code ${exitCode}`);
  }
}

console.log(`\nAll ${scripts.length} backend verifiers passed.`);
