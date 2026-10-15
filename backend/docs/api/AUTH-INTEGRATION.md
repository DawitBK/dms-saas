# DMS — External Identity Provider Integration Guide

## Overview
DMS delegates authentication entirely to an external Central User Account Service.
It owns only **authorization** via a two-layer model:
1. Global permission enforcement (`ROLE_PERMISSIONS[role].includes(permission)`)
2. Per-resource ACL (`acl_entries` table — deny > allow > no-entry = deny)

**DMS does NOT define or constrain the role taxonomy.** Any role name issued by the IdP is accepted. Unknown roles resolve to zero permissions (safe default-deny). The six reference roles below are the demo tenant's configuration, not architecture.

---

## Token Requirements

| Field | Type | Notes |
|---|---|---|
| Algorithm | RS256 | Asymmetric only. HS256 is not accepted. |
| `user_id` | string | Stable unique user identifier |
| `role` | string | Arbitrary role name. DMS looks it up in ROLE_PERMISSIONS. Unknown = zero permissions. |
| `tenant_id` | string | Active tenant context (e.g. `"examplecorp"`) |
| `iss` | string | Must match `AUTH_ISSUER` env var |
| `aud` | string | Must match `AUTH_AUDIENCE` env var |
| `iat` | number | Unix timestamp issued-at |
| `exp` | number | Unix timestamp expiry |

Recommended access token TTL: **8 hours**.

### JWKS Endpoint (preferred)
```
GET {AUTH_JWKS_URI}
→ Standard JWKS JSON with at least one RS256 signing key
→ DMS caches and rotates automatically on kid mismatch
```

### Token Example (decoded payload)
```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "role": "RECORDS_OFFICER",
  "tenant_id": "examplecorp",
  "iss": "https://auth.yourcompany.com",
  "aud": "edams-api",
  "iat": 1718530000,
  "exp": 1718558800
}
```

---

## DMS Endpoints the External System Calls

### User Provisioning (required before first login)
The external system must create a DMS user profile before issuing a JWT with that `user_id`.

```
POST /api/v1/users
Authorization: Bearer {token with user:manage permission}
Content-Type: application/json

{
  "email": "john.doe@company.com",
  "firstName": "John",
  "lastName": "Doe",
  "departmentId": "uuid"   // optional
}

→ 201 { "id": "uuid", "email": "...", "firstName": "...", "lastName": "...", "isActive": true, "createdAt": "ISO8601" }
```

The `id` returned here is the `user_id` that must appear in all subsequent JWTs for this user.

### Identity & Permission Verification
```
GET /api/v1/auth/me
Authorization: Bearer {USER_TOKEN}

→ 200 {
  "user": {
    "userId": "uuid",
    "role": "RECORDS_OFFICER",
    "tenantId": "examplecorp",
    "permissions": ["document:read", "document:upload", "audit:read", "..."]
  }
}
```

**Note:** Do not assume permissions from the role name. Always read the `permissions` array — it reflects the deployment's configured ROLE_PERMISSIONS mapping, which may differ per tenant.

### Health / Readiness
```
GET /health
→ 200 { "status": "ok", "db": "ok", "redis": "ok" }
→ 503 if any dependency is down
```

### Token Lifecycle
DMS does NOT issue refresh tokens. Token lifecycle is managed entirely by the external IdP.

```
401 { "error": { "code": "ERR-AUTH-EXPIRED",   "message": "Access token expired" } }
401 { "error": { "code": "ERR-AUTH-INVALID",   "message": "Invalid access token" } }
401 { "error": { "code": "ERR-AUTH-REQUIRED",  "message": "Authentication required" } }
403 { "error": { "code": "AUTHZ_ROLE_DENIED",  "message": "Permission 'X' not granted to role 'Y'" } }
403 { "error": { "code": "AUTHZ_ACL_DENIED",   "message": "Access denied by ACL entry" } }
403 { "error": { "code": "AUTHZ_ACL_NO_ENTRY", "message": "No ACL entry grants access" } }
```

When a 401 is returned, the external system should issue a new RS256 access token and retry once.

---

## DMS Environment Variables

```bash
AUTH_ISSUER=https://auth.yourcompany.com        # Must match token iss claim
AUTH_AUDIENCE=edams-api                          # Must match token aud claim
AUTH_JWKS_URI=https://auth.yourcompany.com/.well-known/jwks.json

# Alternative: shared public key (if no JWKS endpoint)
# DEV_RSA_PUBLIC_KEY=<base64-encoded-PEM>
```

---

## Permission Catalog

DMS defines and owns the permission strings below. It does NOT own or constrain the set of role names an external IdP may issue. Any role name is accepted; permissions are resolved via this tenant's configured ROLE_PERMISSIONS mapping.

