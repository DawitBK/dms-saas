import crypto from "node:crypto";
import { AuditLog, sequelize } from "../../infrastructure/database/index.js";
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { Op, QueryTypes, type Transaction } from "sequelize";
import { z } from "zod";
import { AppError } from "../../core/AppError.js";
import { AuditEventType } from "./auditEvents.js";
import { getRequestSourceIp, getRequestTenantId } from "../../shared/requestContext.js";
import { runInTransaction } from "../../shared/transaction.js";
import { getChainCacheEntry, setChainCacheEntry } from "../../infrastructure/cache/auditChainCache.js";
import { getPlatformAdminUserIds } from "../../shared/platformAdmin.js";

export type AuditInput = {
  eventType: AuditEventType;
  tenantId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  sourceIp?: string | null;
  sessionId?: string | null;
  documentId?: string | null;
  documentVersion?: string | null;
  actionDetails: unknown;
  previousState?: string | null;
  newState?: string | null;
  isSuccess?: boolean;
  errorCode?: string | null;
  /** Set by writeAuditLog itself when it anonymised a platform-admin actor; callers never pass it. */
  platformAdminMasked?: boolean;
};

/** See writeAuditLog: a platform admin's actions are recorded without any identifying field. */
async function anonymisePlatformAdminActor(input: AuditInput): Promise<AuditInput> {
  if (!input.userId) return input;
  if (!(await getPlatformAdminUserIds()).includes(input.userId)) return input;
  return { ...input, userId: null, userRole: null, sessionId: null, sourceIp: null, platformAdminMasked: true };
}

/**
 * S5-07: HMAC-SHA256 audit chain with PII pseudonymization
 * Write audit entry with cryptographic integrity protection
 *
 * Chain locking/caching model:
 * - The hash chain invariant (previousHash === prior entry's entryHash) is
 *   maintained PER TENANT, not globally. A single global advisory lock would
 *   serialize every audited write across every tenant system-wide, which is
 *   an unacceptable throughput ceiling (see original audit finding A10 -
 *   public unauthenticated endpoints that write audit rows could stall the
 *   whole system). Instead we take a per-tenant Postgres advisory lock
 *   (`hashtext(tenantKey)::bigint`), so writes for different tenants proceed
 *   concurrently while writes within one tenant's chain stay serialized.
 * - We avoid re-querying `AuditLog.findOne(... ORDER BY sequence_number DESC)`
 *   on every write by keeping a cache of the last {sequenceNumber, entryHash}
 *   per tenant in Redis (infrastructure/cache/auditChainCache.ts). On a cold
 *   cache (or Redis unavailable) we fall back to one query (and the defensive
 *   sequence self-heal) to seed it.
 * - The cache is updated via `transaction.afterCommit()`, never eagerly.
 *   Writing it as soon as the row is staged (the original design) meant that
 *   if the commit itself later failed — a serialization failure, a dropped
 *   connection — the cache would hold a tip hash for a row that never made it
 *   into the database, poisoning the next writer's previousHash. Writing it
 *   right after this function *returns* is ALSO wrong now that writeAuditLog
 *   runs inside `runInTransaction` (see shared/transaction.ts): when a request
 *   transaction is already open, this function reuses it and returns long
 *   before that outer transaction actually commits (commit happens after the
 *   HTTP response is sent — see shared/middleware.ts). `afterCommit` is the
 *   one hook that fires at the true commit point in both cases — reusing the
 *   ambient request transaction, or opening a fresh one when called outside a
 *   request (e.g. from a worker). A concurrent writer could in principle
 *   acquire the advisory lock before this callback runs; it will simply see a
 *   cache miss and fall through to the one-query cold-cache path below, which
 *   is always correct, just an extra round trip in that narrow window.
 * - This cache is shared via Redis (not a per-process in-memory Map) because
 *   this app runs the API (`npm run dev` / src/main.ts) and the BullMQ
 *   workers (`npm run worker` / src/bin/worker.ts) as separate OS processes
 *   against the same DB/Redis. Both write audit rows independently (e.g.
 *   RetentionPurgeWorker, ScanWorker, AIWorker). A per-process cache meant
 *   each process could hold a stale "last hash" relative to what the other
 *   had just committed, which surfaced as false "chain broken" reports from
 *   verifyAuditChain() with no actual tampering involved.
 */
