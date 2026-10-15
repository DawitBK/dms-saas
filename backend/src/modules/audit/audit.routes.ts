// SPRINT-2/5: switch route protection to permission middleware and keep audit immutability hardening aligned.
import { restrictAuditToVisibleActors } from '../../shared/platformAdmin.js';
import { Router } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { requireACL } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AuditLog, User } from '../../infrastructure/database/index.js';
import { acknowledgeAuditChainBreak, verifyAuditChain } from './audit.service.js';
import { parseAuditExportQuery } from './auditExportQuery.js';
import { toCsv } from '../../shared/csv.js';

export const auditRoutes = Router();

auditRoutes.get(
  '/',
  requirePermission(PERMISSIONS.AUDIT_READ),
  asyncHandler(async (req, res) => {
    // skip/take follow the same convention as GET /documents (documents.routes.ts).
    // Both are only parsed (and pagination only applied) when the caller
    // actually passes them — callers that don't (the document-detail history
    // tab, the main dashboard widget, the integrity-check panel's count) keep
    // getting the previous behavior: tenant-scoped, newest-first, capped at 100.
    const skip = req.query.skip !== undefined ? Number(req.query.skip) : 0;
    const take = req.query.take !== undefined ? Math.min(Number(req.query.take), 100) : 100;
    const eventType = req.query.eventType ? String(req.query.eventType) : undefined;
    const q = req.query.q ? String(req.query.q).trim() : undefined;

    // Tenant-scoped: pre-migration rows (tenant_id NULL) are not exposed.
    const where: Record<string | symbol, unknown> = { tenantId: req.user!.tenantId };
    if (eventType) where.eventType = eventType;
    if (q) {
      // eventType is text, so a substring ILIKE is safe; userId/documentId are
      // UUID columns (ILIKE on those throws a Postgres type error unless cast),
      // so only match them when the query is itself a full UUID — matches
      // exactly what the previous client-side `.includes()` search could
      // realistically hit for those two fields.
      const orConds: Record<string, unknown>[] = [{ eventType: { [Op.iLike]: `%${q}%` } }];
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (UUID_RE.test(q)) {
        orConds.push({ userId: q }, { documentId: q });
      }
      where[Op.or] = orConds;
    }
    await restrictAuditToVisibleActors(where, req.user!.userId);

    const [logs, total] = await Promise.all([
      AuditLog.findAll({
        where,
        order: [['sequenceNumber', 'DESC']],
        offset: skip,
        limit: take,
      }),
      AuditLog.count({ where }),
    ]);

    const serialized = logs.map((log) => {
      const plain = log.toJSON();
      return {
        ...plain,
        sequenceNumber: plain.sequenceNumber?.toString() ?? '0',
      };
    });

    res.json({ data: serialized, total, skip, take });
  }),
);

auditRoutes.get(
  '/verify-integrity',
  requirePermission(PERMISSIONS.AUDIT_READ),
  asyncHandler(async (req, res) => {
    // Tenant-scoped like every sibling route here — unscoped, this used to
    // scan and HMAC every tenant's rows, leaking another tenant's identifier
    // in `message` on a broken chain (Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #4) and
    // costing a full-table scan per call to a caller who only holds
    // AUDIT_READ for their own tenant.
    const result = await verifyAuditChain(undefined, req.user!.tenantId);
    res.json({
      valid: result.valid,
      brokenAtSequence: result.brokenAt?.toString() ?? null,
      message: result.message,
      // Every break found, not just the first — so an operator can baseline
      // known-historical damage and still detect anything new after it (see
      // verifyAuditChain's comment).
      breaks: result.breaks,
      totalVerified: result.totalVerified,
      acknowledgedBreaks: result.acknowledgedBreaks,
    });
  }),
);

// Record that a reported break is known, explained and historical. Nothing is rewritten; the break stays listed.
// Administrative: an auditor who can READ the log must not be able to explain a break away.
auditRoutes.post(
  '/chain-acknowledgements',
  requirePermission(PERMISSIONS.OPERATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    const result = await acknowledgeAuditChainBreak(req.body, req.user!);
    res.status(201).json({
      valid: result.valid,
      brokenAtSequence: result.brokenAt?.toString() ?? null,
      message: result.message,
      breaks: result.breaks,
      totalVerified: result.totalVerified,
      acknowledgedBreaks: result.acknowledgedBreaks,
    });
  }),
);

