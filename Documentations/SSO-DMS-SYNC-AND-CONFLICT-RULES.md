# SSO and DMS: how people stay consistent, and who wins a conflict

Verified against the code on 2026-10-04 (brief item 5.7). Everything below was read in
source; the few things that could only be checked on the live server are listed at the end.
Code references are to functions, not line numbers, because the files are moving.

The identity vocabulary is deliberate: `edams` / `EDAMS` is the token and database contract
(`https://edams.examplecorp.com/roles`, `idp_role_mappings.relying_party = 'edams'`). Do not rename it.

## 1. The shape of the integration

There is **no background reconciliation** between SSO and DMS, in either direction. Consistency
comes from three things only:

1. **Login time.** Each SSO sign-in to DMS re-derives the DMS account and its roles
   (`completeOidcCallback` in `auth.service.ts`, with the decisions in `modules/auth/ssoIdentity.ts`).
2. **Pushes at admin time.** SSO's admin console writes into DMS through the shared-secret internal
   API (`/api/v1/internal/roles/tenants/:tenantId/...`, `modules/roles/internal.routes.ts`; client:
   `SSO/backend/src/admin/dms-internal-client.ts`), and ends DMS sessions with a signed
   backchannel-logout (`SSO/backend/src/auth/logout-notify.ts` to DMS `POST /auth/backchannel-logout`).
3. **An on-demand report.** `SSO/backend/scripts/dms-drift-report.ts` (read-only) lists accounts that
   are off in SSO and still active in DMS.

The only other loop is SSO's own `ad-resync.worker.ts`, which re-checks **AD group membership** of
users with a live SSO session and revokes their sessions when membership narrows. It does not talk to DMS
except through the same revoke.

## 2. The flows, in order

### 2.1 Sign-in to DMS (`completeOidcCallback`)

1. Browser-binding cookie checked, then the code is exchanged at SSO's token endpoint (no retry: the
   code is single use). The id_token is verified against SSO's JWKS, the nonce must match, and
   `email_verified` must be `true`. `sub` and `email` are required.
2. `resolveOidcUser` finds the DMS account (rules in section 3, rows C1 to C8).
3. The account must be `is_active` and not soft-deleted, else 403 `ERR-AUTH-INACTIVE`.
4. `applyPendingSsoDepartments`: a department set picked in the SSO console before the user ever signed
   in (`sso_pending_department_assignments`, keyed by lower-cased email) replaces the user's department
   memberships once and is deleted.
5. Roles: the SSO claim `https://edams.examplecorp.com/roles` if present, else the user's AD groups claim
   mapped through `idp_role_mappings`. `filterToKnownRoles` drops names DMS has no role for.
   `resolveEffectiveRoles` decides the final set (section 4). When SSO's set wins it is mirrored into
   `user_roles` (`syncUserRolesFromSso`), because `refreshSession` reads only `user_roles`.
6. `SSO_ROLES_SYNCED` is audited when the stored set actually changed; `AUTH_LOGIN` is audited as before.
7. Tenant and role selection, then DMS issues its own RS256 access and refresh tokens. Their lifetime is
   `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` (code defaults 15m / 8h; this checkout's
   `.env.production` and `.env.mirror` both set 8h / 8h).

### 2.2 What SSO puts in the claim (`SSO/backend/src/auth/client-role-claims.ts`)

`claimsFor` resolves the user's SSO groups (`idp_user_groups`, including the per-user group
`CN=user:<id>,OU=Users,DC=examplecorp,DC=com`) through `POST .../role-mappings/resolve`. An account in no
group, or whose groups map to nothing, gets `["EMPLOYEE"]`. If DMS cannot be asked (no key, timeout,
error) the claim is **omitted**, never defaulted, and DMS falls back to its own tables.

### 2.3 Admin changes in SSO that reach DMS

| SSO action | DMS effect | Sessions |
|---|---|---|
| Save a user's access (`applyAccess`) | writes the group's mapping (`PUT role-mappings/:groupDn`, full replace), then entitlement | revoked only if something changed |
| Group DMS role (`/groups/dms-role`) | same PUT for the group | revoked for every member if changed |
| Add or remove a user from a group | none directly (takes effect at next login) | revoked for that user |
| Disable or enable a user | none (DMS keeps its own `is_active`) | disable revokes everything, including the DMS notification |
| Departments | `PUT users/by-email/:email/departments` (replace); pending row if the user is not in DMS yet | none |

"Sessions revoked" means `revokeAllSessions`: SSO's own artifacts, portal and gateway sessions, GMS
sessions, and the signed DMS notification, which sets a per-user revocation cutoff in DMS
(`revokeAllUserSessions`). After the cutoff every earlier DMS access and refresh token is dead.

## 3. Conflict rules: identity, status, email (who is authoritative)

