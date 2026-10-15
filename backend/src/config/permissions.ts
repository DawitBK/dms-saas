export const PERMISSIONS = {
  DOCUMENT_READ: 'document:read',
  DOCUMENT_READ_ALL: 'document:read_all',    // §1: oversight scope — see all docs in tenant
  DOCUMENT_UPLOAD: 'document:upload',
  DOCUMENT_ARCHIVE: 'document:archive',
  DOCUMENT_PURGE: 'document:purge',
  DOCUMENT_CHECKOUT: 'document:checkout',
  VERSION_MANAGE: 'version:manage',           // §1: upload versions, rollback
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
  SEARCH_SCOPE_ALL: 'search:scope_all',       // §1: search across all departments
  NOTIFICATION_READ: 'notification:read',
  SIGNING_READ: 'signing:read',
  SIGNING_MANAGE: 'signing:manage',
  // Form-template authoring (build/edit/submit/approve a template) — split
  // out from DOCTYPE_MANAGE 2026-09-16 so granting "can build a form" doesn't
  // also grant "can create/edit/deactivate the tenant's document-type
  // taxonomy" (forms.routes.ts's template endpoints used to share
  // DOCTYPE_MANAGE with documentTypes.routes.ts's actual doctype CRUD, which
  // meant the only way to let ordinary staff create form templates was to
  // also hand them the classification taxonomy — a much bigger grant than
  // "let anyone build a form template" ever asked for).
  FORM_TEMPLATE_MANAGE: 'formtemplate:manage',
  OPERATIONS_READ: 'operations:read',
  OPERATIONS_MANAGE: 'operations:manage',
  ACL_MANAGE: 'acl:manage',
  ACL_BYPASS_ADMIN: 'acl:bypass_admin',       // §1: super-admin ACL bypass
  TENANT_READ: 'tenant:read',                 // §2: tenant management
  TENANT_MANAGE: 'tenant:manage',             // §2: tenant CRUD
  // §3: platform-level, cross-tenant capability — NOT part of SYSTEM_ADMIN's
  // grant (see PLATFORM_ONLY_PERMISSIONS below). Operates the SaaS platform
  // itself: create tenants, see/manage every tenant's registry entry
  // regardless of active session tenant, and switch into any tenant without
  // holding a user_tenants membership row for it. Deliberately never a
  // stand-alone "registry operator" tier — the one role that holds this
  // (PLATFORM_ADMIN, below) also holds every ordinary permission, i.e. full
  // SYSTEM_ADMIN rights in every tenant, not just platform-registry control.
  PLATFORM_ADMIN: 'platform:admin',

  // AI usage controls (2026-10-04). Sending document text to the external AI
  // provider is a data-egress decision, so it has its own permissions instead
  // of riding on audit:read / document:read:
  //  ai:use    per-document summary + metadata suggestions, form-from-photo
  //  ai:chat   the compliance assistant (also needs audit:read: it reads the
  //            tenant's audit trail)
  //  ai:manage the tenant's AI policy and the usage ledger
  // The tenant policy (aiPolicy.service.ts) narrows these further; a permission
  // never widens what the policy forbids.
  AI_USE: 'ai:use',
  AI_CHAT: 'ai:chat',
  AI_MANAGE: 'ai:manage',

  // CAMS — correspondence
  LETTER_READ: 'letter:read',                 // view letters in own unit archive
  LETTER_READ_ALL: 'letter:read_all',         // Central Archive: view across all org units
  LETTER_CREATE: 'letter:create',             // draft outgoing letters
  LETTER_REVIEW: 'letter:review',             // checker step in maker–checker–approver
  LETTER_APPROVE: 'letter:approve',           // approve & sign (allocates ref number)
  LETTER_DISPATCH: 'letter:dispatch',         // record dispatch / delivery tracking
  LETTER_REGISTER: 'letter:register',         // register incoming letters
  ORG_UNIT_READ: 'orgunit:read',
  ORG_UNIT_MANAGE: 'orgunit:manage',
  // Unified approval engine (SYSTEM-DECISIONS.md D1) — self-service submission
  // for authors, deciding for chain members, admin recovery (reassign/cancel).
  APPROVAL_SUBMIT: 'approval:submit',
  APPROVAL_DECIDE: 'approval:decide',
  APPROVAL_ADMIN: 'approval:admin',
  // Audit stage (D5–D7): deciding PASS/FLAG on items pending audit — distinct
  // from audit:read (reading the audit LOG).
  AUDIT_STAGE_DECIDE: 'audit-stage:decide',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

// Permissions that must never be reachable through an ordinary tenant role's
// blanket grant — see PERMISSIONS.PLATFORM_ADMIN's comment above. Kept as an
// explicit list (not inferred) so adding a future platform-only permission
// to PERMISSIONS can't silently widen SYSTEM_ADMIN again the same way this
// one did before this fix (SYSTEM_ADMIN used to be a bare
// `Object.values(PERMISSIONS)`, so every new permission was implicitly
// granted to every tenant's own admin, platform-scoped or not).
const PLATFORM_ONLY_PERMISSIONS: readonly Permission[] = [PERMISSIONS.PLATFORM_ADMIN];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  // Full SYSTEM_ADMIN rights in every tenant on the platform, PLUS
  // platform:admin — cross-tenant tenant-registry control and the ability to
  // switch into any tenant without a membership row (see tenants.routes.ts's
  // assertOwnTenant bypass and auth.service.ts's switchTenant bypass). This
  // is the one and only role meant to hold PLATFORM_ADMIN; there is no
  // lighter-weight "can operate the platform but isn't SYSTEM_ADMIN
  // everywhere" tier by design.
  PLATFORM_ADMIN: Object.values(PERMISSIONS),
  SYSTEM_ADMIN: Object.values(PERMISSIONS).filter((p) => !PLATFORM_ONLY_PERMISSIONS.includes(p)),
  RECORDS_OFFICER: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.DOCUMENT_UPLOAD,
    // H8: records officers hold document:purge so the two-person destruction
    // rule is exercisable out of the box (a records officer stages, a second
    // officer or a SYSTEM_ADMIN approves). Before this only the single seeded
    // SYSTEM_ADMIN could purge, and approvePurge rejects the same user as both
    // stager and approver — so the rule dead-locked.
    PERMISSIONS.DOCUMENT_PURGE,
    PERMISSIONS.DOCUMENT_ARCHIVE, PERMISSIONS.DOCUMENT_CHECKOUT, PERMISSIONS.VERSION_MANAGE,
    PERMISSIONS.FOLDER_CREATE, PERMISSIONS.FOLDER_READ, PERMISSIONS.FOLDER_DELETE,
    PERMISSIONS.DOCTYPE_READ, PERMISSIONS.DOCTYPE_MANAGE,
    PERMISSIONS.DEPT_READ, PERMISSIONS.AUDIT_READ, PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_MANAGE, PERMISSIONS.WORKFLOW_APPROVE,
    PERMISSIONS.RETENTION_READ, PERMISSIONS.RETENTION_MANAGE,
    PERMISSIONS.LEGAL_HOLD_READ, PERMISSIONS.LEGAL_HOLD_MANAGE, PERMISSIONS.SEARCH_READ,
    PERMISSIONS.SEARCH_SCOPE_ALL, PERMISSIONS.NOTIFICATION_READ,
    PERMISSIONS.SIGNING_READ, PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.LETTER_CREATE,
    PERMISSIONS.LETTER_REGISTER, PERMISSIONS.LETTER_DISPATCH, PERMISSIONS.ORG_UNIT_READ,
    PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN,
    PERMISSIONS.AI_USE, PERMISSIONS.AI_CHAT,
  ],
  DEPT_MANAGER: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_UPLOAD, PERMISSIONS.DOCUMENT_CHECKOUT,
    PERMISSIONS.VERSION_MANAGE, PERMISSIONS.FOLDER_READ, PERMISSIONS.FOLDER_CREATE,
    PERMISSIONS.DOCTYPE_READ, PERMISSIONS.DEPT_READ, PERMISSIONS.DEPT_MANAGE,
    PERMISSIONS.WORKFLOW_READ, PERMISSIONS.WORKFLOW_APPROVE, PERMISSIONS.RETENTION_READ,
    PERMISSIONS.LEGAL_HOLD_READ, PERMISSIONS.SEARCH_READ, PERMISSIONS.NOTIFICATION_READ,
    // A department manager administers the PEOPLE of their own department
    // (user:manage — scoped to the departments they head and to users they do
    // not outrank, see shared/orgScope.ts) and may read the role catalogue to
    // pick a role for a member. role:manage is deliberately NOT here (revised
    // 2026-10-04): it edits what a role MEANS for every holder in the tenant,
    // so the routes reserve it to tenant-wide administrators anyway
    // (roles.routes.ts requireTenantWideRoleAuthority). Existing tenants whose
    // DEPT_MANAGER rows were stored with role:manage keep it in the database
    // but gain nothing from it.
    PERMISSIONS.USER_MANAGE, PERMISSIONS.ROLE_READ,
    // Dept managers are the most common named signatory (e.g. letter dispatch
    // signoff) — signing:read gates "can view/sign a task I'm the named
    // recipient on," not a specialist capability (see esigning.routes.ts's
    // sign-endpoint comment: the service enforces caller-is-recipient, the
    // permission is just the coarse gate). signing:manage (create/send/remind
    // a signature request) and form-template authoring are both ordinary
    // day-to-day department work, not admin-only actions — 2026-09-16.
    PERMISSIONS.SIGNING_READ, PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_CREATE, PERMISSIONS.LETTER_REVIEW,
    PERMISSIONS.LETTER_APPROVE, PERMISSIONS.LETTER_DISPATCH, PERMISSIONS.LETTER_REGISTER,
    PERMISSIONS.ORG_UNIT_READ,
    PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN,
    PERMISSIONS.AI_USE,
  ],
  APPROVER: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.FOLDER_READ, PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_APPROVE, PERMISSIONS.SEARCH_READ, PERMISSIONS.NOTIFICATION_READ,
    PERMISSIONS.SIGNING_READ, PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE,
    PERMISSIONS.ORG_UNIT_READ,
    PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.AI_USE,
  ],
  EMPLOYEE: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_UPLOAD, PERMISSIONS.DOCUMENT_CHECKOUT,
    PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCTYPE_READ, PERMISSIONS.SEARCH_READ,
    PERMISSIONS.NOTIFICATION_READ,
    // Same reasoning as DEPT_MANAGER above — any employee can be named a
    // signing recipient by someone holding signing:manage, AND (2026-09-16)
    // can hold signing:manage themselves to create their own signature
    // requests, plus build/edit their own form templates.
    PERMISSIONS.SIGNING_READ, PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_CREATE, PERMISSIONS.ORG_UNIT_READ,
    PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.AI_USE,
  ],
  // Independent read-only oversight of EVERY module: documents, folders, org
  // structure, document types, workflows, retention, holds, correspondence,
  // signing and the audit trail. Holds no write/manage permission at all (the
  // one decision right is audit-stage PASS/FLAG, which is the auditor's job).
  // Revised 2026-10-04: DEPT_READ, DOCTYPE_READ, WORKFLOW_READ and ROLE_READ
  // were missing, so the auditor could see a document but not the department,
  // type or workflow it belonged to.
  AUDITOR: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.FOLDER_READ,
    PERMISSIONS.AUDIT_READ, PERMISSIONS.SEARCH_READ, PERMISSIONS.SEARCH_SCOPE_ALL,
    PERMISSIONS.RETENTION_READ, PERMISSIONS.LEGAL_HOLD_READ, PERMISSIONS.OPERATIONS_READ,
    PERMISSIONS.SIGNING_READ,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.ORG_UNIT_READ,
    PERMISSIONS.DEPT_READ, PERMISSIONS.DOCTYPE_READ, PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.ROLE_READ,
    PERMISSIONS.AUDIT_STAGE_DECIDE, PERMISSIONS.NOTIFICATION_READ,
    PERMISSIONS.AI_USE, PERMISSIONS.AI_CHAT,
  ],
  // Senior leadership: sees EVERYTHING on every module (tenant-wide, not scoped
  // to a department) and can act on what reaches them — approve and sign
  // letters, decide approval steps and workflow tasks, build forms and send
  // signature requests, upload and fill forms like any other staff member.
  // Deliberately NOT administration: no user/role/ACL/tenant/org-unit/
  // department/doc-type management, no purge/archive/legal-hold/retention
  // changes. Those stay with SYSTEM_ADMIN and RECORDS_OFFICER, so an executive
  // can oversee the whole organisation without being able to reconfigure or
  // destroy it. Before 2026-10-04 this role held only letter:read(+all),
  // org/dept read, search and signing:read — it could not open a single
  // document, folder, report or workflow, and the dashboard showed nothing.
  // A tenant admin can still adjust this per tenant via role:manage.
  EXECUTIVE: [
    PERMISSIONS.DOCUMENT_READ, PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.DOCUMENT_UPLOAD,
    PERMISSIONS.DOCUMENT_CHECKOUT,
    PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCTYPE_READ,
    PERMISSIONS.DEPT_READ, PERMISSIONS.ORG_UNIT_READ, PERMISSIONS.ROLE_READ,
    PERMISSIONS.AUDIT_READ, PERMISSIONS.OPERATIONS_READ,
    PERMISSIONS.WORKFLOW_READ, PERMISSIONS.WORKFLOW_APPROVE,
    PERMISSIONS.RETENTION_READ, PERMISSIONS.LEGAL_HOLD_READ,
    PERMISSIONS.SEARCH_READ, PERMISSIONS.SEARCH_SCOPE_ALL, PERMISSIONS.NOTIFICATION_READ,
    PERMISSIONS.SIGNING_READ, PERMISSIONS.SIGNING_MANAGE, PERMISSIONS.FORM_TEMPLATE_MANAGE,
    PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.LETTER_CREATE,
    PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE,
    PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.AI_USE, PERMISSIONS.AI_CHAT,
  ],
};

/** Role priority order — index 0 is highest. Used for display-role selection only. */
export const ROLE_RANK: readonly string[] = [
  'PLATFORM_ADMIN',
  'SYSTEM_ADMIN',
  'EXECUTIVE',
  'RECORDS_OFFICER',
  'DEPT_MANAGER',
  'APPROVER',
  'AUDITOR',
  'EMPLOYEE',
];

export type PermissionSubject =
  | string
  | {
      role: string;
      permissions?: readonly Permission[] | undefined;
    };

/**
 * §1 helper: resolve whether a role has a given permission.
 * Use this in service-layer code instead of raw `user.role === 'X'` checks.
 */
export function userHasPermission(subject: PermissionSubject, permission: Permission): boolean {
  if (typeof subject === 'string') {
    return (ROLE_PERMISSIONS[subject] ?? []).includes(permission);
  }

  const allowed = subject.permissions ?? ROLE_PERMISSIONS[subject.role] ?? [];
  return allowed.includes(permission);
}