// S6-03: Audit log export (CSV or JSON)
auditRoutes.get(
  '/export',
  requirePermission(PERMISSIONS.AUDIT_READ),
  asyncHandler(async (req, res) => {
    // Bounds and shape live in auditExportQuery.ts so they can be unit-tested
    // without the app + a database behind authenticate/tenantContext. All four
    // of these were previously taken on trust — see that file for what each
    // one allowed, the `limit` ceiling being the one that could take the
    // process down.
    const { format, limit, eventType, from, to } = parseAuditExportQuery(
      req.query as Record<string, unknown>,
    );

    const where: Record<string, unknown> = { tenantId: req.user!.tenantId };
    if (eventType) where.eventType = eventType;
    if (from || to) {
      const { Op } = await import('sequelize');
      where.timestamp = {};
      if (from)
        (where.timestamp as Record<string, unknown>)[
          Op.gte as unknown as string
        ] = from;
      if (to)
        (where.timestamp as Record<string, unknown>)[
          Op.lte as unknown as string
        ] = to;
    }

    await restrictAuditToVisibleActors(where, req.user!.userId);
    const logs = await AuditLog.findAll({
      where,
      order: [['sequenceNumber', 'ASC']],
      limit,
      raw: true,
    });

    if (format === 'json') {
      const serialized = logs.map((l: any) => ({
        ...l,
        sequenceNumber: String(l.sequenceNumber),
      }));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-export-${Date.now()}.json"`,
      );
      res.json({ data: serialized, total: serialized.length });
      return;
    }

    if (format === 'pdf') {
      const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const PAGE_W = 792, PAGE_H = 612; // Letter landscape
      const MARGIN = 36, COL_W = [50, 90, 130, 90, 60, 60, 60, 60, 40];
      const HEADERS = ['Seq#', 'Timestamp', 'Event', 'UserId', 'Role', 'DocId', 'Prev', 'Next', 'OK'];
      const KEYS: string[] = ['sequenceNumber', 'timestamp', 'eventType', 'userId', 'userRole', 'documentId', 'previousState', 'newState', 'isSuccess'];

      let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;

      const addHeader = () => {
        page.drawText('DMS Audit Log Export', { x: MARGIN, y, font: boldFont, size: 14, color: rgb(0.1, 0.1, 0.5) });
        y -= 20;
        page.drawText(`Generated: ${new Date().toISOString()} | Records: ${logs.length}`, { x: MARGIN, y, font, size: 8, color: rgb(0.4, 0.4, 0.4) });
        y -= 16;
        let x = MARGIN;
        HEADERS.forEach((h, i) => {
          page.drawRectangle({ x, y: y - 14, width: COL_W[i], height: 16, color: rgb(0.15, 0.25, 0.5) });
          page.drawText(h, { x: x + 2, y: y - 10, font: boldFont, size: 7, color: rgb(1, 1, 1) });
          x += COL_W[i];
        });
        y -= 18;
      };

      addHeader();
      let rowIdx = 0;
      for (const l of logs as any[]) {
        if (y < MARGIN + 20) {
          page = pdfDoc.addPage([PAGE_W, PAGE_H]);
          y = PAGE_H - MARGIN;
          addHeader();
        }
        const bg = rowIdx % 2 === 0 ? rgb(0.97, 0.97, 0.97) : rgb(1, 1, 1);
        let x = MARGIN;
        KEYS.forEach((k, i) => {
          const v = l[k];
          let s = v == null ? '' : String(v);
          if (k === 'timestamp' && v) s = new Date(v).toISOString().replace('T', ' ').slice(0, 19);
          if (s.length > 14) s = s.slice(0, 13) + '…';
          page.drawRectangle({ x, y: y - 10, width: COL_W[i], height: 12, color: bg });
          page.drawText(s, { x: x + 2, y: y - 8, font, size: 6, color: rgb(0.1, 0.1, 0.1) });
          x += COL_W[i];
        });
        y -= 12;
        rowIdx++;
      }

      const pdfBytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="audit-export-${Date.now()}.pdf"`);
      res.send(Buffer.from(pdfBytes));
      return;
    }

    // CSV (default)
    const headers = [
      'sequenceNumber',
      'timestamp',
      'eventType',
      'userId',
      'userRole',
      'sourceIp',
      'documentId',
      'previousState',
      'newState',
      'isSuccess',
      'errorCode',
      'entryHash',
    ];
    // shared/csv.ts, not a local escaper: the previous one quoted a field only
    // when it contained a comma, so a newline anywhere in an audit value split
    // one row into two in the tamper-evidence export itself.
    const csv = toCsv(
      headers,
      logs.map((l: any) => headers.map((h) => (l as Record<string, unknown>)[h])),
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-export-${Date.now()}.csv"`,
    );
    res.send(csv);
  }),
);

// S6-03: Audit log for specific document. Platform audit finding 4.2: this
// route had no ACL check, exposing a document's full activity trail to any
// AUDIT_READ holder even when their folder ACL would hide the document
// itself — fixed to match documents.routes.ts's :id/history equivalent.
auditRoutes.get(
  '/document/:documentId',
  requirePermission(PERMISSIONS.AUDIT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read', paramName: 'documentId' }),
  asyncHandler(async (req, res) => {
    const logs = await AuditLog.findAll({
      where: await restrictAuditToVisibleActors(
        { documentId: String(req.params.documentId), tenantId: req.user!.tenantId },
        req.user!.userId,
      ),
      order: [['sequenceNumber', 'ASC']],
      limit: 1000,
      include: [{ model: User, as: 'actor', attributes: ['id', 'firstName', 'lastName', 'email'] }],
    });
    const serialized = logs.map((l: any) => {
      const plain = l.get({ plain: true });
      return { ...plain, sequenceNumber: String(plain.sequenceNumber) };
    });
    res.json({ data: serialized });
  }),
);
