# Role scope matrix — who can build the organisation, and where

Written 2026-10-04. Everything here was read from source or run against the dev database; where something
was not verified it says so (last section). The permission grants come from
`backend/src/config/permissions.ts` (static defaults — a tenant can store its own `role_permissions` rows
that override them, see "Stored overrides" below). The scope rules come from `backend/src/shared/orgScope.ts`,
wired into the routes. Proof: `backend/tests/orgScope.routes.test.ts` (39 cases, real routers),
`backend/test-scripts/verify-org-scope.ts` (40 checks against the real dev database in a throwaway tenant).

## The two layers

1. **Permission** — may this role do this *kind* of thing at all (`department:manage`, `user:manage`, ...).
2. **Scope** — *where*. Enforced in `shared/orgScope.ts`:
   - A **department head** is a holder of the permission who is a **member** of a department. They administer that
     department **and every sub-department below it** (management: create, move, deactivate, assign). Nothing beside it and
     nothing above it. **Reading is different:** documents, folders and letters follow *direct* membership, so a parent
     department's head or member does not read a sub-department's documents unless they are also a member of it.
   - **Organisation-level authority** = `acl:bypass_admin` (SYSTEM_ADMIN, PLATFORM_ADMIN) or `orgunit:manage`.
     It administers the whole tenant and is the only authority that can create a *top-level* department.
   - **You cannot manage a user who holds a permission you do not hold** (their role permissions plus their
     individual grants and revokes, in this tenant). A department manager therefore cannot touch a SYSTEM_ADMIN,
     AUDITOR, RECORDS_OFFICER or EXECUTIVE, even inside their own department.
   - A user of another tenant reads as "not found" for everybody, administrators included.

## Matrix (static defaults)

Legend: **yes** = anywhere in the tenant; **own subtree** = departments the person belongs to and everything
below them; **no** = the permission is not held, the route answers 403.

| Capability | EMPLOYEE | DEPT_MANAGER | SYSTEM_ADMIN | EXECUTIVE | AUDITOR | RECORDS_OFFICER |
|---|---|---|---|---|---|---|
| Create an organisation unit (`orgunit:manage`) | no | no | **yes** | no | no | no |
| Create a top-level department | no | no | **yes** | no | no | no |
| Create a sub-department (department with a parent) | no | **own subtree** | **yes** | no | no | no |
| Rename / edit a department | no | **own subtree** | **yes** | no | no | no |
| Move or deactivate a sub-department | no | **own subtree, as head of its parent** (a head cannot move or deactivate their own department) | **yes** | no | no | no |
| Move or deactivate a top-level department | no | no | **yes** | no | no | no |
| Create a folder | no | **own subtree** | **yes** | no | no | **own subtree**, plus department-less filing-plan folders |
| Rename / move a folder | no | **own subtree** (destination must also be in it) | **yes** | no | no | only with a `folder:update` ACL on it |
| Delete a folder | no | no (`folder:delete` not held) | **yes** | no | no | only with a `folder:delete` ACL on it |
| Create / edit / deactivate a document type | no | no | **yes** (tenant-wide, org-unit or department scope) | no | no | **yes** (tenant-wide, org-unit or department scope) |
| Assign a role to a member | no | **own subtree**; only roles whose permissions they hold in full (EMPLOYEE, APPROVER, a peer DEPT_MANAGER; never RECORDS_OFFICER, AUDITOR, EXECUTIVE, SYSTEM_ADMIN); never above themselves | **yes**, any role except PLATFORM_ADMIN | no | no | no |
| Remove a role from a member | no | **own subtree**, only a user they do not outrank | **yes** | no | no | no |
| Give one person an individual permission (grant / revoke) | no | **own subtree**; a GRANT only of a permission they hold themselves | **yes**; a GRANT only of a permission they hold; never `platform:admin` | no | no | no |
| Add / remove a member to a department | no | **own subtree** (and may adopt a member who belongs to no department yet) | **yes** | no | no | no |
| Create a new user | no | into **own subtree** departments only, and must name one | **yes** (department optional) | no | no | no |
| Edit / deactivate / delete / sign out a user | no | **own subtree**, only a user they do not outrank | **yes** | no | no | no |
| Edit what a role means (`role:manage`) | no | no (reserved to `acl:bypass_admin`) | **yes** | no | no | no |
| Define approval chain templates / workflow definitions (`workflow:manage`) | no | no | **yes** | no | no | **yes** |
| Grant folder / document ACLs (`acl:manage`) | no | no | **yes** | no | no | no |
| Read every document in the tenant | no — own, own department (direct membership; not its sub-departments), and explicit per-user grants | no — same as EMPLOYEE | **yes** (`acl:bypass_admin`) | **yes** (`document:read_all`) | **yes** (`document:read_all`) | **yes** (`document:read_all`) |

Other roles: **APPROVER** holds a subset of DEPT_MANAGER's permissions and no administration right at all.
**PLATFORM_ADMIN** is SYSTEM_ADMIN plus `platform:admin`; it is hidden from every list, cannot be granted,
re-roled or edited by anyone (`shared/platformAdmin.ts`) and none of the work below changes that.

### What changed to make this true (2026-10-04)

