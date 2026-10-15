/**
 * check-validator-limits.ts — does every request validator agree with the column it feeds?
 *
 * The owner's standing rule is absolute parity between the interface, the backend and the database. For text limits that means a Zod string that
 * writes into a VARCHAR(n) column must say `.max(n)`: with no maximum, or a larger one, an over-long value passes validation and is stopped by the
 * database instead, which answers with a vague "value too long" that names no field (shared/dbErrors.ts) and which the form could not have prevented.
 *
 * This reads every VARCHAR(n) column from the live database and every `key: z.string()...` in src/, and reports a field when its name matches a column
 * of a table whose name appears in the file's path (documents.service.ts is checked against `documents` and `document_*` columns, not against `roles.name`).
 * It is a heuristic by design (a name match, not a type-level proof), tuned to report nothing today; a new mismatch should fail loudly here rather
 * than be found by an auditor.
 *
 *   npm run parity:check          (development database; read-only)
 */
import '../src/config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sequelize } from '../src/infrastructure/database/index.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const STOP = new Set(['service', 'routes', 'route', 'modules', 'ts', 'controller', 'index', 'tus', 'upload', 'doc', 'body']);

const camel = (s: string): string => s.split('_').map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');

function tokens(filePath: string): Set<string> {
  const out = new Set<string>();
  for (const raw of filePath.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/)) {
    const t = raw.toLowerCase();
    if (!t || STOP.has(t)) continue;
    out.add(t);
    out.add(t.replace(/s$/, ''));
    out.add(`${t}s`);
  }
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

async function main(): Promise<void> {
  const [rows] = (await sequelize.query(
    `SELECT table_name AS t, column_name AS c, character_maximum_length AS len FROM information_schema.columns WHERE table_schema = 'public' AND character_maximum_length IS NOT NULL`,
  )) as [Array<{ t: string; c: string; len: number }>, unknown];
  const byField = new Map<string, Map<number, string[]>>();
  for (const r of rows) {
    const lens = byField.get(camel(r.c)) ?? new Map<number, string[]>();
    lens.set(r.len, [...(lens.get(r.len) ?? []), r.t]);
    byField.set(camel(r.c), lens);
  }

  const problems: string[] = [];
  let examined = 0;
  const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(z\.(?:string|enum|coerce)[\s\S]*?)(?=,\s*\n|\n\s*\}\))/gm;
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file);
    const pathTokens = tokens(rel);
    for (const m of text.matchAll(field)) {
      const [, key, chain] = m;
      if (!chain!.startsWith('z.string')) continue;
      examined += 1;
      const lens = byField.get(key!);
      if (!lens) continue;
      const max = /\.max\((\d+)/.exec(chain!)?.[1];
      const line = text.slice(0, m.index).split('\n').length;
      for (const [len, tables] of lens) {
        const related = tables.filter((t) => t.split('_').some((p) => pathTokens.has(p)) || pathTokens.has(t));
        if (related.length === 0) continue;
        if (max === undefined) problems.push(`${rel}:${line}  ${key}: no .max() but ${related[0]}.${key} holds at most ${len}`);
        else if (Number(max) > len) problems.push(`${rel}:${line}  ${key}: .max(${max}) is above the column's ${len} (${related[0]})`);
      }
    }
  }

  console.log(`validator limits: ${examined} string fields examined against ${rows.length} bounded columns`);
  if (problems.length === 0) {
    console.log('  every matched validator is within its column');
  } else {
    for (const p of problems) console.log(`  MISMATCH ${p}`);
  }
  await sequelize.close();
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