const AUDIT_SYSTEM_CHAIN_KEY = "__DMS_AUDIT_SYSTEM__"; // lock/cache key for NULL-tenant (system-level) writes

/**
 * R-02: pick which of this tenant's parallel chains to append to.
 *
 * Random, not derived from the row's content or the request, for two
 * reasons. It spreads writers evenly without needing to know anything about
 * them; and because a row's shard is not a function of its data, changing
 * AUDIT_CHAIN_SHARDS later cannot retroactively move an existing row into a
 * different chain and break its linkage. Lowering the setting simply retires
 * shards (their chains stay valid and verifiable); raising it starts new ones.
 */
/**
 * The sequence self-heal below is defensive and idempotent, but it is not
 * free and it does not need to run more than once in a process's life. It
 * used to be triggered by a chain-cache MISS, which was fine when there was
 * one cache key per tenant — but R-02 gives each tenant one key PER SHARD, so
 * a cold start now produces a burst of misses instead of a single one. This
 * flag collapses them back to one attempt.
 */
let auditSequenceHealAttempted = false;

function pickChainShard(): number {
  return Math.floor(Math.random() * config.AUDIT_CHAIN_SHARDS);
}

/** Identity of one chain: a tenant (or the system pseudo-tenant) and a shard.
 *  Used for both the advisory lock key and the tip cache key, so two writers
 *  only contend when they are appending to the SAME chain. */
function chainCacheKey(tenantId: string | null, chainShard = 0): string {
  const base = tenantId ?? AUDIT_SYSTEM_CHAIN_KEY;
  // Shard 0 keeps the bare, unsuffixed key so existing cache entries (and
  // the single-chain configuration) behave exactly as before.
  return chainShard === 0 ? base : `${base}#${chainShard}`;
}

/**
 * Persist an audit entry.  Pass the transaction that owns a domain mutation
 * when the mutation deliberately uses a standalone transaction (for example
 * a SERIALIZABLE quota reservation); otherwise this function reuses the
 * request transaction or creates a fresh worker transaction as before.
 */