### Available Permissions
| Permission | Description |
|---|---|
| `document:read` | Read/view documents |
| `document:upload` | Upload new documents |
| `document:archive` | Archive documents |
| `document:purge` | Certified disposal |
| `document:checkout` | Check out / check in documents |
| `folder:create` | Create folders |
| `folder:read` | Browse folders |
| `folder:delete` | Delete folders |
| `user:manage` | Manage users (create, edit, roles) |
| `role:read` | View roles |
| `department:read` | View departments |
| `department:manage` | Manage departments |
| `doctype:read` | View document types |
| `doctype:manage` | Manage document types |
| `audit:read` | View audit logs |
| `workflow:read` | View workflow definitions and instances |
| `workflow:manage` | Create/edit workflow definitions |
| `workflow:approve` | Approve/reject workflow tasks |
| `retention:read` | View retention policies and queue |
| `retention:manage` | Manage retention, authorise disposal |
| `legalhold:read` | View legal holds |
| `legalhold:manage` | Place and release legal holds |
| `search:read` | Full-text search |
| `notification:read` | View notifications |
| `signing:read` | View signature records |
| `signing:manage` | Request and execute document signing |
| `operations:read` | View system health and metrics |
| `operations:manage` | System administration |
| `acl:manage` | Manage resource-level ACL entries |

### Reference Permission Mapping (Demo Tenant — NOT architecture)

This is the demo tenant's `ROLE_PERMISSIONS` configuration, shown for illustration. Enterprise deployments configure their own mapping.

| Permission | SYSTEM_ADMIN | RECORDS_OFFICER | DEPT_MANAGER | APPROVER | EMPLOYEE | AUDITOR |
|---|---|---|---|---|---|---|
| document:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| document:upload | ✓ | ✓ | ✓ | | ✓ | |
| document:archive | ✓ | ✓ | | | | |
| document:purge | ✓ | | | | | |
| document:checkout | ✓ | ✓ | ✓ | | ✓ | |
| folder:create | ✓ | ✓ | ✓ | | | |
| folder:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| folder:delete | ✓ | ✓ | | | | |
| user:manage | ✓ | | ✓ | | | |
| role:read | ✓ | | ✓ | | | |
| department:read | ✓ | ✓ | ✓ | | | |
| department:manage | ✓ | | ✓ | | | |
| doctype:read | ✓ | ✓ | ✓ | | ✓ | |
| doctype:manage | ✓ | ✓ | | | | |
| audit:read | ✓ | ✓ | | | | ✓ |
| workflow:read | ✓ | ✓ | ✓ | ✓ | | |
| workflow:manage | ✓ | ✓ | | | | |
| workflow:approve | ✓ | | ✓ | ✓ | | |
| retention:read | ✓ | ✓ | ✓ | | | ✓ |
| retention:manage | ✓ | ✓ | | | | |
| legalhold:read | ✓ | ✓ | ✓ | | | ✓ |
| legalhold:manage | ✓ | ✓ | | | | |
| search:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| notification:read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| signing:read | ✓ | ✓ | | ✓ | | |
| signing:manage | ✓ | ✓ | | | | |
| operations:read | ✓ | | | | | ✓ |
| operations:manage | ✓ | | | | | |
| acl:manage | ✓ | | | | | |

---

## Resource-Level ACL Contract (Layer 2)

Passing the permission check (Layer 1) is necessary but not sufficient. A resource-level ACL entry can still deny access even when the role globally holds the permission.

ACL check order: direct user entry → role entry → ancestor traversal (document → folder → cabinet → department → tenant).

- A `deny` at any level immediately short-circuits → `403 AUTHZ_ACL_DENIED`
- The most specific `allow` wins
- No matching entry anywhere → `403 AUTHZ_ACL_NO_ENTRY`

### `acl_entries` schema fields
| Field | Type | Notes |
|---|---|---|
| `principal_type` | string | `"user"` or `"role"` |
| `principal_id` | string | userId or role name |
| `resource_type` | string | `"document"`, `"folder"`, `"cabinet"`, `"department"` |
| `resource_id` | string | UUID of the resource |
| `action` | string | Permission string (e.g. `document:read`) |
| `effect` | string | `"allow"` or `"deny"` |
| `expires_at` | datetime? | Optional expiry for time-limited grants |

---

## Webhook Events DMS Sends to External Systems

Register a webhook endpoint:
```
POST /api/v1/webhooks/subscribe
Authorization: Bearer {token}
{ "url": "https://yourapp.com/webhook", "events": ["document.approved"] }
```

DMS then POSTs to your URL:
```
POST https://yourapp.com/webhook
Content-Type: application/json
X-DMS-Event: document.approved
X-DMS-Signature: sha256=<HMAC>

{
  "event": "document.approved",
  "timestamp": "2026-06-17T12:00:00Z",
  "tenantId": "examplecorp",
  "data": { ... }
}
```

Available events: `document.uploaded`, `document.approved`, `document.archived`, `legal-hold.placed`, `retention.expired`, `audit.chain-broken`, `workflow.completed`, `notification.dispatched`
