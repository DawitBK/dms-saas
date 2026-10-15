/**
 * Retire an EMAIL outbox backlog that must never be delivered.
 *
 * WHY THIS IS NEEDED
 *
 * The outbox is at-least-once and has no expiry: a PENDING row from two months
 * ago is delivered the moment a worker can reach the relay again. That is
 * correct for a queue whose recipients are real and whose contents are still
 * true, and dangerous for a dev database, where a backlog accumulates while
 * Redis or SMTP is down and every row names a seeded @edams.local address.
 *
 * This bit for real on 2026-09-03. Pointing dev SMTP at the production Gmail
 * relay to test the mail path caused the dev backend to restart, drain its
 * backlog, and relay 95 stale SYSTEM.ALERTs to a domain that does not exist —
 * 133 authenticated connections in a few minutes, which Gmail answered with
 * `454-4.7.0 Too many login attempts` and a temporary block on the account the
 * whole platform sends through. 5,684 rows were still queued behind them.
 *
 * A queue is not an archive. When the mail in it is stale, undeliverable, or
 * simply nobody's any more, the right move is to give it a terminal state and
 * say why — not to leave it primed to fire the next time a relay works.
 *
 * WHAT IT DOES
 *
 * Moves EMAIL rows in PENDING/FAILED/PROCESSING that are older than
 * --older-than hours to DEAD_LETTER with attempts exhausted, so the poller can
 * never re-select them, stamping error_msg with the reason. Nothing is deleted:
 * the rows stay auditable and a genuinely wanted one can be re-queued by hand.
 *
 * Dry run by default. Refuses to run against NODE_ENV=production without
 * --i-know-this-is-production, because on a real deployment these rows are
 * somebody's actual approval requests.
 *
 *   npx tsx test-scripts/retire-stale-email-backlog.ts
 *   npx tsx test-scripts/retire-stale-email-backlog.ts --apply --older-than 1
 */

import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { config } from '../src/config/env.js';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const olderThanHours = Number(args[args.indexOf('--older-than') + 1]) || 1;
const forceProd = args.includes('--i-know-this-is-production');

const REASON =
  `Retired ${new Date().toISOString().slice(0, 10)} by retire-stale-email-backlog.ts: ` +
  'stale EMAIL backlog, never delivered. Left queued, these would have been relayed in bulk ' +
  'the next time a worker reached a working SMTP relay.';

async function main() {
  if (config.NODE_ENV === 'production' && !forceProd) {
    console.error(
      '\n  Refusing to run against NODE_ENV=production.\n' +
        '  These rows are real approval requests and notifications that people are waiting on.\n' +
        '  Re-run with --i-know-this-is-production only if you have established they are not.\n',
    );
    process.exit(1);
  }

  await initModels();
  await connectDB();

  const rows = await sequelize.query<{ status: string; type: string; n: string; oldest: string }>(
    `SELECT status, type, count(*) AS n, min(created_at)::date AS oldest
       FROM outbox_events
      WHERE channel = 'EMAIL'
        AND status IN ('PENDING', 'FAILED', 'PROCESSING')
        AND created_at < NOW() - (:hours || ' hours')::interval
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    { replacements: { hours: String(olderThanHours) }, type: QueryTypes.SELECT },
  );

  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  console.log(`\n  EMAIL events older than ${olderThanHours}h and still deliverable:\n`);
  for (const r of rows) console.log(`    ${String(r.n).padStart(6)}  ${r.status.padEnd(11)} ${r.type}  (from ${r.oldest})`);
  console.log(`\n    ${total} total\n`);

  if (total === 0) {
    console.log('  Nothing to retire.\n');
    process.exit(0);
  }

  if (!apply) {
    console.log('  Dry run. Re-run with --apply to retire them.\n');
    process.exit(0);
  }

  const [, meta] = await sequelize.query(
    `UPDATE outbox_events
        SET status = 'DEAD_LETTER',
            attempts = max_attempts,
            error_msg = :reason
      WHERE channel = 'EMAIL'
        AND status IN ('PENDING', 'FAILED', 'PROCESSING')
        AND created_at < NOW() - (:hours || ' hours')::interval`,
    { replacements: { reason: REASON, hours: String(olderThanHours) }, type: QueryTypes.UPDATE },
  );

  console.log(`  Retired ${meta ?? total} events to DEAD_LETTER.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  FATAL', err);
  process.exit(1);
});