SSO is authoritative for **who a person is, whether they may sign in, and (by default) their roles**.
DMS is authoritative for what the person can do **inside** DMS beyond the role names: permission
overrides, department membership edits made in DMS, and the DMS-side `is_active` flag.
DMS can only ever be **more restrictive** than SSO about access: both systems must say yes.

| # | Situation | Rule | Where |
|---|---|---|---|
| C1 | Known `sub` | The account found by `external_sub` is the identity. Email is never used to find it. | `resolveOidcUser` |
| C2 | Unknown `sub`, one DMS account matches the email **ignoring case**, no `sub` on it | Adopted once: `external_sub` recorded. Audited as `SSO_ACCOUNT_LINKED`. (Exact-case matching was the old behaviour; the unique index is case-sensitive, so `Alice@x` and `alice@x` could become two accounts.) | same |
| C3 | The matching account already has a **different** `sub` | Refused, 409 `ERR-OIDC-SUBJECT-CONFLICT`. An administrator decides. (Reissued address, namesake.) | same |
| C4 | **Two** DMS accounts match the email ignoring case | Refused, 409 `ERR-OIDC-EMAIL-AMBIGUOUS`. Nothing is guessed, merged or created. | same |
| C5 | No match | Provisioned (JIT): lower-cased email, unusable password, membership of the default tenant, audited `SSO_USER_PROVISIONED`. | same |
| C6 | Two first-time callbacks race | The loser's unique violation (`users_external_sub_unique`, `users_email_key`) re-reads by `sub` and uses the winner's row. A violation with no row for this `sub` is 409 `ERR-OIDC-EMAIL-CONFLICT`, not a 500. | same |
| C7 | SSO changed the email of a known `sub` | DMS follows (lower-cased), audited `SSO_EMAIL_UPDATED` with old and new. If another DMS account already holds the new address: refused, 409 `ERR-OIDC-EMAIL-CONFLICT`, nothing changed. | same |
| C8 | The platform administrator's email differs | Not changed (the database trigger forbids renaming it). Logged. | same |
| S1 | Disabled in SSO, active in DMS | SSO sign-in is refused at SSO. The notification ends existing DMS sessions (cutoff). DMS's `is_active` is **not** changed. Re-enabling in SSO needs no DMS action. | `revokeAllSessions` |
| S2 | Deactivated or soft-deleted in DMS, active in SSO | DMS wins: sign-in gives 403 `ERR-AUTH-INACTIVE`, refresh gives 401. SSO cannot re-activate a DMS account. (The callback now also checks `deleted_at`, as refresh already did.) | callback, `refreshSession` |
| S3 | Disabled in SSO and the DMS notification fails | Retried (3 attempts, 4 s each, short backoff; 1 attempt while DMS is known to be down), then logged as an ALERT and recorded as `dmsNotified:false` in the SSO audit row. The DMS session then lives until its token lifetime (8h in this checkout). Run `dms-drift-report.ts`, and force-logout the user in DMS. | `notifyDmsLogout` |
| S4 | Deleted in SSO | SSO has no user-delete (only a rollback of a failed create, before any DMS account exists). Disable is the operation. An AD user that vanished from AD is skipped by the resync worker and stays active until an administrator disables them. | `ad-resync.worker.ts` |
| S5 | Deleted (soft) in DMS | Sets `deleted_at` and `is_active=false`, revokes sessions. The row keeps its `sub` and email, so the same person cannot be re-provisioned: sign-in is refused, and `createUser` answers 409 for the address. | `softDeleteUser` |

## 4. Conflict rules: roles

| # | Situation | Rule | Where |
|---|---|---|---|
| R1 | Default | SSO's assertion wins and is mirrored into `user_roles`. Roles SSO no longer asserts are removed. | `syncUserRolesFromSso` |
| R2 | A DMS admin assigned or removed a role in DMS's own UI (`rolesManagedLocally`), and SSO's assertion is unchanged since the last time it won (`sso_roles_snapshot`) | The DMS edit stands. | `resolveEffectiveRoles` |
| R3 | Same, but SSO's assertion **changed** | SSO wins and clears the local flag. The two surfaces take turns; a genuine SSO change is not blocked by an old DMS edit. | same |
| R4 | A DMS edit exists but **no snapshot** was ever recorded (user predates the column or never had an SSO-won login) | The DMS edit stands and the current assertion is recorded as the baseline. Before this change a missing baseline compared as "changed" and the edit was wiped at the next login. | same |
| R5 | SSO asserts nothing (DMS down at mint time, claim omitted, no groups mapped, or every name unknown) | Local roles are kept. Never strips. With no local roles either: `EMPLOYEE`, written. | same |
| R6 | A role name SSO sends that DMS does not have | Dropped before the comparison and before the token, logged. If nothing survives, R5 applies. (Before: the token carried a role with no permissions while `user_roles` kept the old set, and the next refresh disagreed with the login.) | `filterToKnownRoles` |
| R7 | A group mapping is saved naming a role DMS does not have | Refused, 422 `ERR-ROLE-NOT-FOUND`. Duplicates collapse. `PLATFORM_ADMIN` is refused with the generic 422 `ERR-ROLE-INVALID`. | `assertMappableRoleNames`, `PUT role-mappings/:groupDn` |
| R8 | A mapping row exists for a role later deleted from DMS | Harmless: ignored at login by R6. It is not cleaned up automatically. | n/a |
| R9 | Role downgrade in SSO (mapping or membership changed) | Existing DMS sessions are cut by the notification; the next sign-in re-derives roles. DMS's `refreshSession` never re-asks SSO, it reads `user_roles`. If the notification failed (S3) the old roles persist until the token expires. | section 2.3 |
| R10 | `PLATFORM_ADMIN` | Outside the exchange in both directions: a claim or mapping naming it never grants it to anyone, an account that holds it keeps it whatever SSO says, the mapping API refuses it, the role and its mapped group are invisible on the internal API, and the status endpoint answers for it exactly as for an unprovisioned account. The database triggers (`20261004000002-platform-admin-protection.sql`) repeat the rule. | `resolveEffectiveRoles`, `syncUserRolesFromSso`, `internal.routes.ts` |

