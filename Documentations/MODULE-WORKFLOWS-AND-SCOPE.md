# DMS module workflows and scope: Uploading, Letters, E-signing, Forms

Verified against the source on 2026-10-04 (working copy of `DMS/`, not against older documents). Every statement
below was read from code or probed on the dev database; where something could not be confirmed it is listed under
"Not verified" at the end of its module. Intended as source material for the training programme.

How to read the tables: a role "has" a permission according to `backend/src/config/permissions.ts` (the static
defaults). A tenant administrator can change a role's permissions per tenant (Role Editor), so a live tenant can
differ. `SYSTEM_ADMIN` and `PLATFORM_ADMIN` hold `acl:bypass_admin`, which skips every per-document ACL check;
the platform administrator account is additionally invisible to everyone else (`shared/platformAdmin.ts`) and
never appears in any picker.

Two layers decide every document action, and both must pass:

1. **RBAC**: the route's `requirePermission(...)`.
2. **ACL**: `requireACL(...)` / `resolveACL` for the specific document (DENY wins; an explicit grant is required for
   everything except read, which is also granted by the live department scope or by `document:read_all`).

## Common scope rules (apply to Uploading and, through the document it files, to Forms and E-signing)

| Who | What they see in lists, detail, download, preview, search |
|---|---|
| Employee, approver, dept manager | Documents they own, plus documents of the departments they are **directly** members of (owner decision 2026-10-09: belonging to a parent department does **not** open its sub-departments, and a sub-department head does not see the parent's either — a person who needs a sub-department is made a member of it). Plus documents they hold a deliberate per-user grant on (see "Cross-department access" below). |
| Records officer, auditor, executive | Every document in the tenant (`document:read_all`), subject to explicit DENY entries. `search:scope_all` likewise. RESTRICTED-label documents are left out of **search** for them unless they hold a user-specific ACL ALLOW. |
| System administrator | Everything in the tenant, no ACL check. |
| Platform administrator | Same, in every tenant; invisible to others. |

Cross-department access. Inside a department a member's read comes from the live membership plus a per-user ACL
row written at upload time (a "department snapshot"). Outside the department the only way in is a **deliberate
per-user grant**: an approval-chain participant (approver or auditor named on a chain), a letter signatory, or an
Access Control Center grant. Role-wide document or folder read grants are refused by the ACL API. Since
2026-10-04 (migration `20261004000010`) snapshot rows are marked `origin = 'DEPT_SNAPSHOT'`, so a person who
**leaves** a department stops reading its documents while deliberate grants keep working. Before that change both
looked identical and the live boundary also blocked cross-department approvers (see finding U1).

---

## 1. Uploading module (`backend/src/modules/documents/`)

### 1.1 Who can upload, and where

| Rule | Enforced at |
|---|---|
| Needs `document:upload`: records officer, dept manager, employee, executive, system/platform admin. **Not** approver, auditor. | route `POST /documents`; tus path `app.ts` `requireUpload` |
| The uploader must be a **direct member of the target department** (no descendant or parent expansion); only `acl:bypass_admin` holders may file into any department. | `ensureCanCreate` (`documents.service.ts`) |
| The document type must be tenant-wide, or scoped to that department, or scoped to that department's org unit. | `assertDocumentTypeInScope`, used by both the buffered and the tus upload |
| A chosen folder must be an active folder of the tenant and, if it belongs to a department, the document's own department. | `createDocument`, tus `processTusUpload` |
| The retention class must be a registered `retention_policies.code`. | both upload paths |
| Mandatory metadata: title, department, type, organisation unit, security classification, retention class, source. | `validateUploadInput` |
| Size: buffered upload at most 25 MB (multer memory); larger files must use the resumable tus endpoint. Both are capped at 500 MB per file (documented in the Upload page). | `documents.routes.ts`, `tusUpload.ts` `maxSize`, `documentValidation.ts` |
| Tenant storage quota is reserved atomically inside the creation transaction. | `reserveStorageQuota` |

### 1.2 What happens on upload (buffered, up to 25 MB)

1. MIME and extension validation (byte sniffing, blocked executable extensions, encrypted PDFs refused).
2. Antivirus scan (ClamAV) **synchronously** up to 100 MB. A detected virus is refused (`ERR-AV-THREAT-DETECTED`).
   If the scanner is unreachable the upload is **let through and flagged**: the version is stamped `unscanned`, the
   response carries `WARN-UNSCANNED` and an audit event `DOCUMENT_SCAN_UNSCANNED` is written (fail-open policy).
3. Duplicate check on the plaintext SHA-256 inside the tenant: never blocks, returns `WARN-DUPLICATE-DETECTED`.
4. Encryption: each version has its own data-encryption key (AES-256-GCM) wrapped by the key-encryption key
   (`VAULT_BACKEND`), stored in `document_deks`; ciphertext goes to storage. Tus uploads over 100 MB are encrypted
   from a stream.
5. In one SERIALIZABLE transaction: quota reservation, document name `DEPT-TYPE-YYYYMMDD-NNNN` (locked counter),
   `documents`, metadata, version `1.0`, DEK, outbox events (websocket, OCR, search index), retention clock,
   default ACLs, audit `DOC_CREATE`.
6. Files over 100 MB skip the inline scan: the document is created `SCAN_PENDING` (cannot be downloaded or previewed:
   409 `ERR-DOCUMENT-SCAN-PENDING`) and the `VIRUS_SCAN` worker scans it later. Clean or unscanned: the document
   becomes `DRAFT`. A virus: ciphertext is moved to the quarantine prefix, the document becomes `QUARANTINED`
   (downloads answer 409 `ERR-DOCUMENT-QUARANTINED`), audit `VIRUS_DETECTED`, critical notification.

Default ACL rows written for a new document (`grantDefaultDocumentAcl`):

| Principal | Permissions |
|---|---|
| Owner (uploader) | `document:read`, `document:upload`, `document:archive`, `document:checkout` |
| Every current member of the document's department (snapshot, `origin = DEPT_SNAPSHOT`) | `document:read` |
| Role `RECORDS_OFFICER` | `document:purge` (the only role-wide grant) |

Someone who joins the department later is inside the live scope but has no snapshot row, so they cannot open older
documents until granted. Someone who leaves is cut off immediately by the live check.

### 1.3 Classification and sensitivity

`securityClassification` (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) drives AI egress limits (`aiPolicy.maxConfidentiality`) and,
**since 2026-10-10 (owner decision, option B), who may read an ordinary document**. PUBLIC and INTERNAL: department scope, ownership and ACL as
before. **CONFIDENTIAL / RESTRICTED** (`shared/classifiedAccess.ts`, applied inside `resolveACL` and `resolveACLBatch`, so detail, download,
preview, lists, folder contents, search, AI and bundles all follow it): readable by the owner, anyone with a **deliberate per-document grant**
(not the automatic `DEPT_SNAPSHOT` row; chain participants get one through `approvals/classifiedParticipants.ts`), the oversight roles
(`document:read_all`, including the platform administrator, never narrowed), and for CONFIDENTIAL only the **head** of the document's own
department (a direct member holding `department:manage`; not for a letter's documents). Department membership, the snapshot rows, folder or
department grants and access rules do not open one; an explicit DENY wins. The class is read live and a classified result is never cached.
The class is changed with `PATCH /documents/:id/classification` (`changeDocumentClassification`: owner, head who can read it, or administrator;
lowering needs a 10-character reason; a letter's documents and documents under legal hold are refused). `sensitivityLabel` stays metadata
(kept equal to the class by that action).

### 1.4 Document state machine (`DocumentStateMachine.ts`)

```
SCAN_PENDING -> DRAFT | QUARANTINED | CANCELLED          (large files only; set by the scan worker)
DRAFT -> IN_REVIEW (submit) | PENDING_REVIEW | CANCELLED (discard) | ACTIVE (publish, only if the type has requiresApproval = false)
IN_REVIEW -> APPROVED | REJECTED | ON_HOLD | CHANGES_REQUESTED | DECLINED
CHANGES_REQUESTED | DECLINED -> IN_REVIEW (resubmit, fresh chain) | CANCELLED
APPROVED -> PENDING_AUDIT | ACTIVE | ARCHIVED | PENDING_SIGNATURE
PENDING_AUDIT -> AUDITED | AUDIT_FLAGGED (flag returns to the final approver, then PENDING_AUDIT again)
ACTIVE -> PENDING_SIGNATURE | ARCHIVED | SUPERSEDED
PENDING_SIGNATURE -> SIGNED | SIGNING_DECLINED
SIGNED | AUDITED -> ACTIVE | ARCHIVED
ARCHIVED -> ACTIVE (Activate) | LEGAL_HOLD | DISPOSAL_PENDING | PRESERVED
DISPOSAL_PENDING -> DISPOSED          DISPOSED, PRESERVED, CANCELLED are terminal
any non-terminal -> TRASHED (soft delete); restore returns the pre-trash status
```

Only some transitions can be made by hand (`MANUAL_TRANSITION_PERMISSIONS`): archive/activate/supersede, the
author's discard and `REJECTED -> DRAFT`, and quarantine release. Everything on the approval, audit, signing, hold
and disposal paths is driven by its subsystem and is refused on the manual status endpoint (409
`ERR-TRANSITION-NOT-MANUAL`), so holding `document:upload` alone can never self-approve.

### 1.5 Who can do what to a document

| Action | RBAC permission | ACL on the document | Notes |
|---|---|---|---|
| Upload | `document:upload` | member of target department | |
| List, open, download, preview, versions, diff | `document:read` | `document:read` (live DIRECT department membership, or `read_all`, or deliberate grant) | `download`/`preview` also refuse `SCAN_PENDING` and `QUARANTINED`; per-status role rules can narrow further |
| Check out / lock / check in | `document:checkout` (records officer, dept manager, employee, executive, admins) | `document:checkout`: **the owner** (and admins) | refused on legal hold, terminal states, trash, while another user holds a lock; a default rule makes `ARCHIVED` check-out **SYSTEM_ADMIN only** |
| Upload a new version | `document:upload` | `document:upload` (owner, admins) | the caller must be the one who checked it out; the version is encrypted and scanned like a first upload |
| Roll back to an older version | `document:upload` and `version:manage` (records officer, dept manager, admins) | `document:upload` | creates a new major version, re-encrypted |
| Force unlock | `document:checkout` and `department:manage` (dept manager, admins), reason of 10+ characters | `document:read`, so a manager of the department (or of a parent department) can release a colleague's checkout | audit `LOCK_FORCE_RELEASED` |
| Publish a draft | `document:upload` | `document:upload` (owner) | only for types with `requiresApproval = false` |
| Submit for approval | `approval:submit` | caller must be able to **read** the document; owner, or holder of `approval:admin` | creates the chain (see 1.6) |
| Archive / activate / trash / restore | `document:archive` (records officer, admins) | `document:archive` (owner, admins) | |
| Discard a draft permanently | `document:upload` | `document:upload` | drafts only, bypasses trash |
| Purge (permanent destruction) | `document:purge` (records officer, admins) | `document:purge` | two people: the one who staged it cannot approve it (`ERR-MAKER-CHECKER`); certificate of destruction issued |

### 1.6 Document-type workflow trigger

Uploading never starts an approval by itself: the document is born `DRAFT`. The owner then either publishes it
(type opted out of approval) or submits it. The chain comes from the **active approval-chain template of the
document type**; with no template the default is one `APPROVE` step assigned to role `DEPT_MANAGER`.
Locked template steps cannot be removed or reordered by the author; the author may swap the assignee of unlocked
steps. Steps run **one at a time**. A role-assigned step can only be decided by a member of the document's
department (unless the decider holds `document:read_all`), a named-person step by that person. Decisions:
APPROVE, REQUEST_CHANGES (chain suspended, author revises), DECLINE (comment mandatory, author may rework and
resubmit a fresh chain). After the last approval the type's policies route the document: `signingPolicy = ceremony`
makes it `ACTIVE` awaiting a signature request; else `auditPolicy` routes it to `PENDING_AUDIT` (the approver picks
an independent auditor, who may not be the author, an approver of the item, or someone who already decided a step);
else it goes straight to `ARCHIVED`. The reapproval policy of a type (`major_versions` or `all_changes`) sends a
settled document back to `DRAFT` when a new version is filed, and tears down any in-flight signing or audit.

Sub-department note: the default role step is staffed from the sub-department's own members, so a sub-department
without a dept manager cannot submit under the default chain (`ERR-STEP-ROLE-UNSTAFFED`); a parent-department
manager can read its documents but cannot decide a role step there.

### 1.7 Retention

`applyRetention` computes `disposalEligibleDate` from the retention class: creation or trigger date, archive date,
or document date depending on the policy's trigger event; permanent classes never expire. It runs at creation
(buffered and tus), on archive and activate, on retention-policy changes and on legal-hold release. A legal hold
blocks edits, check-out, versions, archive, approval decisions and purge.

### 1.8 Findings in this module

| # | Where | Finding | Real | Fixed |
|---|---|---|---|---|
| U1 | `shared/resolveACL.ts` (single and batch) | The live department boundary denied **every** user outside the department, including holders of a deliberate per-user grant: approval-chain participants, auditors, signatories and Access Control Center grants could not open the document (`verify-approval-participant-access.ts` describes exactly this as the bug it pins). Probed on the dev DB: a user ALLOW row for a non-member answered "outside the active department scope". | yes | yes: snapshot rows are marked (`acl_entries.origin`, migration `20261004000010`), the boundary honours any other unexpired user ALLOW; leavers stay blocked |
| U2 | `grantDefaultDocumentAcl`; routes `/checkout`, `/checkin`, `/lock`, `/force-unlock` | Owners never received `document:checkout`, so only `acl:bypass_admin` holders could check out; because a version upload requires the caller's own checkout, **nobody but a system administrator could add a version**. Confirmed with `resolveACL` on dev data (read/upload/archive allowed, checkout "No matching ACL entry"). Force-unlock was gated on the same ACL, so managers always got 403. | yes | yes: owner now gets checkout (new documents and a backfill of existing ones); force-unlock needs `document:read` ACL instead |
| U3 | `infrastructure/queue/workers/ScanWorker.ts` | After a clean async scan the worker also flipped any `DRAFT` or `QUARANTINED` document to `ACTIVE`: a >100 MB new version of a DRAFT document **published it without approval**, and a clean scan of one version released a document quarantined for a virus in another. | yes | yes: only `SCAN_PENDING -> DRAFT` remains |
| U4 | `shared/documentGuards.ts` `assertScanCleared` | Download and preview blocked `SCAN_PENDING` but not `QUARANTINED`. | yes | yes: 409 `ERR-DOCUMENT-QUARANTINED` |
| U5 | `modules/documents/tusUpload.ts` | The resumable upload skipped the document-type scope check, the retention-class registry check and **ignored the selected folder** (large files landed unfiled). | yes | yes (shared `assertDocumentTypeInScope`, retention and folder validation) |
| U6 | `tusUpload.ts` | The tus server had no size limit; the quota check ran only after the last byte, so an uploader could fill the disk. | yes | yes: `maxSize` 500 MB (the documented ceiling) |
| U7 | `documents.routes.ts` download | `Content-Disposition` was built from the raw stored filename; a name with characters above U+00FF (Amharic, from a tus upload) made Node throw and the download answer 500, quotes in a name broke the header. | yes (reproduced with Node) | yes: `shared/contentDisposition.ts`, ASCII fallback plus RFC 5987 `filename*`; the document page now reads `filename*` |
| U8 | `approvals.service.ts` `submitForApproval` | `approval:admin` (every dept manager) could submit **another department's** draft by id, name themselves the approver and receive a read grant on it; only the prefill call checked read access. | yes | yes: read ACL required (`assertItemAclReadable`) |
| U9 | frontend | Stale "EXECUTIVE sees only letters" wording (Sidebar comments, login demo label, `app.ts` comment). Navigation itself is permission-gated, with no role-name checks. | yes | yes (text only) |
| U10 | `approvals.service.ts` `decideStep` | When this audit began there was no self-approval rule: an author who was also a holder of the assigned role approved their own document. | yes | addressed meanwhile by another agent in the working tree: `ERR-SELF-APPROVAL` blocks APPROVE by the item's author or submitter (decline and request-changes stay allowed) and a named step cannot be assigned to them (`ERR-STEP-SELF-APPROVAL`); an approval admin reassigns the step when the author is the only qualified approver. Letters have **no** equivalent (L15) |
| U11 | `scanBuffer` | Antivirus is fail-open when ClamAV is down (flagged, not blocked). | yes, documented policy | no, policy |
| U12 | `/documents/:id/versions` | Returns version rows including storage key and the full extracted text to anyone with read access. | yes, low | no |
| U13 | `app.ts` | The "upload" rate limiter is mounted on `/documents/upload` (the tus endpoint); the buffered `POST /documents` falls under the general limiter. | yes, low | no |
| U14 | search | Search takes the first 50 candidates **before** the per-document ACL filter, so a user in a large tenant can see fewer hits than exist (recall, not a leak). | yes | no |

### Not verified (Uploading)

- The full HTTP path with a live ClamAV, MinIO and Redis (the dev machine runs none of them).
- Behaviour of snapshot rows created before 2026-10-04 for people who had already left a department: they cannot be
  recognised and keep the access they had.
- Concurrency of the scan worker against a user's simultaneous approval submit.

---

## 2. Letters module (`backend/src/modules/letters/`)

Letters wrap documents: the final PDF, signed draft, cover sheet and attachments are ordinary `documents` rows.
Letters keep **their own** approval chain (not the unified engine); the shared step rules are in
`approvals/stepRules.ts` (`LETTER_STEP_RULES`: `letter:approve` for an APPROVE step, `letter:review` for a REVIEW
step, `letter:read_all` lifts department scoping).

### 2.1 Permissions

| Role | letter permissions |
|---|---|
| Employee | read, create |
| Approver | read, review, approve |
| Dept manager | read, create, review, approve, dispatch, register |
| Records officer | read, **read_all**, create, register, dispatch (cannot review or approve) |
| Executive | read, **read_all**, create, review, approve |
| Auditor | read, **read_all** (read only) |
| System / platform admin | all |

### 2.2 State machine (outgoing letters; `LetterStateMachine.ts`, `letters.service.ts`)

| Transition | Who may do it | Enforced by |
|---|---|---|
| (none) -> DRAFT | `letter:create`, member of the department (unless `letter:read_all`); the org unit must be the department's own org unit (422 `ERR-DEPT-ORG-UNIT-MISMATCH`) | `createLetter`, `assertDepartmentMembershipForAuthoring`, `validateUnitAndDepartment` |
| Edit a DRAFT or RETURNED letter, add or remove attachments | the drafter only; re-checked under the row lock | `updateLetter`, `lockEditableLetter` |
| DRAFT/RETURNED -> IN_REVIEW (submit) | the drafter only; the final step must be APPROVE; every step must be actionable; **no named step may be the drafter (422 `ERR-STEP-SELF-APPROVAL`)**; old open steps are cancelled | `submitLetter` |
| Decide a step (APPROVE / REVIEW / RETURN) | the step's assignee (named user, or a holder of the assigned role who is a member of the letter's department unless `letter:read_all`) holding the step's permission; an approver may also decide a REVIEW step; sequential, one pending step at a time. **The drafter cannot APPROVE their own letter (403 `ERR-SELF-APPROVAL`, L15); RETURN stays allowed and needs a comment (L20)** | `decideStep` (`stepIsAssignedTo`, `assertRoleStepDepartmentScope`, `lockLetterInReview`, `guardedStepDecision`) |
| IN_REVIEW -> RETURNED | same decider, **comment required** (L20); waiting steps are cancelled; audit `LETTER_RETURNED` | `decideStep` |
| Last APPROVE, scanned outgoing | same decider: reference number allocated, document filed, status APPROVED | `finalizeLetterAfterSigning` |
| Last APPROVE, composed outgoing | same decider: status APPROVED, **no reference number yet** | `decideStep` |
| APPROVED (unsigned) -> PENDING_SIGNATURE | the drafter or any `letter:approve` holder **who can see that letter** (department scope); creates the signable draft and a single-recipient e-sign request | `initiateLetterSigning` |
| PENDING_SIGNATURE -> APPROVED (numbered) | the signatory, through the e-signing ceremony; reference number allocated in the same transaction | `esigning.signDocument` -> `finalizeLetterAfterSigning` |
| PENDING_SIGNATURE -> APPROVED (unnumbered, **E27**) | automatic when the letter's signing request is declined, cancelled by the requester, or expired: the letter returns to the state before signing was started so the drafter or an approver can send it again (same or another signatory). The closed draft is kept and renamed; audit `LETTER_UPDATED` (`signing-request-closed`, with the request id, status and reason); the drafter gets the "signature required" notification | `reconcileLetterSigning` (`letterSigningRecovery.ts`), run whenever a PENDING_SIGNATURE letter is read |
| APPROVED -> DISPATCHED | `letter:dispatch`, letter in scope, and the letter must be numbered (409 `ERR-LETTER-NOT-FINALIZED`) | `recordDispatch` |
| APPROVED/DISPATCHED -> ARCHIVED | `letter:dispatch`, numbered letter | `archiveLetter` |
| DRAFT/RETURNED -> CANCELLED | the drafter only, guarded update | `cancelLetter` |
| APPROVED (unnumbered, unsigned) -> CANCELLED (**L17**) | the drafter, or a department head / admin who manages the department; reason of 10+ characters. A numbered letter of record is never cancellable (409 `ERR-LETTER-NOT-CANCELLABLE`) | `cancelLetter` |
| IN_REVIEW or PENDING_SIGNATURE -> CANCELLED, and reassign the pending step | `department:manage` or `acl:bypass_admin`, reason of 10+ characters, **and** the department must be one the caller heads (descendants included) or the caller has tenant-wide authority. A step cannot be reassigned to the drafter (422 `ERR-STEP-SELF-APPROVAL`): this is the recovery when the drafter is the only qualified approver | `cancelLetter`, `reassignStep`, `assertCanManageDepartment` |
| Incoming: RECEIVED -> RESPONDED/CLOSED -> ARCHIVED | `letter:register`, letter in scope | `registerIncomingLetter`, `resolveIncomingLetter` |
| Public QR verification | nobody needs to sign in; rate limited 120/min per IP; hash compared case-insensitively; a cancelled letter reports "not authentic" | `verifyLetter` |

Reference numbers `REF/UNIT/DEPT/TYPE/YEAR/SEQ`: outgoing numbers exist **only after the signature** (never at
submit or approve), allocated from `letter_sequences` under `SELECT ... FOR UPDATE` inside the same transaction as
the letter row, gap-free, with a unique index on (tenant, reference number). Incoming letters are numbered at
registration. Double approval is impossible (chain lock plus a status-guarded update); approving a returned,
cancelled or already approved letter fails on the IN_REVIEW check. Every state change writes an audit event.

### 2.3 Who sees which letters (list, detail, PDF, attachments, revisions, by-document)

| Role | Scope (`scopeWhere`) |
|---|---|
| Employee, approver | Letters of the departments they belong to **directly**, plus letters they created, were assigned, are the named signatory of, or are on through the chain (a named step that is not cancelled, a step they decided, or an OPEN role step for a role they hold, inside the letter's own department; **L19**). CONFIDENTIAL and RESTRICTED letters only if they are one of those participants. |
| Dept manager (a department **head**: `department:manage` and a member) | Same rule, plus **read-only** access to the NON-restricted letters of the departments below their own (the subtree `assertCanManageDepartment` already uses). Writes (dispatch, assign, archive, link, start signing) stay on direct membership. **L18 decision, see below.** |
| Records officer, executive, auditor, system admin (`letter:read_all`) | Every letter in the tenant, including CONFIDENTIAL and RESTRICTED. The executive can also create, review and approve under any department. The auditor is read only. |
| Body image `GET /letters/body-images/:id` | its uploader, or anyone who may read (read view) a letter that embeds it (`letter_body_image_links`); anything else answers 404. A letter body may only embed images its own author uploaded (422 `ERR-BODY-IMAGE-FORBIDDEN`) **(L13)** |

All writes (dispatch, acknowledge, archive, assign, resolve, link, register `relatedLetterId`) use the same scope.
The platform administrator is never offered as a reviewer, approver, signatory or assignee and a request naming
them by id answers like an unknown user. Executives are also **emailed** when a letter is finally approved (policy
per tenant, individual opt-out); that is a notification, not an access rule.

### 2.4 Findings in this module (letters audit)

| # | Where | Finding | Real | Fixed |
|---|---|---|---|---|
| L1 | `reassignStep`, in-flight `cancelLetter` | Only `department:manage` was checked: the head of any department could reassign another department's pending step to themselves (a named assignee is never department-scoped, so they could then approve it) or cancel any in-flight letter | yes | yes (`assertCanManageDepartment`) |
| L2 | `initiateLetterSigning` | Looked the letter up by tenant only: any `letter:approve` holder could start signing on another department's approved letter and name the signatory | yes | yes (scope on the lookup) |
| L3 | `recordDispatch`, `archiveLetter` | An APPROVED composed letter with no reference number, document or signature could be dispatched or archived and was then stuck | yes | yes (409 `ERR-LETTER-NOT-FINALIZED`) |
| L4 | `validateUnitAndDepartment` | Any (org unit, department) pair was accepted although the unit code is the UNIT segment of the reference number | yes | yes (422) |
| L5 | `scopeWhere` | A named signatory outside the letter's department could not open the letter they were asked to sign | yes | yes |
| L6 | edit, attach, remove attachment | State checked without the row lock: a concurrent submit let content change in review | yes (race) | yes |
| L7 | `cancelLetter` (drafter) | Unguarded update: a concurrent submit could end CANCELLED with live steps | yes (race) | yes |
| L8 | `finalizeLetterAfterSigning` | Loaded without a lock: a concurrent cancel could be overwritten with a reference number and APPROVED | yes (race) | yes |
| L9 | `resolveIncomingLetter` | Closing an incoming letter was audited as `LETTER_ARCHIVED` | yes | yes (`LETTER_UPDATED` with from/to) |
| L10 | `assignLetter` | Accepted CLOSED/ARCHIVED letters | yes | yes (409) |
| L11 | step assignee, signatory, reassign target, incoming assignee | The hidden platform administrator could be chosen by id | yes | yes |
| L12 | `letters.routes.ts` | Stale "EXECUTIVE read-only" comment | yes | yes (comment) |
| L13 | `letterBodyImages.service.ts` | Body images were checked by tenant only: any `letter:read` holder could fetch any tenant image by id, and a body could embed (and the final PDF render) another user's image | yes | yes (migration `20261004000030` adds `letter_body_image_links`, back-filled from existing bodies and revisions for the author's own images; save refuses foreign images; download needs uploader or a readable linked letter; the PDF resolver only reads the author's images) |
| L14 | `grantDefaultDocumentAcl`, `letterDocumentAcl.ts` | A CONFIDENTIAL/RESTRICTED letter's backing documents got the department-wide read snapshot, so any department member could open them through the Documents module | yes | yes: no department snapshot for those classes; participants get deliberate reads; `syncLetterDocumentAcl` re-applies the rule on classification change (including attachments already filed and voided drafts) and when the participant set changes; script `scripts/backfill-letter-document-acl.ts` repairs existing letters |
| L15 | `decideStep` | No self-approval rule | yes | yes: 403 `ERR-SELF-APPROVAL` for APPROVE by the drafter (any step type), 422 `ERR-STEP-SELF-APPROVAL` for a step named after the drafter at submit and at reassign; recovery is a department head reassigning the step. A one-person department therefore needs a second approver (same as the unified engine) |
| L16 | `letterInclude` | Creator, signatory and decider names are shown; a platform admin acting on a letter would be visible | yes, low | no |
| L17 | `LetterStateMachine.ts`, `cancelLetter` | APPROVED -> CANCELLED was not allowed: an approved-unsigned letter had no exit | yes | yes (drafter or department head, reason required; never a numbered letter) |
| L18 | `scopeWhere` | Letters used direct membership while documents and folders included descendants | yes | resolved 2026-10-09: documents, folders and letters all use direct membership (see "L18 decision") |
| L19 | `getStepParticipationLetterIds` | Past step assignees, including cancelled steps, kept read access; and holders of a ROLE step were not participants at all, so a DEPT_MANAGER could not open a CONFIDENTIAL letter they were asked to approve | yes | yes (cancelled steps do not count; deciders and open role steps in the letter's department do) |
| L20 | `decisionSchema` | A RETURN comment was optional | yes | yes (a non-blank comment is required, 400 validation error on `comment`) |

New error codes the UI can show (readable wording lives in `frontend/features/letters/errors.ts`):
`ERR-LETTER-NOT-FINALIZED` (dispatch, archive), `ERR-DEPT-ORG-UNIT-MISMATCH` (create, register), 403 `ERR-DEPT-SCOPE`
(cancel or reassign outside your department), 403 `ERR-SELF-APPROVAL`, 422 `ERR-STEP-SELF-APPROVAL`,
409 `ERR-LETTER-NOT-CANCELLABLE`, 422 `ERR-REASON-REQUIRED`, 422 `ERR-BODY-IMAGE-FORBIDDEN`.

**L14 rule (document ACL follows the letter).** A CONFIDENTIAL or RESTRICTED letter's documents (final PDF,
signable draft, cover sheet, staged scan, attachments, incoming scan) are readable only by: the owner; the
letter's participants (drafter, incoming assignee, signatory, named step assignees and deciders, holders of an
open role step or of the signatory role in the letter's department), each through a deliberate per-user read
(`acl_entries.origin = 'LETTER_PARTICIPANT'`, honoured outside the department and withdrawn when the person
leaves the letter); and everyone holding `document:read_all` / `acl:bypass_admin` (records officer, executive,
auditor, administrators: oversight, no row needed). Department members who are not on the letter get nothing.
Other classes keep the creation-time department snapshot. Lowering the classification restores the snapshot.
Limit: a custom role with `letter:read_all` but without `document:read_all` reads the letter but not its documents.

**L18 decision (owner, 2026-10-09).** Letters, documents and folders all follow DIRECT department membership. Being a member or head of a parent department opens nothing below it; the person joins the sub-department instead. The earlier read-only widening for department heads was removed (`getReadOnlySubDepartmentIds` now returns nothing). CONFIDENTIAL/RESTRICTED stay participants-only for everyone; writes stay direct. Heads still **administer** their subtree (create, move, cancel, reassign) through `shared/orgScope.ts`; that is management, not reading.

**E27 hook.** The recovery needs nothing inside `modules/esigning`: any read of a PENDING_SIGNATURE letter
(`getLetter`, `listLetters`) reconciles it against its signing request. For immediate effect the e-signing module
can call `recoverLetterAfterSigningClosed(documentId, reason)` (exported from `letterSigningRecovery.ts`) right after a
decline, a requester cancel, or in `expireSignatureRequests` for each expired request.

### Not verified (Letters)

- The whole approve -> sign -> finalise flow over live HTTP (`test-scripts/verify-cams.ts` needs the backend running).
- The race fixes under concurrent load (verified by unit tests and a live lock query only).
- Frontend and reports that might have counted `LETTER_ARCHIVED` for closed incoming letters (none in `src`).
- L14 / L13 / E27 were proven by jest with mocked models (`tests/letters.followUp.test.ts`, `tests/letters.documentAcl.test.ts`)
  and the real SQL of `syncLetterDocumentAcl` by `test-scripts/probe-letter-acl-rollback.ts` (flips a dev letter to CONFIDENTIAL
  and back inside a transaction, always rolled back). The dev database has no CONFIDENTIAL/RESTRICTED letter, so
  `scripts/backfill-letter-document-acl.ts` found nothing to repair there. No browser run of the new buttons and wording.
- Not done: L16 (a platform administrator who acted on a letter would show by name), and role-signatory letters whose
  signatory role holders are outside the letter's department.

---

## 3. E-signing module (`backend/src/modules/esigning/`, legacy `backend/src/modules/signing/`)

### 3.1 States

Statuses come from the database CHECK constraints.

- **Request:** `draft`, `sent`, `partially_signed`, `completed`, `voided`, `expired`. There is no `cancelled`
  status: a cancel is `voided`.
- **Recipient:** `pending`, `viewed`, `signed`, `declined`. A field has a value and `signedAt`, no status.
- **Kinds of recipient:** internal named (`dmsUserId`, no token); role based (`assignedRole`, claimed by the first
  qualified holder who signs, department scoped to the document); external (random 24-byte token, 7-day expiry).
  **The token is minted at send and at every reminder, only its SHA-256 is stored** (`access_token_hash`, UNIQUE),
  the raw value exists only in the emailed link, and no API response carries even the digest (model getter hides it).
  A reminder **rotates** the token: the earlier link stops working and the new link is emailed (decision E24).

| Transition | Who | Enforced by |
|---|---|---|
| create -> `draft` | `signing:manage` and `document:read` ACL **and** one of (E25): the document's owner, a SYSTEM_ADMIN or `acl:bypass_admin` holder, a holder of the write-grade `document:upload` ACL (explicit, folder or department grant), the approver who approved it in the approval engine, or, for a letter's signable draft, the letter's drafter, signatory or a `letter:approve` holder (403 `ERR-SIGNING-NOT-PERMITTED` otherwise). The document must be APPROVED, ACTIVE, SIGNING_DECLINED or PENDING_SIGNATURE and have a filed version; **the request pins that version** (`document_version_id`, E23). Upload-and-sign is `POST /signing/uploads` (`signing:manage`, antivirus, `ensureCanCreate`) and then creates the request. Named users must be active members of the tenant and not hidden; a past expiry or an out-of-range field recipient is refused. | `createSignatureRequest`, `assertMayStartCeremony` |
| `draft` -> `sent` | the creator or SYSTEM_ADMIN; one live request per document (409 `ERR-SIGNING-IN-PROGRESS`); refused when the document has a newer version than the pinned one (409 `ERR-SIGNING-VERSION-STALE`) or the request's own expiry has passed (422); the document moves to PENDING_SIGNATURE; external tokens are minted and the links emailed, internal signers notified in the app | `sendSignatureRequest` |
| `sent` -> `partially_signed` -> `completed` | the named recipient only. Completion locks the request row, advances the document (SIGNED, then PENDING_AUDIT or ARCHIVED), applies the optional move-to-folder, finalises a letter, and files the PAdES (or flattened) copy after commit | `signDocument` |
| -> `voided` by decline | the recipient, only while the request is live and they have not acted; the document goes to SIGNING_DECLINED; fires the ceremony-ended hook (E27) | `declineSignature` |
| -> `voided` by cancel | the creator or SYSTEM_ADMIN, from draft, sent or partially signed (`POST /signing/:requestId/cancel`, optional reason, audited); fires the hook | `cancelSignatureRequest` |
| -> `expired` | lazily on sign or view, and by the expiry sweep worker; one transaction per request that also moves the document to SIGNING_DECLINED and fires the hook (E27) | `expireRequestNow`, `EsigningExpiryWorker` |
| recipient `pending` -> `viewed` | external view only, only while the request is live | `markRecipientViewed` |

Signing order: the request is serial or parallel. In serial mode a recipient cannot sign while a lower order index
is unsigned (equal indexes sign in parallel); the send notification still goes to everyone (informational only).

Sign checks, in order: request is `sent` or `partially_signed`; no legal hold; request not expired; serial order;
the pinned version is still the document's latest (re-checked under the lock, E23); caller is the named user, or
holds the role in the document's department, or presents the recipient's own valid
token (SHA-256 of the presented value compared in constant time; a token of another recipient does not match; a
refused token is audited, E26); recipient has not already signed or
declined; the request status is re-checked under the row lock. Signature, initial and seal fields must be
non-empty and an image value must be a PNG or JPEG data URL. Tokens stop working after sign, cancel, void, decline
or expiry. The document's tenant must equal the caller's (otherwise 404).

Document served and flattened: the signer sees, and the signed copy is flattened from, the **pinned version** (a
completed request serves its filed signed copy, `signed_version_id`). A live request whose document has a newer
version can no longer be viewed, reminded or signed (`ERR-SIGNING-VERSION-STALE`). There is no in-place re-pin: the
requester cancels and creates a new request, which pins the current version (that is the "re-send"). Requests
created before migration 20261004000021 have no pin (live ones were pinned to the latest at migration time; finished
ones stay unpinned and behave as before).

Audit trail: events are `DOCUMENT_UPDATED` rows with an `action` of `signature_request_created`, `_sent`,
`_reminded`, `_viewed`, `document_signed_partial`, `document_signed_completed`, `signature_declined`,
`signature_request_cancelled`, `signature_request_expired`, `signature_token_rejected` (failed attempts, 1 row per
recipient and address per minute), `signature_document_fetched` (external document opens, same throttle), plus
signed-copy filing. Each row carries the request id, and the address (`source_ip`) and browser (`userAgent` in the
details). **`GET /signing/:requestId/audit`** returns one request's entries in order (who, when, address, browser,
action); allowed to the requester, SYSTEM_ADMIN and `audit:read` / `document:read_all` holders on top of the
`document:read` the request detail needs. UI: a "History" toggle on "Sent for Signature" and on "All Requests".
There is no OTP and no consent step in the current flow
(consent exists only in the legacy flow). The certificate-of-completion page is part of the PAdES copy the
document download serves (`?certificate=true`; the default download omits it).

### 3.2 Who can do what

| Role | Create / send | Sign | See detail, lists, download | Cancel | Remind |
|---|---|---|---|---|---|
| Employee, dept manager, approver (`signing:read`, `signing:manage`) | create with `document:read` ACL; send only their own request | only as the named recipient (or role holder) | detail needs the `document:read` ACL on the document; the three lists show only requests they sent, completed requests of theirs and tasks addressed to them | own requests | own requests |
| Records officer | same | same | `document:read_all` bypasses the ACL, so detail of any request | own | own |
| Executive (`signing:read`, `signing:manage`) | can create and send | named only | detail of any request (`read_all`) | own | own |
| Auditor (`signing:read` only) | no (403 on create, send, remind, cancel, signer picker) | named only | detail of any request (`read_all`) | no | no |
| System administrator | same | named only | everything | any request | any request |
| External signer | n/a | token plus recipient id only | `/view` and the document bytes while the request is live | decline only | n/a |

**Oversight list:** `GET /signing/requests?scope=all` (optional `status`, `q`) is a tenant-wide, **read-only** list of
every signature request with its status, requester and recipients' states, for `document:read_all` holders
(executive, auditor, records officer, SYSTEM_ADMIN; 403 for everyone else). UI: E-Signing > "All Requests"
(`/dashboard/signing/overview`), with history per request. The other three lists stay the caller's own requests or
tasks. A head of a parent department does not see sub-department requests by that fact; visibility follows direct membership,
decided by the document ACL resolver, not by the e-signing code.

### 3.3 Findings in this module (e-signing audit)

| # | Where | Finding | Real | Fixed |
|---|---|---|---|---|
| E1 | `SignatureRecipient` model, `GET /documents/:id`, `GET /signing/:id`, send, remind, lists | Recipients' `accessToken` was serialised: any reader of the document or request could sign as the external party | yes | yes (model getter returns undefined; the service reads the raw value); probed live on the dev database |
| E2 | `declineSignature` | No state check or lock: a recipient who had signed could void a completed request; a stale token could void a cancelled or expired one | yes | yes |
| E3 | `signDocument` | Empty field values accepted: a ceremony (and a letter) completed with a blank signature; the image was unvalidated | yes | yes |
| E4 | `signDocument`, decline, document bytes | No tenant check on the signature tables (no RLS): a user of another tenant holding the role could sign a role-based recipient given the ids | yes | yes (404 on mismatch) |
| E5 | `signDocument` | Request status checked only before the lock: a decline or cancel in between could be signed over | yes | yes |
| E6 | `createSignatureRequest` | `dmsUserId` trusted: another tenant's user, an inactive user or the hidden platform admin (a probe) could be named | yes | yes |
| E7 | `createSignatureRequest` | `completionTargetFolderId` not tenant checked and written to `documents.folder_id`: a cross-tenant move | yes | yes |
| E8 | `createSignatureRequest` | Out-of-range `recipientIndex` silently went to recipient 0; a past `expiresAt` accepted | yes | yes (422) |
| E9 | `sendSignatureRequest`, `remind` | Any `signing:manage` holder with read access could send or remind **someone else's** request (every employee holds `signing:manage`; sending flips the document to PENDING_SIGNATURE) | yes | yes (creator or SYSTEM_ADMIN) |
| E10 | `sendSignatureRequest` | Two live requests on one document were possible | yes | yes |
| E11 | token expiry | Started at draft time, so a request sent later went out with a dead link | yes | yes (re-armed at send and remind) |
| E12 | `remind` | Role recipients were "emailed" a non-routable placeholder; expired requests could be reminded | yes | yes |
| E13 | `fetchSigningDocumentBytes` | A valid token still served the document after void, expiry or while draft | yes | yes |
| E14 | `markRecipientViewed` | Stamped `viewed` and wrote audit on draft, voided or completed requests | yes | yes |
| E15 | token comparison | Plain `!==` | yes, low | yes (constant time) |
| E16 | no cancel path | The only way to void a request was a recipient declining | yes | yes (new cancel route; **UI button added on the "Sent for signature" page**) |
| E17 | `esignPades.ts` | A typed name or text field in Amharic or any non-WinAnsi script made pdf-lib throw, so a "completed" ceremony never got its signed copy | yes (reproduced) | yes (ASCII fallback) |
| E18 | legacy `signing.service.ts`, reached via `/documents/:id/sign/*` | Could be called over a live e-signing ceremony, flipping the document SIGNED or SIGNING_DECLINED, signing for the pending requester, with no tenant check and unvalidated `signingType` | yes (no frontend caller) | yes |
| E19 | legacy sign routes | IP and user agent on the signature record came from the request body (forgeable evidence) | yes | yes, in `signing.routes.ts` **and** `documents.routes.ts` |
| E20 | legacy `verifySigning` | Compared against the latest version, so after a signed copy was filed older signatures read as tampered and were flipped to INVALID | yes | yes |
| E21 | e-signing routes | `NaN` skip or take reached SQL as a 500; unescaped `Content-Disposition` filename | yes | yes |
| E22 | `declineSignature` | An unclaimed role recipient could never decline | yes | yes |
| E23 | document version is not pinned on the request | The signer signed the latest version while the fields were placed on an earlier one | yes, design gap | yes: `signature_requests.document_version_id` (migration `20261004000021`), set at create; send, remind, sign (also under the lock), document fetch and the flattened copy all use it; a newer version gives 409 `ERR-SIGNING-VERSION-STALE`. **Decision:** no in-place re-pin, cancel and re-create |
| E24 | tokens | Stored in plaintext in the database and in the outbox email payload | yes | yes: only SHA-256 stored (`access_token_hash`), constant-time compare, raw token only in the emailed link; the outbox payload no longer carries `accessToken` and its link is redacted once the row is processed. **Migration of existing tokens:** each pending plaintext token is hashed in place and the plaintext cleared, so links already emailed keep working until their own expiry; delivered outbox rows are scrubbed. A reminder rotates the token (the old link dies). The legacy plaintext column stays (always NULL) for rolling deploys and is read as a fallback only when no digest exists |
| E25 | create route | `document:read` ACL plus `signing:manage` is enough to start a ceremony on any readable document | yes | yes: owner, SYSTEM_ADMIN / `acl:bypass_admin`, `document:upload` ACL holder, approver of the document, or a letter's drafter / signatory / `letter:approve` holder (for the letter's draft only). **Decision:** `document:upload` is the "stronger permission" (it is what an owner already holds and what marks write access); the whole rule is one function, `assertMayStartCeremony`, easy to change |
| E26 | audit | No audit row for failed token attempts or external document fetches | yes | yes (throttled to one row per recipient and address per minute so a link holder cannot flood the hash chain) |
| E27 | letters | A declined/voided/expired signing request left the letter in PENDING_SIGNATURE with no live request; only an admin cancel recovered it | yes (code) | yes, letters side (see 2.4 "E27 hook"): the letter returns to APPROVED on the next read; the e-signing half of the eager call now exists: `esigning.events.ts` `registerCeremonyEndedHandler`, awaited inside the decline / cancel / expiry transaction (see "Ceremony-ended hook" below); the letters module may register to recover at once instead of on the next read |
| E28 | lazy expiry in `signDocument` | Flipped the request to `expired` on the request transaction and then threw the 410: an error response rolls the transaction back, so the flip never persisted | yes (by reading the middleware) | yes (own tenant-scoped transaction, shared with the sweep) |
| E29 | `filePadesSignedCopy` | "Already filed" looked at the document's latest version, so a SECOND ceremony on a document that already carried a signed copy never produced its own; the next version number was bumped off the base version and could collide | yes | yes (per-request `signed_version_id`; bump off the latest version) |
| E30 | `esignPades.ts` | Amharic signer names and typed fields were printed as `????` in the signed legal copy and certificate page (E17 only stopped the throw) | yes | yes (Noto Sans Ethiopic subset embedded on demand, drawn in runs; only a character neither font has becomes `?`) |
| E31 | `sendSignatureRequest`, `remindSignatureRequest` | A draft whose expiry passed while unsent went out as a dead link; a reminder re-sent a token that could only be recovered from plaintext; reminder rotation and its email were not atomic | yes | yes |

Error codes the UI can now meet: `ERR-SIGNATURE-REQUIRED`, `ERR-SIGNATURE-INVALID`, `ERR-SIGNING-IN-PROGRESS`,
`ERR-RECIPIENT-INVALID`, `ERR-FIELD-INVALID`, `ERR-EXPIRY-INVALID`, `ERR-FOLDER-INVALID`,
`ERR-DOCUMENT-NOT-SIGNABLE`, `ERR-SIGNING-NOT-PERMITTED` (new), `ERR-SIGNING-VERSION-STALE` (new),
`ERR-SIGNING-EXPIRED`, `ERR-SIGNING-OUT-OF-ORDER`. Every one has readable wording in
`frontend/features/signing/errors.ts` (used by all signing pages; unit-tested).

### Ceremony-ended hook (for the letters module and any other waiter)

`backend/src/modules/esigning/esigning.events.ts`: `registerCeremonyEndedHandler(async (event, tx) => ...)`. `event` =
`{ requestId, documentId, tenantId, outcome: 'declined' | 'cancelled' | 'expired', reason, actorUserId, recipientId }`.
It is awaited **inside the transaction** that voids or expires the request (pass `tx` to every query; a throwing
handler rolls the decline / cancel / expiry back), is not called on completion nor for the documents module's silent
voids (trash, new-version supersede), and must be idempotent and act only on what it owns (look up by `documentId`).
Registration is an import side effect, so the registering module must be imported in the API process **and** in the
worker entry (the expiry sweep runs there); the sweep logs a warning when it expires something with no handler
registered.

### Not verified (E-signing)

- Sub-department-head visibility (decided by the ACL resolver).
- Behaviour under the restricted database role with RLS (the signature tables have none; isolation rests on the
  application checks above).
- A live HTTP run of the cancel, audit and oversight routes and of a real emailed link (service tests are mocked; the
  migration was run and round-tripped (up, down, up) on the dev database only).
- `test-scripts/verify-runtime-flows.ts` flow 4 reads the recipient token from the API response, which no
  response has carried since E1; it is stale and needs to read the link from the outbox row instead.
- The authenticated audit-denial writes (`resolveACL`) roll back with a failing request transaction; not
  changed here, the e-signing token audits run on the public routes, which have no ambient transaction.

---

## 4. Forms module (`backend/src/modules/forms/`, with the unified approval engine in `modules/approvals/`)

### 4.1 State machines

**Template (`form_templates.status`)**

| Transition | Who | Enforced by |
|---|---|---|
| create -> `draft` | `formtemplate:manage` (employee, dept manager, approver, executive, records officer, admins; **not** auditor) **and a scope** (see "Template scope" below: organisation-level roles may publish tenant-wide or for an org unit, everyone else for a department they belong to) | `createFormTemplate`, `assertScopeWritable`; a template name already in use in the tenant is refused (versions are keyed by name) |
| edit content while `draft` | the template's author, or a holder of `approval:admin` **inside the template's scope** (a department manager only for a template of their own department; tenant-wide and org-unit templates only for organisation-level roles) | `assertCanModifyTemplate`, draft-only check in `updateFormTemplateContent` |
| `draft` -> `pending_approval` | the author or `approval:admin`, **only** through `POST /approvals/FORM_TEMPLATE/:id/submit` | engine `submitForApproval` |
| `pending_approval` -> `active` | the assigned approver on the final APPROVE; stamps `approvedBy` **and, in the same transaction, deprecates every older active version of the same template** (same tenant and name; never a newer one) | `completeItemApproval` |
| `pending_approval` -> `draft` | REQUEST_CHANGES, DECLINE or an admin cancel | engine only |
| `active` -> `deprecated` | the author or `approval:admin` (`PATCH /templates/:id/status`, the only transition left) | `FORM_TEMPLATE_TRANSITIONS` |
| new version of an active, deprecated or pending template | the author or `approval:admin`; creates a `draft` with `version = max + 1` for the same tenant and name | `createFormTemplateVersion` |

`active` can never be set directly (`ERR-FORM-APPROVAL-REQUIRED`). A template whose newer version is active is now **deprecated** by the
engine at that moment (it no longer accepts submissions and drops out of the `status=active` list; the
`ERR-TEMPLATE-SUPERSEDED` check and the superseded filter stay as defence in depth, and migration `20261004000020`
deprecated the old versions that had already been left active). Template content
is validated on save: structure, unique field names, at most 300 fields, validation regexes must compile, at most
200 characters and may not contain nested or alternating quantifiers (a heuristic, not a proof); a base-PDF object key
must live under the tenant's own `forms/base-pdfs/` prefix.

**Instance** (no status column of its own; the backing document's status carries the lifecycle)

- `POST /forms/instances` needs `document:upload` (so **approvers and auditors cannot fill a form**), membership of
  the chosen department, and an `active`, non-superseded template. The service validates the values server side,
  derives computed fields itself, drops hidden fields, renders the PDF, scans, encrypts and files it, files
  attachments as separate documents and reserves tenant storage quota, all in one transaction. The stored
  `dataJson` is the server-derived value set, never the raw request body.
- Template `instanceApproval = none`: the document is `ACTIVE` and finished. `= chain`: the document is `DRAFT`
  and is auto-submitted to the engine, becoming `IN_REVIEW`. If the auto-submit fails the instance stays `DRAFT`
  and the response carries `approvalWarning`; the author retries with `POST /approvals/FORM_INSTANCE/:id/submit`.
- **The filer's own pre-approval lifecycle (2026-10-04, audit E7; chain templates only).** `POST /forms/instances` with
  `saveAsDraft=true` files the form as a `DRAFT` without submitting it (422 `ERR-FORM-DRAFT-NOT-USED` for a template with no
  approval). `PATCH /forms/instances/:id` edits it while the document is `DRAFT`, `CHANGES_REQUESTED` or `DECLINED`: same
  server-side validation as filing, the PDF is re-rendered and filed as a **new minor version of the same document** (old
  versions kept; replaced attachments stay as ordinary documents), `dataJson` is re-derived, `updatedAt` set, audit
  `FORM_INSTANCE_EDITED` on the document (changed field *names*, not values). `POST /forms/instances/:id/withdraw` recalls it
  from review (`IN_REVIEW` -> `DRAFT`, running chain cancelled, approvers notified `APPROVAL_WITHDRAWN`, audit
  `FORM_INSTANCE_WITHDRAWN`); `POST /forms/instances/:id/cancel` abandons it (document `CANCELLED`, terminal, audit
  `FORM_INSTANCE_CANCELLED`). Guards: the filer only (not even an approval admin, who has `cancelChain`); never while `IN_REVIEW`
  (409 `ERR-FORM-IN-REVIEW`: withdraw first); template must still be the active, un-superseded version (else
  `ERR-TEMPLATE-INACTIVE` / `ERR-TEMPLATE-SUPERSEDED`: file again on the new version); document ACL `document:upload`, legal hold and
  tenant checked; an edit never changes the status, approval is only ever reached by the normal submit. A form with no approval
  stays final once filed (`ERR-FORM-NOT-EDITABLE`).
- If no department is given the filing uses the caller's own first department; a caller with no department gets
  422 `ERR-DEPT-INVALID` (unless `acl:bypass_admin`).

**Approval chain**: `IN_REVIEW` -> `APPROVED`, `DECLINED`, `CHANGES_REQUESTED` (then a resubmit starts a new chain)
or `CANCELLED` (by `approval:admin`). Steps are sequential (one `PENDING`, later ones `WAITING`); a step is
APPROVED, CHANGES_REQUESTED, DECLINED or CANCELLED. Locked mandatory steps of the template must appear unchanged
and in order; the final step must be APPROVE. Decide guards: chain `IN_REVIEW`, step `PENDING`, step assigned to the
caller, caller holds `approval:decide`, the author or submitter may not APPROVE their own item, no legal hold, role
steps limited to members of the document's department unless the caller holds `document:read_all`, DECLINE needs a
comment. **Delegation and escalation (2026-10-04, finding #23):** see section 4.4. On the final APPROVE of a form instance the **template's own** policies apply: the form reference number
is allocated; `signingPolicy = ceremony` leaves the document `ACTIVE` awaiting a signature request;
`auditPolicy` with a named independent auditor moves it to `PENDING_AUDIT`; otherwise it is `ARCHIVED`.

### 4.2 AI "build a form from a photo or PDF"

The route requires `formtemplate:manage` **and** `ai:use` (checked before the upload is parsed; upload capped at
15 MB, 25 parts). In the service: (1) the tenant's `ai_processing` flag and the `form_extraction` switch are
verified (a refusal is written to `ai_usage_events`, no quota used); (2) mime and size check, ClamAV scan, decode;
(3) the quota is debited immediately before the first provider call; (4) the outcome (`completed` or `failed`) is
recorded in the usage ledger. Before the fix the debit came first, so rejected uploads consumed quota and the
ledger never showed the outcome.

### 4.3 Who can do what

| Role | Build own template | Edit others' | Submit / approve a template | Fill a form | AI from photo | See templates | See others' submissions |
|---|---|---|---|---|---|---|---|
| Employee | yes | no | submit own; approve if assigned | yes, into own department | yes | those in their scope (tenant-wide, their departments, their own; see Template scope), any status | own, plus own department |
| Dept manager | yes | yes (`approval:admin`) | yes | yes | yes | all | department scope |
| Approver | yes | no | yes | **no** (no `document:upload`) | yes | all | only forms routed to them |
| Executive | yes | no | yes | yes | yes | all | all (`document:read_all`) |
| Records officer | yes | yes | yes | yes | yes | all | all |
| Auditor | **no** | no | no | no | no | all | all; decides only audit stages it is named on |
| System admin | yes | yes | yes | yes | yes | all | all |

**Template scope (2026-10-04, audit item 6; migration `20261004000020`).** `form_templates.department_id` / `org_unit_id`
(never both; both null = the whole organisation, which every existing template keeps). Same rule as a document type: a
department scope covers exactly that department, an org-unit scope every department under it. Who may set it: organisation-level
roles (`acl:bypass_admin`, `orgunit:manage`, `document:read_all`, the set that may define tenant-wide document types) any
scope; everyone else only a department they belong to (422 `ERR-FORM-SCOPE-REQUIRED`, 403 `ERR-FORM-SCOPE`); ids are validated against
the tenant (`ERR-FORM-SCOPE-INVALID`). The list is filtered like `GET /document-types` (tenant-wide, scoped to a department / org
unit the caller can see, or authored by the caller; administrators and read-all roles see all); a template outside the caller's
scope reads as `404` (its author, organisation-level roles and anyone holding a step on its approval chain excepted); filing needs
the template to cover the filing department (403 `ERR-FORM-TEMPLATE-SCOPE`, `acl:bypass_admin` exempt); a new version inherits the
scope. `approval:admin` (every department manager) only reaches templates inside its own scope.

**Approval of the template itself (audit E6).** A recipe may now target "the approval of form templates"
(`approval_chain_templates.for_form_templates`) and every recipe may be scoped to a department or org unit (most specific wins at
submit: department, then org unit, then tenant-wide; a recipe scoped elsewhere never applies; one active recipe per target **and
scope**). With no recipe the default chain is: a **department-scoped** template -> APPROVE by `DEPT_MANAGER` of that department
(the role step is scoped to it); a **tenant-wide or org-unit** template -> APPROVE by an organisation-level role (`SYSTEM_ADMIN`),
because there is no single department to scope a manager to. Reassigning or cancelling the approval of such a template needs an
organisation-level role (403 `ERR-FORM-TEMPLATE-ORG-SCOPE`), otherwise any department manager could take it over through
`approval:admin`. Consequence, recorded as a decision: a sole administrator who authors a tenant-wide template cannot approve it
(no self-approval); another approver, or a recipe naming one, is needed.
A submission is visible through the access control list of its backing document: the owner, members of the
document's department or an ancestor department, deliberate per-user grants (chain participants, auditors,
signatories) and `document:read_all` holders. Every member of the filing department can see the form, not only the
author and approvers. Download and attachments are served by the document routes (see section 1).

### 4.4 Delegation and escalation (finding #23, 2026-10-04; `approvals/delegation.service.ts`, `escalation.service.ts`)

**Delegation**: `POST /approvals/chains/:chainId/steps/:stepId/delegate` { toUserId, reason? } (`APPROVAL_DELEGATION_ENABLED`). The
person a step is assigned to (named, or holder of the assigned role) hands it to **one** other user. The step becomes a named
step for the delegate (`delegated_by`, `delegated_from_role`, `delegated_at`, `delegation_reason` recorded), the delegate is granted
read on the item and its attachments, audit `APPROVAL_STEP_DELEGATED`, delegate notified. No escalation of rights: the delegate must
be an active tenant member holding `approval:decide`; inside the item's department (or reading across departments), so no
document access is created that a department member did not already have; for a role step a holder of the **same role**; for an
organisation-wide form template an organisation-level role; never the delegator, the item's author or submitter (self-approval),
never the hidden platform administrator (404 like an unknown user). Mandatory (locked) recipe steps cannot be delegated
(`ERR-STEP-LOCKED`, an approval admin still reassigns them) and a delegated step cannot be delegated again
(`ERR-STEP-ALREADY-DELEGATED`). Codes: `ERR-DELEGATE-OUT-OF-SCOPE`, `ERR-DELEGATE-SELF`, `ERR-DELEGATION-DISABLED`.

**Escalation**: the SLA worker (every 15 min) already flags an overdue step (`sla_breached_at`) and notifies. After
`APPROVAL_ESCALATION_GRACE_HOURS` (default 24) the step is escalated once: the **department head(s)** of the item's department
(members holding `approval:decide` + `department:manage`; the nearest parent department that has one if it has none), else the
tenant's **approval admins** (`approval:decide` + `approval:admin`, in the department or reading across departments), at most
`APPROVAL_ESCALATION_MAX_TARGETS` (default 3), are **added as co-deciders** (`escalated_to_user_ids`). The assignee keeps the step, it
stays PENDING, and the decide path, department scope, self-approval rule and audit are unchanged for an escalatee; they also see it
in My Work (`escalatedToMe`) and get read access. Never the assignee, author, submitter or the hidden platform administrator. If nobody
qualifies the step is still marked escalated (audited with no targets) so it is not retried forever. Audit
`APPROVAL_STEP_ESCALATED`, notification `APPROVAL_STEP_ESCALATED` to the escalatees, the assignee and the submitter. One switch and three
numbers, all in `config/env.ts`: `APPROVAL_ESCALATION_ENABLED`, `_GRACE_HOURS`, `_MAX_TARGETS` (and `APPROVAL_DELEGATION_ENABLED`). A
reassignment by an approval admin clears any delegation / escalation on the step.

### 4.5 Findings (forms audit)

| # | Where | Finding | Real | Fixed |
|---|---|---|---|---|
| F1 | template edit, deprecate, reopen, fork | `formtemplate:manage` (every employee) allowed changing anyone's template; no author check | yes | yes (author or `approval:admin`) |
| F2 | `PATCH /templates/:id/status` | Bypassed the engine: `draft -> pending_approval` without a chain, edit during approval then approve-and-swap, reopening a live template | yes | yes (only `active -> deprecated` remains) |
| F3 | `basePdfObjectKey` | A client-supplied key was read from any tenant's storage and returned by `/templates/preview` | yes (code) | yes (tenant prefix, no traversal) |
| F4 | `schemaJson` | Unvalidated: a malformed schema gave a 500 on every fill; an author's regex ran against submitters' input (ReDoS) | yes | yes (heuristic; existing templates not re-validated) |
| F5 | filing without a department | Filed under the tenant's alphabetically-first department with no membership check: the PDF became readable by an unrelated department and the manager step was scoped to it | yes | yes (caller's own department, 422 otherwise) |
| F6 | instance `dataJson` | Stored the raw request body: forged computed values, hidden-field leftovers, extra keys | yes | yes |
| F7 | hidden `file` field | Still required, and still filed and printed if uploaded | yes | yes |
| F8 | filing | Never reserved storage quota although trash and purge decrement it | yes | yes |
| F9 | new active template version | The old active version kept accepting submissions | yes | yes: root fix in the engine (E1); the forms-module compensation stays as defence in depth |
| F10 | `GET /instances/:id` | Served instances whose document was purged (`document_id` is `ON DELETE SET NULL`; null skipped the ACL check so any reader could read the data; 85 of 86 dev instances have a null `document_id`), trashed documents, ignored the status-conditioned `read` rule, and answered 403 instead of 404 for another tenant's id | yes (live data) | yes |
| F11 | `GET /instances` | Listed trashed forms; unvalidated `createdBy`/`templateId` (500); NaN or negative paging | yes | yes |
| F12 | template list/detail | The hidden platform admin appeared as a template's `approver` | yes | yes (redacted on the response copy) |
| F13 | template names | Duplicate names let unrelated templates hide each other (versions are keyed by name) | yes | yes |
| F14 | AI extract | Debit before validation; no completed/failed ledger rows; 100 MB buffered before the 15 MB check | yes | yes |
| F15 | routes | Bad `dataJson` gave 500; unbounded upload parts | yes | yes |
| E1 | `approvals.service.ts` `completeItemApproval` | Activating a template version does not deprecate the previous active one | yes | yes: older active versions are deprecated in the same transaction (never a newer one), audited per template; the migration deprecates those already left active |
| E2 | engine audit events | Events for FORM_INSTANCE carry no `documentId`, so the backing document's audit trail shows nothing about the form's approval | yes | yes: every engine event carries the backing document id plus `formInstanceId` / `formTemplateId`; notifications carry `documentId` so they deep-link to the form |
| E3 | engine | Audit-stage reviews for forms are created with `itemType DOCUMENT`, but `getChain` queries them by `FORM_INSTANCE`, so a form's chain view never lists its audit reviews | yes (code, pinned by test) | yes: **decision: keyed by the backing document** (all audit machinery works on document ids); `getChain` looks them up as DOCUMENT / document id |
| E4 | `getChain`, `getChainHistory` | No hidden-admin redaction; a named step can be assigned to a hidden admin by id | yes | yes: submitter, assignee, decider, delegator, escalatees and audit-review people are redacted (also in My Work); the account can no longer be named as assignee, template-recipe assignee, delegate or auditor (404 like an unknown user) |
| E5 | `grantChainParticipantAcl` | Grants read only on the main PDF: a named cross-department approver cannot open the form's attachment documents | yes | yes: every grant (submit, reassign, delegate, escalate, auditor) also covers the form's attachment documents (tenant re-checked, ACL cache invalidated for each); signed copies are versions of the same document so were already covered; the audit reassign / re-submit paths now grant too |
| E6 | FORM_TEMPLATE approval | No recipe: a tenant-wide DEPT_MANAGER step with no department, so any manager from any department can activate a company-wide template | yes | yes: template scope + recipe scope + a recipe target for template approval + scope-aware default + organisation-level reassign / cancel (section 4.3, "Approval of the template itself") |
| E7 | no instance edit route | REQUEST_CHANGES can only lead to a resubmit of identical data or a new filing | yes | yes: draft / edit / withdraw / cancel for the filer (section 4.1), UI on My submissions |
| F16 | `assertCanModifyTemplate` | `approval:admin` (every department manager) could edit, deprecate or fork ANY template of the tenant, including another department's and tenant-wide ones | yes | yes: only inside the template's own scope |
| F17 | `prepareSubmission` (new, shared by filing and editing) | A required `file` field validated as a required string, so a form could only be filed if the client echoed the file name into `dataJson` | yes (found while writing edit) | yes: a file that is supplied (or already filed) counts as the value |
| F18 | `reassignAuditor`, `resubmitToAudit` | A cross-department auditor picked at these steps was never granted read access (only the first assignment was) | yes | yes |
| F19 | approval notifications for FORM_INSTANCE | Carried no document id, so they deep-linked to My Work instead of the form | yes | yes |
| F20 | `GET /forms/templates/:id/approval-prefill` vs the engine | The fill dialog resolved the form's recipe from the form template only; the engine also falls back to the FORM document type's recipe, so the picker could show a different chain | yes | yes: both use `findFormInstanceRecipe` |
| F21 | `test-scripts/verify-form-reference-numbers.ts`, `verify-forms-approval-selection.ts` | Name the author as approver of their own template, which the self-approval rule (U10) already refuses; written before it | yes (not run: needs the live stack) | no, see "Not verified" |

### Decisions taken (forms and engine, 2026-10-04)

- **Audit reviews stay keyed by the document** (E3): the other direction would have meant rewriting the audit decide / resubmit / reassign / My Work paths and migrating rows.
- **A department-scoped template or recipe applies to that exact department** (not its sub-departments), like a document type.
- **Tenant-wide and org-unit templates are organisation-level**: their default approver is `SYSTEM_ADMIN`, their approval is reassigned / cancelled by organisation-level roles only. An org-unit-scoped default approver would have needed org-unit support in every role-holder query (picker, notification, SLA, My Work); not done.
- **`APPROVER` keeps `formtemplate:manage` (nothing removed, nothing added).** It is pinned on purpose by `permissions.matrix.test.ts` (2026-09-16: ordinary staff, approvers included, may build form templates); an approver authoring a form for others to fill is coherent, no other flow depends on removing it, and a tenant that disagrees changes it in the Role Editor. They still cannot *fill* a form (no `document:upload`).
- **Edits are refused against a template version that is no longer active**: file again on the new version rather than silently re-validating old data against a different schema.
- **Replaced attachments are kept** as ordinary documents (no data is deleted by an edit).
- **Locked recipe steps cannot be delegated; a delegated step cannot be delegated again; a delegate must already be in the item's department.** Cross-department hand-over stays an approval admin's reassign.
- **Escalation adds co-deciders, it never removes the assignee**, and is on by default (24 h grace, 3 people); `APPROVAL_ESCALATION_ENABLED=false` turns it off.

### Not verified (Forms)

- The new routes over live HTTP (the backend was not started; behaviour is proven by jest with the data layer mocked, plus the new SQL run against the dev database: the scope columns, both unique-index swaps and the check constraints in a rolled-back transaction, and the new Sequelize queries, `Op.contains` on the uuid array, the escalation sweep and the scope filter, executed for real).
- Delegation, escalation and withdraw in the browser, and the frontend of all of this (typecheck, eslint and vitest only: `features/approvals/{errors,stepAccess}`, `features/forms/{instanceActions,templateScope}`, the chain card's Delegate dialog, scope selector in the template builder and recipe editor, Save as draft / Edit / Withdraw / Cancel on My submissions, the "Escalated to you" badge in My Work). The delegate picker is limited to the item's department where the page passes `departmentId` (My submissions, form-template approval); on the document page it lists the whole organisation and the server refuses an out-of-scope pick with `ERR-DELEGATE-OUT-OF-SCOPE`.
- `test-scripts/verify-form-reference-numbers.ts` and `verify-forms-approval-selection.ts` were not run and not updated (finding F21).
- The full backend jest run still shows failures in the letters suites (`letters.reassignCancel`, `letters.followUp`, `letters.scopeWhere`, `letters.byDocument`): their mocks of `shared/platformAdmin` predate the letters work in progress (`maskHiddenUsersDeep`), not this change; every approvals, forms, stepRules, permissions-matrix and audit-catalog suite passes.
- The escalation sweep inside the BullMQ worker (Redis is down in dev); `escalateOverdueSteps` itself is unit-tested.
- A full HTTP filing run (Redis is down in dev; the dev database holds no FORM_INSTANCE chains to observe).
- Signing-ceremony completion for forms, and the auditor/PAdES path.
- The ReDoS check is a heuristic.

---

## 5. Cross-module summary (decisions still open)

| Topic | State |
|---|---|
| Classification as an access control | Letters (L14): participants + oversight only. **Ordinary documents: decided and built 2026-10-10** (see section 1.3). Existing documents are not rewritten: the rule reads the class live, and `npm run report:classified[:mirror|:prod]` lists which documents will close and who loses access, before deploying. |
| Document version pinned on a signature request | Pinned at create (E23); `document_version_id`. |
| E-signing access tokens | SHA-256 only; raw token in the emailed link alone (E24). |
| Letters self-approval | Closed (L15): same rule and recovery as the engine. |
| Letters versus documents scope | Decided (L18): direct membership plus read-only subtree for department heads; narrower than documents on purpose. |
| Form templates | Scoped (department / org unit / tenant-wide) and approved by a scope-aware recipe (E6, done). |
| Engine follow-ups | E1 to E7 and delegation / escalation done (sections 4.3 and 4.4). Letters still have no delegation or escalation. |
| Antivirus | Fail-open when ClamAV is down (flagged `unscanned`). |
