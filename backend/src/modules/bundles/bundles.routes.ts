import { Router } from 'express';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import {
  addBundleItem,
  addBundleItems,
  compileBundle,
  createBundle,
  deleteBundle,
  updateBundle,
  getBundleDetail,
  listBundles,
  removeBundleItem,
  reorderBundleItems,
} from './bundles.service.js';

export const bundleRoutes = Router();

bundleRoutes.get(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const take = Math.min(100, Math.max(1, Number(req.query.take) || 50));
    res.json(await listBundles(req.user!, skip, take));
  }),
);

bundleRoutes.post(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.status(201).json(await createBundle(req.body ?? {}, req.user!))),
);

bundleRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await getBundleDetail(String(req.params.id), req.user!))),
);

bundleRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await updateBundle(String(req.params.id), req.body ?? {}, req.user!))),
);

bundleRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await deleteBundle(String(req.params.id), req.user!))),
);

bundleRoutes.post(
  '/:id/items',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.status(201).json(await addBundleItem(String(req.params.id), req.body ?? {}, req.user!))),
);

bundleRoutes.patch(
  '/:id/items/reorder',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await reorderBundleItems(String(req.params.id), req.body?.itemIds ?? [], req.user!))),
);

bundleRoutes.delete(
  '/:id/items/:itemId',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await removeBundleItem(String(req.params.id), String(req.params.itemId), req.user!))),
);

bundleRoutes.post(
  '/:id/compile',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.json(await compileBundle(String(req.params.id), req.user!))),
);

bundleRoutes.post(
  '/:id/items/bulk',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => res.status(201).json(await addBundleItems(String(req.params.id), req.body ?? {}, req.user!))),
);