Departments have **no turn-taking**: a department set saved in the SSO console (or a pending one consumed at first
login) replaces the user's DMS memberships wholesale, so it overwrites edits made in DMS, and the reverse. Last writer wins. This was left as is
because it is a product decision (see section 6). The v1 access endpoint now writes departments only when the request
carries a department list.

## 5. DMS unreachable when SSO changes something

* Mapping write fails (`applyAccess`): the call fails with the DMS error's own status and code
  (`ERR-DMS-UNREACHABLE` / `ERR-DMS-TIMEOUT`, 503; a DMS 4xx keeps its status), sessions are not revoked, and the
  IdP-side entitlement is returned to exactly its previous state. Before: a failed re-save deleted an entitlement that
  existed before the call, and a failed "clear access" deleted the entitlement and then failed, leaving the DMS mapping live.
  A failure of the compensation itself is audited as `entitlement.desync`.
* No automatic retry of the write and no queue: the admin sees the failure and repeats the save.
* The save form is now disabled while the DMS read behind it failed (it would otherwise post an empty role and
  department set and wipe the user's real access).
* Claim minting while DMS is down: the claim is omitted (section 2.2) and DMS falls back to its own tables.

## 6. Decisions left open (the safe default is implemented)

1. **Departments: who wins?** Today last writer wins (SSO console versus DMS admin). A turn-taking rule like roles would need a
   snapshot of what SSO last set.
2. **Pre-created DMS users.** A DMS admin who creates a user with roles before the first SSO sign-in does not set the "managed
   locally" flag, so SSO's assertion wins at the first login. Setting the flag in `createUser` would make pre-assigned roles
   stick; not changed.
3. **Automatic drift healing.** The drift report only reports. Auto-deactivating in DMS when SSO disables would be a DMS write
   triggered by a generic logout token, and the token cannot distinguish a disable from a sign-out.
4. **Cleaning orphan mappings** when a DMS role is deleted (R8).
5. **Case-variant duplicate accounts** (C4) are refused, not merged; merging users moves documents and needs a decision per case.
6. **Passwordless login.** `LOCAL_JWT_MOCK` skips SSO entirely, so SSO-side disable does not stop it. `.env.production` and
   `.env.mirror` in this checkout set it to `false` (the root `CLAUDE.md` still says production runs with `true`, which is
   superseded by the comment in `config/env.ts`); the live server's file was not read.

## 7. Audit trail of the sync

DMS: `SSO_USER_PROVISIONED`, `SSO_ACCOUNT_LINKED`, `SSO_EMAIL_UPDATED`, `SSO_ROLES_SYNCED` (added and removed roles), `AUTH_LOGOUT`
(`via: idp-backchannel-logout`), `ROLE_MAPPING_UPDATED` (internal mapping writes; actor asserted by SSO), `USER_DEPT_ASSIGNED` /
`USER_DEPT_REMOVED`. SSO: `group.dms_role`, `user.access`, `user.disable` (with the `revoked` result incl. `dmsNotified`),
`entitlement.desync`. A platform administrator's own rows are written without identifying fields by `writeAuditLog`.

## 8. Not verifiable from the code

* Whether the notification ever failed on the live server (needs the SSO audit rows and the `[idp:logout-notify:ALERT]` log lines).
* The live `.env.production` values (`LOCAL_JWT_MOCK`, token lifetimes, `DMS_BACKCHANNEL_LOGOUT_URI`, `DMS_INTERNAL_API_KEY`).
* Whether the 200+ legacy accounts contain case-variant duplicates. Check on the live database:
  `SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`
* A user created in DMS locally and never signed in through SSO has no `external_sub`, so the backchannel logout cannot find them.