export async function writeAuditLog(rawInput: AuditInput, transaction?: Transaction) {
  // The platform administrator leaves no attributable trace: its actions are
  // recorded (the platform stays accountable in aggregate and the hash chain
  // stays gap-free) but without who, what role, from where, or which session.
  // Applied once here so it holds for every one of the call sites, and BEFORE
  // the hash is computed so verifyAuditChain still recomputes the stored row.
  const input: AuditInput = await anonymisePlatformAdminActor(rawInput);
  const tenantId = input.tenantId ?? getRequestTenantId() ?? null;
  /**
   * Default the caller address from the request context, exactly as tenantId
   * is defaulted just above.
   *
   * audit_logs.source_ip existed, AuditInput accepted it, and 174 of the 177
   * writeAuditLog call sites never passed it — so "who did this, from
   * where" was NULL for every event except the two authz-denial paths and
   * one folders route. That included AUTH_LOGIN and AUTH_LOGOUT, the two
   * rows an incident response actually starts from. Threading `req` to 177
   * call sites is not the answer; the ALS context that already solves this
   * for tenantId is.
   *
   * An explicit `input.sourceIp` still wins, so the call sites that pass one
   * keep their exact behaviour, and a write from a worker (no request
   * context) stays NULL as before.
   */
  const sourceIp = input.platformAdminMasked ? null : (input.sourceIp ?? getRequestSourceIp() ?? null);
  // R-02: which of this tenant's parallel chains this row joins. Chosen once
  // here so the lock key, the tip read and the inserted row all agree.
  const chainShard = pickChainShard();
  const cacheKey = chainCacheKey(tenantId, chainShard);

  const persist = async (tx: Transaction) => {
    // Per-CHAIN advisory lock: serializes writes within one hash chain (the
    // actual invariant that must hold) without blocking other tenants' writes
    // — or, since R-02, other shards of this same tenant's trail. The lock is
    // held until this transaction commits, which is what guarantees the
    // previous writer on this chain has committed before we read its tip
    // below; sharding is what keeps that from serialising the whole tenant.
    await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext(:lockKey)::bigint)`, {
      transaction: tx,
      replacements: { lockKey: cacheKey },
    });

    // Cold-start detection ONLY: a cache miss triggers the one-time defensive
    // sequence self-heal below. The cached tip is deliberately NOT used as the
    // previousHash source — see the doc comment above for why.
    const cached = await getChainCacheEntry(cacheKey);
    if (!cached && !auditSequenceHealAttempted) {
      auditSequenceHealAttempted = true;
      // Self-heal the shared sequence (defensive, only needed once - e.g. after
      // a restart or if rows were bulk-loaded out of band). Runs OUTSIDE the
      // ambient transaction and tolerates failure: setval() needs UPDATE on the
      // sequence, which a least-privilege app role (edams_app) may not hold, and
      // a failed statement inside the tx would poison the whole audited request
      // (42501 → 25P02, every subsequent query fails). The heal is advisory;
      // the nextval() below is what must succeed.
      //
      // FIX (found by test-scripts/verify-audit-chain-sharding.ts): this used
      // to target GREATEST(MAX(sequence_number), 1), which can REWIND the
      // sequence. nextval() is issued inside each writer's transaction, so
      // between a writer taking 1585 and committing it, MAX(sequence_number)
      // is still 1584 — and a self-heal in that window resets the sequence so
      // the next writer is handed 1585 as well. That is a duplicate key on
      // audit_logs_sequence_number_unique, i.e. a 500 on an audited write.
      //
      // R-02 made this reproducible (more cache keys, so more cold starts to
      // interleave with live traffic), but it was always reachable: any Redis
      // flush or eviction during normal traffic produced the same miss, the
      // same rewind and the same collision.
      //
      // pg_sequence_last_value() in the GREATEST makes the heal monotonic — it
      // can only ever move the sequence forward, never back onto a value some
      // in-flight transaction has already been handed. It is NULL for a
      // sequence nobody has called nextval() on yet, hence the COALESCE.
      try {
        await sequelize.query(
          `SELECT setval(
            pg_get_serial_sequence('audit_logs','sequence_number'),
            GREATEST(
              COALESCE((SELECT MAX(sequence_number) FROM audit_logs), 0)::bigint,
              COALESCE(pg_sequence_last_value(pg_get_serial_sequence('audit_logs','sequence_number')::regclass), 0)::bigint,
              1
            ),
            (SELECT COUNT(*) > 0 FROM audit_logs)
          )`,
          { type: QueryTypes.SELECT },
        );
      } catch (error) {
        logger.warn({ error }, "audit sequence self-heal skipped (insufficient privilege?)");
      }
    }

    // Always derive the chain tip from the committed DB state, under the
    // per-chain advisory lock we already hold. This is what makes the chain
    // correct under concurrency: the lock guarantees the previous writer on
    // this chain has already committed (and released the lock) before we read,
    // so this findOne sees its row. Reading the tip from Redis instead opened a
    // race — a writer that acquired the lock in the window between a prior
    // writer's COMMIT and its post-commit cache update would read a stale (or
    // rolled-back/poisoned) tip and durably commit a row that skips the real
    // last entry, which verifyAuditChain then reports as tampering.
    //
    // R-02: scoped to chainShard as well as tenantId. This MUST match the
    // shard written below and the grouping verifyAuditChain uses, or rows
    // would link to a predecessor in a different chain and every verification
    // would report linkage breaks. Served by
    // audit_logs_tenant_shard_seq_idx.
    const lastRow = await AuditLog.findOne({
      where: { tenantId, chainShard },
      order: [["sequenceNumber", "DESC"]],
      transaction: tx,
    });
    const last = lastRow
      ? { sequenceNumber: lastRow.sequenceNumber, entryHash: lastRow.entryHash }
      : null;

    const timestamp = new Date();

    const seqRows = await sequelize.query<{ sequence_number: string }>(
      `SELECT nextval(pg_get_serial_sequence('audit_logs','sequence_number')) AS sequence_number`,
      { transaction: tx, type: QueryTypes.SELECT },
    );
    const sequenceNumber = BigInt(seqRows[0].sequence_number);

    // S5-08: Pseudonymize PII at write time
    const actionDetails = pseudonymizePII(input.actionDetails);
    const actionDetailsJson = JSON.stringify(actionDetails);

    const previousHash = last?.entryHash ?? null;

    // S5-07: Use HMAC-SHA256 instead of plain SHA256 for tamper detection
    const hmacKey = config.AUDIT_HMAC_SECRET;
    const chainData = `${sequenceNumber}${timestamp.toISOString()}${input.eventType}${input.userId ?? ""}${input.documentId ?? ""}${actionDetailsJson}${previousHash ?? ""}`;

    const entryHash = crypto
      .createHmac("sha256", hmacKey)
      .update(chainData)
      .digest("hex");

    const created = await AuditLog.create({
      eventType: input.eventType,
      // Tenant stamped from explicit input, else the request's ALS context.
      // Worker-context writes without either stay NULL (system-level events).
      tenantId,
      userId: input.userId ?? null,
      userRole: input.userRole ?? null,
      sourceIp,
      sessionId: input.sessionId ?? null,
      documentId: input.documentId ?? null,
      documentVersion: input.documentVersion ?? null,
      actionDetails: actionDetailsJson,
      previousState: input.previousState ?? null,
      newState: input.newState ?? null,
      isSuccess: input.isSuccess ?? true,
      errorCode: input.errorCode ?? null,
      sequenceNumber,
      timestamp,
      // R-02. Deliberately NOT part of chainData above: hashing it would
      // invalidate every pre-existing row's entryHash. Moving a row between
      // shards is still caught twice over, as a linkage break in the chain it
      // left and in the chain it joined.
      chainShard,
      previousHash,
      entryHash
    }, { transaction: tx });

    // See module doc comment: afterCommit is the only hook that fires at the
    // true commit point whether this call reused an ambient request
    // transaction or opened its own.
    tx.afterCommit(() => {
      void setChainCacheEntry(cacheKey, { sequenceNumber, entryHash }).catch((err) => {
        logger.warn({ err, cacheKey }, "Failed to update audit chain cache after commit");
      });
    });

    return created;
  };

  return transaction ? persist(transaction) : runInTransaction(persist);
}

/**
 * S5-08: PII Pseudonymization
 * Pseudonymize email addresses and sensitive fields in audit action details
 */
function pseudonymizePII(actionDetails: unknown): unknown {
  if (!actionDetails || typeof actionDetails !== "object") {
    return actionDetails;
  }

  const data = actionDetails as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Pseudonymize email addresses
    if (typeof value === "string" && value.includes("@")) {
      const [local, domain] = value.split("@");
      result[key] = `${local.substring(0, 2)}***@${domain}`;
    }
    // Pseudonymize fields with "name" or "fullName"
    else if ((key.toLowerCase().includes("name") || key.toLowerCase().includes("fullname")) && typeof value === "string") {
      result[key] = value.substring(0, 2) + "***";
    }
    // Recursively pseudonymize nested objects
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = pseudonymizePII(value);
    }
    // Keep arrays and other values as is
    else {
      result[key] = value;
    }
  }

  return result;
}

// FIX (Finding 9): this used to be a single unbounded AuditLog.findAll() with
// no limit, loading a tenant's (or the whole system's) entire audit history
// into memory on every integrity check. Verified in batches instead, ordered
// by sequence number via keyset pagination (WHERE sequence_number > cursor,
// not OFFSET — avoids the OFFSET re-scan cost on a large table). Chain state
// (last verified sequence number + hash) is carried PER TENANT across batch
// boundaries in `chainState`, so a broken linkage that straddles two batches
// (the last row of one batch and the first row of the next, for the same
// tenant) is still caught correctly.
const VERIFY_BATCH_SIZE = 1000;

/**
 * S5-07: Verify Audit Chain Integrity
 * Verifies HMAC chain from start to a given sequence number or end
 *
 * writeAuditLog() links previousHash within each CHAIN — a (tenant,
 * chain_shard) pair (see the chain locking/caching doc comment above) —
 * while sequence_number is a single sequence shared by everything. So
 * sequence numbers are NOT expected to be gap-free or contiguous within a
 * chain: other tenants' and other shards' rows interleave in sequence order.
 * Verification therefore tracks each chain's state independently while
 * scanning the overall sequence order once: hash correctness, strictly
 * increasing sequence numbers, and previousHash linkage to that same
 * chain's prior entry.
 *
 * R-02: the state key was the tenant alone before shards existed. Every
 * legacy row has chain_shard 0, so those chains are unchanged and continue
 * to verify exactly as before; each additional shard is a separate chain
 * whose first row legitimately has a NULL previousHash, the same as any
 * chain genesis row.
 *
 * FIX (2026-09-03 audit): this used to RETURN at the first break it found, so
 * a single historical break — e.g. one left by the pre-fix Redis-tip race
 * documented in writeAuditLog's comment above — permanently pinned the answer
 * to `valid:false, brokenAt:<that old row>` and made the verifier blind to
 * every subsequent tamper: an attacker editing a row after the known break
 * changed nothing about the output. It now scans the whole range, records up
 * to MAX_REPORTED_BREAKS of them in `breaks`, and resynchronises the per-tenant
 * chain state to the offending row so one break doesn't cascade into a false
 * report on every later row. `valid`/`brokenAt` keep their old meaning (first
 * break) so existing callers are unaffected; `breaks` and `totalVerified` are
 * additive, and let an operator baseline known-historical damage and alert on
 * anything new.
 */
const MAX_REPORTED_BREAKS = 50;

export type AuditChainBreak = {
  sequenceNumber: string;
  tenantId: string | null;
  kind: "hash" | "ordering" | "linkage";
  message: string;
  /** The stored hashes of the offending row. An acknowledgement is pinned to them. */
  entryHash?: string;
  previousHash?: string | null;
  /** Set when a recorded acknowledgement matches this break (same sequence, kind and stored hashes). */
  acknowledged?: { by: string; at: string; reason: string };
};

type AckRow = { tenant_id: string; sequence_number: string; kind: string; entry_hash: string; previous_hash: string | null; reason: string; acknowledged_by: string; acknowledged_at: Date };

/** Recorded acknowledgements (audit_chain_acknowledgements), for one tenant or, when `tenantId` is undefined, every tenant
 *  (the daily worker). A read failure is treated as "none": the chain then reads as broken, never as healthier than it is. */
async function loadChainAcknowledgements(tenantId?: string | null): Promise<AckRow[]> {
  try {
    const rows = await sequelize.query<AckRow>(
      `SELECT tenant_id, sequence_number::text AS sequence_number, kind, entry_hash, previous_hash, reason, acknowledged_by::text AS acknowledged_by, acknowledged_at
         FROM audit_chain_acknowledgements ${tenantId ? "WHERE tenant_id = :tenantId" : ""}`,
      { replacements: { tenantId }, type: QueryTypes.SELECT },
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.warn({ err }, "could not read audit chain acknowledgements; treating the chain as unacknowledged");
    return [];
  }
}

/** Mark the breaks that a recorded acknowledgement still covers. The match is on sequence, kind AND the row's stored
 *  hashes, so a row altered after it was acknowledged is a new, unexplained break again. */
function applyAcknowledgements(breaks: AuditChainBreak[], acks: AckRow[]): void {
  for (const b of breaks) {
    const hit = acks.find((a) =>
      a.sequence_number === b.sequenceNumber && a.kind === b.kind && a.tenant_id === (b.tenantId ?? "") &&
      a.entry_hash === (b.entryHash ?? "") && (a.previous_hash ?? null) === (b.previousHash ?? null));
    if (hit) b.acknowledged = { by: hit.acknowledged_by, at: new Date(hit.acknowledged_at).toISOString(), reason: hit.reason };
  }
}

export async function verifyAuditChain(
  upToSequence?: bigint,
  tenantId?: string | null,
): Promise<{
  valid: boolean;
  brokenAt?: bigint;
  message: string;
  breaks: AuditChainBreak[];
  totalVerified: number;
  /** Breaks that a recorded acknowledgement explains. `valid` ignores these; `breaks` still lists them. */
  acknowledgedBreaks: number;
}> {
  const hmacKey = config.AUDIT_HMAC_SECRET;

  // Per-CHAIN { lastSequenceNumber, lastEntryHash }, keyed by (tenant, shard)
  // and updated as each batch is scanned — this is what lets chain linkage be
  // checked correctly across a batch boundary without holding every row of
  // every batch in memory at once.
  const chainState = new Map<string, { sequenceNumber: bigint; entryHash: string }>();

  let cursor: bigint | null = null; // exclusive keyset lower bound
  let totalVerified = 0;
  const breaks: AuditChainBreak[] = [];
  const recordBreak = (b: AuditChainBreak) => {
    if (breaks.length < MAX_REPORTED_BREAKS) breaks.push(b);
  };

  for (;;) {
    const sequenceWhere: Record<symbol, bigint> = {};
    if (cursor !== null) {
      sequenceWhere[Op.gt] = cursor;
    }
    if (upToSequence !== undefined) {
      sequenceWhere[Op.lte] = upToSequence;
    }
    const where: Record<string, unknown> = {};
    if (Object.getOwnPropertySymbols(sequenceWhere).length > 0) {
      where.sequenceNumber = sequenceWhere;
    }
    if (tenantId !== undefined) {
      where.tenantId = tenantId;
    }

    const batch = await AuditLog.findAll({
      where,
      order: [["sequenceNumber", "ASC"]],
      limit: VERIFY_BATCH_SIZE,
      raw: true,
    });

    if (batch.length === 0) {
      break;
    }

    for (const entry of batch) {
      // R-02: one chain per (tenant, shard). `tenantKey` stays in the
      // reported messages so operator-facing output is unchanged for the
      // single-shard case; the STATE key carries the shard.
      const tenantKey = entry.tenantId ?? "__SYSTEM__";
      const chainKey = `${tenantKey}#${entry.chainShard ?? 0}`;
      const chainData = `${entry.sequenceNumber}${new Date(entry.timestamp).toISOString()}${entry.eventType}${entry.userId ?? ""}${entry.documentId ?? ""}${entry.actionDetails}${entry.previousHash ?? ""}`;

      const expectedHash = crypto
        .createHmac("sha256", hmacKey)
        .update(chainData)
        .digest("hex");

      if (entry.entryHash !== expectedHash) {
        logger.error({ sequenceNumber: entry.sequenceNumber, tenantId: tenantKey, expected: expectedHash, actual: entry.entryHash }, "Audit chain integrity violation detected");
        recordBreak({
          sequenceNumber: String(entry.sequenceNumber),
          tenantId: entry.tenantId ?? null,
          kind: "hash",
          message: `Chain broken at sequence ${entry.sequenceNumber} (tenant ${tenantKey})`,
          entryHash: entry.entryHash ?? "",
          previousHash: entry.previousHash ?? null,
        });
        // A row whose own hash doesn't verify can't be trusted as the next
        // row's predecessor either — resync and keep scanning so later,
        // independent damage is still reported.
        chainState.set(chainKey, { sequenceNumber: BigInt(entry.sequenceNumber), entryHash: entry.entryHash ?? "" });
        totalVerified++;
        continue;
      }

      // Verify per-tenant chain linkage and strictly increasing sequence,
      // against the last state seen for this tenant (whether that came from
      // earlier in this same batch or from a prior batch).
      const prev = chainState.get(chainKey);
      if (prev) {
        if (BigInt(entry.sequenceNumber) <= prev.sequenceNumber) {
          logger.error({ sequenceNumber: entry.sequenceNumber, previousSequence: prev.sequenceNumber, tenantId: tenantKey }, "Audit chain sequence ordering violation detected");
          recordBreak({
            sequenceNumber: String(entry.sequenceNumber),
            tenantId: entry.tenantId ?? null,
            kind: "ordering",
            message: `Chain sequence ordering violated at sequence ${entry.sequenceNumber} (tenant ${tenantKey})`,
            entryHash: entry.entryHash ?? "",
            previousHash: entry.previousHash ?? null,
          });
        } else if (entry.previousHash !== prev.entryHash) {
          logger.error({ sequenceNumber: entry.sequenceNumber, tenantId: tenantKey }, "Audit chain linkage broken");
          recordBreak({
            sequenceNumber: String(entry.sequenceNumber),
            tenantId: entry.tenantId ?? null,
            kind: "linkage",
            message: `Chain linkage broken at sequence ${entry.sequenceNumber} (tenant ${tenantKey})`,
            entryHash: entry.entryHash ?? "",
            previousHash: entry.previousHash ?? null,
          });
        }
      }

      chainState.set(chainKey, { sequenceNumber: BigInt(entry.sequenceNumber), entryHash: entry.entryHash });
      totalVerified++;
    }

    cursor = BigInt(batch[batch.length - 1].sequenceNumber);
    if (batch.length < VERIFY_BATCH_SIZE) {
      break; // last (partial) page
    }
  }

  if (totalVerified === 0) {
    return { valid: true, message: "No audit entries to verify", breaks: [], totalVerified: 0, acknowledgedBreaks: 0 };
  }

  if (breaks.length > 0) {
    applyAcknowledgements(breaks, await loadChainAcknowledgements(tenantId));
    const open = breaks.filter((b) => !b.acknowledged);
    const acknowledgedBreaks = breaks.length - open.length;
    if (open.length === 0) {
      return {
        valid: true,
        message:
          `Verified ${totalVerified} audit entries. ${acknowledgedBreaks} historical break(s) are on record and acknowledged ` +
          `(first: ${breaks[0].message}); no unexplained break.`,
        breaks,
        totalVerified,
        acknowledgedBreaks,
      };
    }
    return {
      valid: false,
      brokenAt: BigInt(open[0].sequenceNumber),
      message:
        `${open.length}${breaks.length === MAX_REPORTED_BREAKS ? "+" : ""} unexplained chain break(s) across ` +
        `${totalVerified} entries; first: ${open[0].message}` +
        (acknowledgedBreaks > 0 ? ` (${acknowledgedBreaks} more are acknowledged historical breaks)` : ""),
      breaks,
      totalVerified,
      acknowledgedBreaks,
    };
  }

  return {
    valid: true,
    message: `Verified ${totalVerified} audit entries successfully`,
    breaks: [],
    totalVerified,
    acknowledgedBreaks: 0,
  };
}

