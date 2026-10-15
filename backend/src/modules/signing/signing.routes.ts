import { Router } from 'express';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { requireACL } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { executeSigning } from './signing.service.js';

export const signingRoutes = Router();

// These routes are mounted at /signing in v1/index.ts
// Document-centric signing routes are also added to documents.routes.ts

// Legacy route (kept for backwards compatibility). Platform audit finding
// 4.1: this route was missing the ACL/tenant-access check that
// documents.routes.ts's equivalent (/:id/sign/execute) has always had,
// allowing a SIGNING_MANAGE holder to sign ANY document across tenants and
// folder-ACL boundaries. Fixed by requiring the same document:read ACL.
signingRoutes.post(
  '/:documentId/sign',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  requireACL({ resourceType: 'document', permission: 'document:read', paramName: 'documentId' }),
  asyncHandler(async (req, res) => {
    const { documentId } = req.params;
    if (typeof documentId !== 'string') throw new Error('Invalid documentId');
    const { signingType, consentAcknowledged } = req.body;
    const user = req.user!;
    const result = await executeSigning(
      documentId,
      user,
      signingType ?? 'ELECTRONIC',
      {
        // The IP / user agent on a signature record are non-repudiation evidence, so they come
        // from the connection (req.ip honours only the trusted proxy hop), never from the body —
        // the body values were accepted verbatim and let a signer write any address into it.
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        consentAcknowledged: consentAcknowledged === true,
      },
    );
    res.json(result);
  }),
);
