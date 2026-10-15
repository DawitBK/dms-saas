# UI/backend parity sweep

Completed 2026-09-18 against the 32 mounted backend route modules in
`backend/src/api/v1/index.ts`, all frontend API call sites, and the production
route build. This is a caller/contract review, not a claim that every
permission combination has been manually clicked in a production browser.

## Route-family inventory

| Backend route family | Frontend consumer or intentional non-UI surface |
| --- | --- |
| access-rules | `features/access-control/AccessControlCenter.tsx` |
| acl | `features/access-control/AccessControlCenter.tsx`, user-management hooks |
| ai | Dashboard AI and document-detail AI actions |
| approvals | `features/approvals/*` and Operations approval panels |
| assignment-advisory | Shared advisory notice used by letter/signing approval flows |
| audit | `features/operations/AuditPanels.tsx`, document audit hooks |
| auth | Login/select-role/select-tenant/callback pages, settings, auth store |
| bundles | Bundle pages and `features/bundles/*` |
| comments | `features/comments/CommentsPanel.tsx` |
| departments | Admin panels, hierarchy browser, upload/forms/letters/user flows |
| document-types | Upload and admin configuration panels |
| documents | Documents, files, browse, upload, trash, document-detail, shared preview |
| status-permissions | `features/access-control/StatusRulesTab.tsx` |
| e-signing | Dashboard signing pages and public signer page |
| feature-flags | Operations system panel |
| folders | Browse, hierarchy and admin panels |
| forms | Forms pages and `features/forms/*` |
| legal-hold | `features/legal-hold/LegalHoldConsole.tsx` |
| letters | Letter pages and `features/letters/*`; public verification is intentional |
| notifications | Dashboard notifications, dashboard widgets and document hooks |
| operations | Dashboard health and Operations system panels |
| org-units | Admin panels, hierarchy, letters and access-control flows |
| reports | Dashboard/reports pages and Operations compliance reports |
| retention | `features/retention/RetentionConsole.tsx` and operations records panel |
| roles | Role editor/list and user-management flows |
| search | Search page and saved-search controls |
| signing | Signing dashboard, pending/completed/sent pages and public signer flow |
| tenants | Tenant administration, switcher and user administration |
| users | Settings, user administration, letters/signing selectors and upload flows |
| webhooks | Operations system panel |
| workflow | My Work, document flows and Operations workflow panels |
| internal/roles | Intentionally no browser caller: this is an IdP-to-DMS shared-secret bridge, mounted outside JWT authentication. |

## Corrections made during this sweep

`AuditLogPanel` and `ComplianceReportsPanel` previously used direct `fetch()`
for authenticated blob exports. They now use `apiClientBlob`, so export requests
receive the same Bearer-token injection, one-time refresh/retry, credentials,
and structured error handling as all other authenticated UI calls.

The remaining direct `fetch()` calls are intentional and reviewed:

- pre-authentication login, role-selection, tenant-selection and callback flows;
- auth-store role/tenant token rotation, which cannot import `apiClient` without
  creating its import cycle;
- public letter verification and external e-signing token flows;
- the service worker's generic network/cache behavior.

No frontend application caller hard-codes an API host. `API_BASE_URL` is the
single origin source; its production build guard rejects a missing or
localhost value under the deployed `/dms` base path.

## Verification

- `npm run typecheck` - backend and frontend passed.
- `npm --workspace frontend test` - 4 files / 20 tests passed.
- `npm --workspace frontend run build` - production build passed and generated
  all 34 application routes.
- `git diff --check` - no whitespace errors.

