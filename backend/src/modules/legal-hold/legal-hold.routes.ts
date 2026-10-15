// SPRINT-2/5: legal-hold routes must move to permission middleware and remain backed by DB-enforced hold checks.
import { restrictAuditToVisibleActors } from '../../shared/platformAdmin.js';
import { Router } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../core/AppError.js';
import { toCsv } from '../../shared/csv.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';

/** Every audit event that can reference a legal hold — the selective
 *  predicate that keeps the chain-of-custody lookup off a full table scan.
 *  PLACED/RELEASED/ACTIVE are legacy names no current code path writes; they
 *  stay listed so pre-existing history is never dropped from the view. */
const LEGAL_HOLD_AUDIT_EVENTS = [
  AUDIT_EVENTS.LEGAL_HOLD_CREATE,
  AUDIT_EVENTS.LEGAL_HOLD_APPLY,
  AUDIT_EVENTS.LEGAL_HOLD_RELEASE,
  AUDIT_EVENTS.LEGAL_HOLD_PLACED,
  AUDIT_EVENTS.LEGAL_HOLD_RELEASED,
  AUDIT_EVENTS.LEGAL_HOLD_ACTIVE,
];
import {
  createLegalHold,
  getLegalHolds,
  getLegalHold,
  applyHoldToDocuments,
  releaseLegalHold,
} from './legal-hold.service.js';

export const legalHoldRoutes = Router();

legalHoldRoutes.post(
  '/',
  requirePermission(PERMISSIONS.LEGAL_HOLD_MANAGE),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const result = await createLegalHold(user, req.body);
    res.status(201).json({ data: result });
  }),
);

legalHoldRoutes.get(
  '/',
  requirePermission(PERMISSIONS.LEGAL_HOLD_READ),
  asyncHandler(async (req, res) => {
    const holds = await getLegalHolds(req.user!.tenantId);
    res.json({ data: holds });
  }),
);

// S6-03: Legal hold inventory export — must be declared BEFORE /:id to avoid Express matching "export" as the id param
legalHoldRoutes.get(
  '/export',
  requirePermission(PERMISSIONS.LEGAL_HOLD_READ),
  asyncHandler(async (req, res) => {
    const { LegalHold, DocumentLegalHold, Document, User } =
      await import('../../infrastructure/database/index.js');
    const format = (req.query.format as string) ?? 'csv';
    const holds = await LegalHold.findAll({
      // Platform audit finding (2026-08-14, CRITICAL): same cross-tenant leak
      // as getLegalHolds() below — this export had no tenant filter at all.
      where: { tenantId: req.user!.tenantId },
      include: [
        {
          model: User,
          as: 'appliedBy',
          attributes: ['id', 'firstName', 'lastName', 'email'],
        },
        {
          model: DocumentLegalHold,
          as: 'affectedDocuments',
          include: [
            {
              model: Document,
              as: 'document',
              attributes: ['id', 'documentName', 'title', 'status'],
            },
          ],
        },
      ],
      order: [['appliedAt', 'DESC']],
      raw: false,
    });

    if (format === 'json') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="legal-hold-export-${Date.now()}.json"`,
      );
      res.json({ data: holds, total: holds.length });
      return;
    }

    // CSV
    const headers = [
      'id',
      'caseReference',
      'status',
      'custodianName',
      'appliedAt',
      'releasedAt',
      'releaseClosureRef',
      'affectedDocumentCount',
      'description',
    ];
    // shared/csv.ts, not the hand-rolled quoting this used to do: only
    // `description` was quoted, so a comma in `caseReference`,
    // `custodianName` or `releaseClosureRef` — all free text typed by staff —
    // shifted every following column by one for that row, in an export whose
    // whole purpose is producing an e-discovery record someone will rely on.
    const rows = holds.map((h: any) => {
      const plain = h.get ? h.get({ plain: true }) : h;
      return [
        plain.id,
        plain.caseReference,
        plain.status,
        plain.custodianName,
        plain.appliedAt ? new Date(plain.appliedAt).toISOString() : '',
        plain.releasedAt ? new Date(plain.releasedAt).toISOString() : '',
        plain.releaseClosureRef,
        plain.affectedDocuments?.length ?? 0,
        plain.description,
      ];
    });

    const csv = toCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="legal-hold-export-${Date.now()}.csv"`,
    );
    res.send(csv);
  }),
);