Before this pass every holder of `department:manage` or `user:manage` was tenant-wide. A DEPT_MANAGER could
create, rename, move or deactivate **any** department, deactivate / delete / sign out **any** user of the tenant
(including the SYSTEM_ADMIN), remove the SYSTEM_ADMIN role from the administrator, rewrite the permission set of
**any role for the whole tenant** (`role:manage`; removals bypassed the escalation guard), and add folders at the
top of the tenant. DEPT_MANAGER no longer holds `role:manage` by default.

## Rules that cut across roles

- **Nobody grants what they do not hold.** Role assignment (`assertCanGrantRole`: the actor must hold every
  permission the role confers in *any* tenant), user creation (same), per-user GRANT overrides and role-permission
  edits all check the actor's own permission set. `platform:admin` and the PLATFORM_ADMIN role are rejected
  outright on every path, including user creation.
- **Per-user overrides** (`user_permission_overrides`) are applied on top of the role when the token is issued,
  inside the tenant they were written for; setting one signs the user out so it applies at once.
- **Per-user document / folder / department access** is an ACL row (`acl_entries`) with a user principal:
  - Resolution order is *most specific first*, and within each level **DENY beats ALLOW** (direct user, direct
    role, then ancestor folders nearest first, then ancestor departments). An explicit DENY always beats
    `document:read_all` and a role ALLOW; a nearer folder DENY beats a farther folder ALLOW; an expired ALLOW is
    ignored. (An expired DENY keeps denying — that fails closed.)
  - A document is readable only by its owner, a member of its department (or of a department above it), or
    someone with a **deliberate per-user grant** (approval participant, auditor, signatory, Access Control Center),
    or `document:read_all`. A **role** ALLOW can never widen this (the grant API rejects it).
  - A per-user ALLOW on an ancestor folder is inherited by every document below it, across departments.
  - Department-membership snapshot grants written at upload stay bound to the department: leaving it ends access.
- **No self-approval.** Whoever authored or submitted an item cannot APPROVE it (unified engine and the legacy
  workflow engine), and a step cannot be addressed by name to the author or submitter. They can still request
  changes or decline their own item. If the author is the only qualified approver, an approval admin reassigns
  the step (department-scoped).
- **Approvals follow the document type.** A document type's active chain template is looked up at submit
  (`POST /approvals/DOCUMENT/:id/submit`); the author completes unlocked steps, locked steps cannot be removed.
  Templates and definitions must target a document type / form template **of the same tenant**, and named
  approvers must be members of it. A type with `requiresApproval = false` is published directly by its owner;
  one with `requiresApproval = true` cannot be published without a chain.
- **Absent or inactive approver.** Deactivating a user revokes their sessions and notifies each submitter whose
  step is waiting on them; an overdue step (SLA) is flagged once and notifies the assignee, the role holders and
  the submitter. Since 2026-10-04 the unified engine has both (`MODULE-WORKFLOWS-AND-SCOPE.md` section 4.4): the assignee may **delegate**
  a non-mandatory step to one eligible colleague of the item's department (same role for a role step; never the author, submitter
  or hidden platform admin), and a step overdue past the grace period **escalates**: the department head(s), else the approval
  admins, are added as co-deciders (the assignee keeps it). `reassign` / `cancel` by an approval admin who is a member of the
  item's department (or holds `document:read_all`) remains the recovery; for a tenant-wide or org-unit form template only an
  organisation-level role can reassign or cancel. A role-assigned step can be decided by any other qualified holder in the department.
- **Search and listings.** Every search hit is re-checked against the document ACL (detail-view rule); document
  lists, the folder contents view, the dashboard counts, the folder tree and the department / org-unit /
  document-type pickers are scoped to what the caller may see. A **Confidential** or **Restricted** document (classification;
  `shared/classifiedAccess.ts`) appears only to its owner, people holding a deliberate grant on it, the oversight roles (`document:read_all`, which includes
  the platform administrator) and, for Confidential only, the head of its own department. Facet counts are rebuilt
  from the permitted hits, so they no longer count documents the caller cannot read. Storage analytics (tenant
  totals per department / type / status) need `document:read_all`.

## Stored overrides — what the static table does not tell you

A tenant that has stored `role_permissions` rows for a role uses those instead of the defaults above
(`getResolvedRolePermissions`). The scope rules do **not** depend on the defaults: a custom role holding
`department:manage` is still limited to the departments its holder belongs to, and `role:manage` is reserved to
`acl:bypass_admin` whatever the rows say. Existing tenants whose DEPT_MANAGER rows still include `role:manage`
keep it in the database; it grants nothing now, and the Roles screen will answer 403 on save for them.

## What was not verified

- Nothing was run through the browser; every claim is from source, jest (mocked data layer, real routers) and
  direct-to-database checks on the dev database. The Operations / Users / Hierarchy screens still show actions
  (for instance "New department" at top level, role editing for DEPT_MANAGER) that the API now answers with 403;
  the UI was not changed except the Storage menu entry, which now needs `document:read_all`.
- Mirror and production were **not** touched or tested. None of this takes effect there until a build and
  restart (and the separate migration `20261004000010` another change set added for ACL origin).
- The letters module (its own approval chain implementation) and e-signing were out of scope: whether letters
  block self-approval was not checked.
- `GET /users` and the document-type / department pickers deliberately stay readable tenant-wide for the people
  pickers (ApprovalChains, Access Control Center, letters assignee lists); only the Users admin table narrows
  with `?scope=mine`.
- Redis was down on the dev machine, so cache invalidation was exercised through the in-process fallback only.
