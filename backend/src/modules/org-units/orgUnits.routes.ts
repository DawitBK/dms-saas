// CAMS organizational units — HQ / branches / outlets / sister companies.
// One tenant hosts the whole Group; org units are the CAMS archive spaces.
//
// Org units are FLAT siblings directly under the tenant — HQ, each branch,
// outlet, and sister company sit at the same level, the same way sister
// companies sit alongside each other rather than inside one another. Only
// Department nests under an OrgUnit (via orgUnitId), and only Folder nests
// under a Department. `parent_unit_id` remains on the org_units table (kept
// for schema stability; nothing else references it — see associations.ts)
// but the API never sets or accepts it, so org-unit-to-org-unit nesting can
// no longer be created. See migration 20260707000001-flatten-org-units.sql
// for the one-time fix that flattened previously-nested units.

import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../core/AppError.js';
import { OrgUnit } from '../../infrastructure/database/index.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { getVisibleOrgUnitIds } from '../departments/departments.service.js';

export const orgUnitsRoutes = Router();

const createSchema = z.object({
  code: z.string().min(2).max(30).regex(/^[A-Z0-9-]+$/, 'Code must be uppercase letters, digits, and dashes'),
  name: z.string().min(1).max(255),
  unitType: z.enum(['HQ', 'BRANCH', 'OUTLET', 'SISTER_COMPANY']),
  // Masthead override on letter PDFs/cover sheets; null/empty = group default.
  letterheadTitle: z.string().max(120).nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  isActive: z.boolean().optional(),
  letterheadTitle: z.string().max(120).nullish(),
});

// FIX 2026-09-23: scoping used to be OPT-IN via `?scope=mine`, defaulting to
// the full tenant-wide list for any caller that didn't pass it — same class
// of bug as departments.routes.ts's GET / (see its FIX comment for the live
// confirmation: a genuine DEPT_MANAGER-only token with no bypass permission
// got back every row with no query param). Scoping is now the DEFAULT;
// `?scope=mine` is still accepted as a harmless no-op for existing callers.
// ACL_BYPASS_ADMIN or DOCUMENT_READ_ALL (RECORDS_OFFICER/AUDITOR oversight)
// still get the unfiltered list.
orgUnitsRoutes.get(
  '/',
  requirePermission(PERMISSIONS.ORG_UNIT_READ),
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const perms = req.user!.permissions;
    const scoped = !(perms.includes(PERMISSIONS.ACL_BYPASS_ADMIN) || perms.includes(PERMISSIONS.DOCUMENT_READ_ALL));
    const visibleIds = scoped ? await getVisibleOrgUnitIds(req.user!.tenantId, req.user!.userId) : undefined;
    if (visibleIds && visibleIds.size === 0) {
      res.json({ data: [] });
      return;
    }
    const units = await OrgUnit.findAll({
      where: {
        tenantId: req.user!.tenantId,
        ...(includeInactive ? {} : { isActive: true }),
        ...(visibleIds ? { id: { [Op.in]: Array.from(visibleIds) } } : {}),
      },
      order: [['unitType', 'ASC'], ['code', 'ASC']],
    });
    res.json({ data: units });
  }),
);

orgUnitsRoutes.post(
  '/',
  requirePermission(PERMISSIONS.ORG_UNIT_MANAGE),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const existing = await OrgUnit.findOne({ where: { tenantId: req.user!.tenantId, code: data.code } });
    if (existing) throw new AppError(409, 'ERR-ORG-UNIT-EXISTS', `Unit code '${data.code}' already exists`);
    // Org units are always top-level siblings under the tenant — never nested
    // under another org unit (that's what Department is for).
    const unit = await OrgUnit.create({
      tenantId: req.user!.tenantId,
      code: data.code,
      name: data.name,
      unitType: data.unitType,
      letterheadTitle: data.letterheadTitle?.trim() || null,
      parentUnitId: null,
    });
    await writeAuditLog({
      eventType: AUDIT_EVENTS.ORG_UNIT_CREATED,
      userId: req.user!.userId, userRole: req.user!.role,
      actionDetails: { orgUnitId: unit.id, code: unit.code, unitType: unit.unitType },
    });
    res.status(201).json({ data: unit });
  }),
);

orgUnitsRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.ORG_UNIT_MANAGE),
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const unit = await OrgUnit.findOne({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } });
    if (!unit) throw new AppError(404, 'ERR-ORG-UNIT-NOT-FOUND', 'Organizational unit not found');
    const wasActive = unit.isActive;
    await unit.update({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.letterheadTitle !== undefined ? { letterheadTitle: data.letterheadTitle?.trim() || null } : {}),
    });
    await writeAuditLog({
      eventType: wasActive && data.isActive === false ? AUDIT_EVENTS.ORG_UNIT_DEACTIVATED : AUDIT_EVENTS.ORG_UNIT_UPDATED,
      userId: req.user!.userId, userRole: req.user!.role,
      actionDetails: { orgUnitId: unit.id, code: unit.code, changes: data },
    });
    res.json({ data: unit });
  }),
);