// Platform audit finding (2026-08-14, HIGH): these three routes used
// requireACL({resourceType:'legal_hold', ...}) — but nothing anywhere in the
// codebase ever writes an AclEntry row for that resourceType (unlike
// documents/folders, which get one via grantDefaultDocumentAcl).
// resolveACL denies by default with no matching entry, so every one of these
// calls 403'd (AUTHZ_ACL_NO_ENTRY) for every role except SYSTEM_ADMIN
// (the only holder of ACL_BYPASS_ADMIN) — including RECORDS_OFFICER and
// DEPT_MANAGER, both explicitly granted LEGAL_HOLD_MANAGE in
// config/permissions.ts and clearly meant to use this feature. A legal hold
// isn't a per-instance-ACL'd resource the way a document/folder is — access
// is a plain tenant-wide RBAC capability — so the fix is RBAC
// (requirePermission, already present) + tenant scoping (added to the
// service functions above), not a per-resource ACL that nothing ever grants.
legalHoldRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.LEGAL_HOLD_READ),
  asyncHandler(async (req, res) => {
    const hold = await getLegalHold(String(req.params.id), req.user!.tenantId);
    res.json({ data: hold });
  }),
);

legalHoldRoutes.post(
  '/:id/add-documents',
  requirePermission(PERMISSIONS.LEGAL_HOLD_MANAGE),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { documentIds } = req.body;
    if (!Array.isArray(documentIds)) throw new AppError(400, 'ERR-LEGAL-HOLD-VALIDATION', 'Invalid documentIds');
    const result = await applyHoldToDocuments(
      String(req.params.id),
      documentIds,
      user.userId,
      user.tenantId,
      user.role,
    );
    res.json({ data: result });
  }),
);

legalHoldRoutes.post(
  '/:id/release',
  requirePermission(PERMISSIONS.LEGAL_HOLD_MANAGE),
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const { closureRef, reason } = req.body;
    if (!closureRef || !reason) throw new AppError(400, 'ERR-LEGAL-HOLD-VALIDATION', 'Missing closureRef or reason');
    const result = await releaseLegalHold(
      String(req.params.id),
      user.userId,
      user.role,
      closureRef,
      reason,
      user.tenantId,
    );
    res.json({ data: result });
  }),
);

// S6-03: Legal hold history (audit trail for a hold)
legalHoldRoutes.get(
  '/:id/history',
  requirePermission(PERMISSIONS.LEGAL_HOLD_READ),
  asyncHandler(async (req, res) => {
    const { AuditLog } = await import('../../infrastructure/database/index.js');
    // R-05 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): this was a bare
    // `action_details LIKE '%<id>%'` over a TEXT column on audit_logs — the
    // largest, highest-write table in the system — with no other selective
    // predicate. Correct, but a sequential scan of the entire tenant's audit
    // history on every chain-of-custody view: fine at 1.5k rows, unusable at
    // millions.
    //
    // The audit register's own suggestion was a GIN/pg_trgm index on
    // action_details. Deliberately NOT doing that: a trigram index over a
    // whole TEXT column on the hottest write path in the system would be
    // maintained on every single audit insert, and those inserts are already
    // the system-wide write bottleneck (they serialise on a per-tenant
    // advisory lock — R-02). Paying a write cost on every audited operation
    // to speed up a low-traffic admin view is the wrong trade.
    //
    // Instead: constrain by event_type first. Only legal-hold events can ever
    // reference a hold, that set is a tiny fraction of the table, and
    // audit_logs_event_type_idx already exists — so the LIKE now runs over
    // the handful of legal-hold rows rather than everything. No new index and
    // no schema change on the hash-chained table.
    //
    // The whole LEGAL_HOLD_* family is listed, not just the three event types
    // current code writes (CREATE/APPLY/RELEASE), so historical rows written
    // under the older PLACED/RELEASED/ACTIVE names still appear — this must
    // stay a widening of the index path, never a narrowing of the history.
    const logs = await AuditLog.findAll({
      where: await restrictAuditToVisibleActors({
        tenantId: req.user!.tenantId,
        eventType: { [Op.in]: LEGAL_HOLD_AUDIT_EVENTS },
        actionDetails: {
          [Op.like]: `%${String(req.params.id)}%`,
        },
      }, req.user!.userId),
      order: [['timestamp', 'ASC']],
      limit: 1000,
      raw: true,
    });
    const serialized = logs.map((l: any) => ({
      ...l,
      sequenceNumber: String(l.sequenceNumber),
    }));
    res.json({ data: serialized });
  }),
);