const ackInputSchema = z.object({
  sequenceNumber: z.string().regex(/^\d{1,18}$/, "sequenceNumber must be a whole number"),
  kind: z.enum(["hash", "ordering", "linkage"]),
  reason: z.string().trim().min(20, "Say why this break is known and harmless (at least 20 characters)").max(2000),
});

/** Record that a break the verifier reports is known, explained and historical. Only a break that is CURRENTLY reported
 *  for this tenant can be acknowledged (so nothing can be pre-acknowledged), it is pinned to the row's stored hashes,
 *  and the acknowledgement is itself an audit event appended to the chain. The break stays listed; nothing is rewritten. */
export async function acknowledgeAuditChainBreak(input: unknown, user: { userId: string; role?: string; tenantId: string }) {
  const data = ackInputSchema.parse(input);
  const result = await verifyAuditChain(undefined, user.tenantId);
  const target = result.breaks.find((b) => b.sequenceNumber === data.sequenceNumber && b.kind === data.kind);
  if (!target) throw new AppError(404, "ERR-CHAIN-BREAK-NOT-FOUND", "That break is not currently reported for this tenant");
  if (target.acknowledged) throw new AppError(409, "ERR-CHAIN-BREAK-ACKNOWLEDGED", "That break is already acknowledged");
  await sequelize.query(
    `INSERT INTO audit_chain_acknowledgements (tenant_id, sequence_number, kind, entry_hash, previous_hash, reason, acknowledged_by)
     VALUES (:tenantId, :seq, :kind, :entryHash, :previousHash, :reason, :userId)
     ON CONFLICT (tenant_id, sequence_number, kind) DO UPDATE
       SET entry_hash = EXCLUDED.entry_hash, previous_hash = EXCLUDED.previous_hash, reason = EXCLUDED.reason,
           acknowledged_by = EXCLUDED.acknowledged_by, acknowledged_at = NOW()`,
    { replacements: { tenantId: user.tenantId, seq: data.sequenceNumber, kind: data.kind, entryHash: target.entryHash ?? "", previousHash: target.previousHash ?? null, reason: data.reason, userId: user.userId }, type: QueryTypes.INSERT },
  );
  await writeAuditLog({
    eventType: "AUDIT_CHAIN_BREAK_ACKNOWLEDGED" as AuditEventType,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { sequenceNumber: data.sequenceNumber, kind: data.kind, reason: data.reason },
  });
  return verifyAuditChain(undefined, user.tenantId);
}
