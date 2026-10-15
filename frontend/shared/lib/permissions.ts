// shared/lib/permissions.ts
// Permission string catalog — owned by DMS (the permission names are architecture).
// The role→permission mapping (ROLE_PERMISSIONS) lives on the backend only.
// Frontend gating always uses can(permission) or PermissionGate, never role-string checks.

export const PERMISSIONS = {
  DOCUMENT_READ: 'document:read',
  DOCUMENT_READ_ALL: 'document:read_all',
  DOCUMENT_UPLOAD: 'document:upload',
  DOCUMENT_ARCHIVE: 'document:archive',
  DOCUMENT_PURGE: 'document:purge',
  DOCUMENT_CHECKOUT: 'document:checkout',
  VERSION_MANAGE: 'version:manage',
  FOLDER_CREATE: 'folder:create',
  FOLDER_READ: 'folder:read',
  FOLDER_DELETE: 'folder:delete',
  USER_MANAGE: 'user:manage',
  ROLE_READ: 'role:read',
  ROLE_MANAGE: 'role:manage',
  DEPT_READ: 'department:read',
  DEPT_MANAGE: 'department:manage',
  DOCTYPE_READ: 'doctype:read',
  DOCTYPE_MANAGE: 'doctype:manage',
  AUDIT_READ: 'audit:read',
  WORKFLOW_READ: 'workflow:read',
  WORKFLOW_MANAGE: 'workflow:manage',
  WORKFLOW_APPROVE: 'workflow:approve',
  RETENTION_READ: 'retention:read',
  RETENTION_MANAGE: 'retention:manage',
  LEGAL_HOLD_READ: 'legalhold:read',
  LEGAL_HOLD_MANAGE: 'legalhold:manage',
  SEARCH_READ: 'search:read',
  SEARCH_SCOPE_ALL: 'search:scope_all',
  NOTIFICATION_READ: 'notification:read',
  SIGNING_READ: 'signing:read',
  SIGNING_MANAGE: 'signing:manage',
  // Form-template authoring — split out from DOCTYPE_MANAGE (the tenant's
  // document-type taxonomy) so "can build a form" isn't also "can edit the
  // classification categories" — see backend config/permissions.ts's comment.
  FORM_TEMPLATE_MANAGE: 'formtemplate:manage',
  OPERATIONS_READ: 'operations:read',
  OPERATIONS_MANAGE: 'operations:manage',
  ACL_MANAGE: 'acl:manage',
  ACL_BYPASS_ADMIN: 'acl:bypass_admin',
  TENANT_READ: 'tenant:read',
  TENANT_MANAGE: 'tenant:manage',
  // Cross-tenant platform operator — see backend config/permissions.ts's
  // comment. Gates the "New Tenant" button and sourcing TenantSwitcher's
  // list from every tenant instead of just the signed-in user's own.
  PLATFORM_ADMIN: 'platform:admin',
  // AI usage controls — see backend config/permissions.ts.
  AI_USE: 'ai:use',
  AI_CHAT: 'ai:chat',
  AI_MANAGE: 'ai:manage',
  // CAMS — correspondence
  LETTER_READ: 'letter:read',
  LETTER_READ_ALL: 'letter:read_all',
  LETTER_CREATE: 'letter:create',
  LETTER_REVIEW: 'letter:review',
  LETTER_APPROVE: 'letter:approve',
  LETTER_DISPATCH: 'letter:dispatch',
  LETTER_REGISTER: 'letter:register',
  ORG_UNIT_READ: 'orgunit:read',
  ORG_UNIT_MANAGE: 'orgunit:manage',
  // Unified approval engine + audit stage (SYSTEM-DECISIONS.md D1–D7)
  APPROVAL_SUBMIT: 'approval:submit',
  APPROVAL_DECIDE: 'approval:decide',
  APPROVAL_ADMIN: 'approval:admin',
  AUDIT_STAGE_DECIDE: 'audit-stage:decide',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
