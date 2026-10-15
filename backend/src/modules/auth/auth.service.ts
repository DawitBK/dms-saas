/**
 * DMS Auth Service
 *
 * Business logic for every /auth/* route: mock/local login, tenant selection,
 * refresh/logout token lifecycle, TOTP/MFA, and the OIDC/SSO login flow
 * (authorize → callback, backchannel logout). Extracted out of
 * `auth.routes.ts` (which used to call User/UserTenant/sequelize and mint
 * JWTs directly from inside route handlers) so this logic is callable
 * without an Express Request/Response and reviewable independent of
 * transport concerns — the layering every other DMS module already has.
 *
 * Boundary: functions here take plain arguments and return plain values, or
 * throw AppError. Anything that reads a cookie/header off `req` or sets one
 * on `res` stays in auth.routes.ts; the handful of functions whose result
 * includes a refresh token to cookie (login, select-tenant, switch-tenant,
 * refresh, totp/validate, oidc callback) return
 * `{ responseBody, refreshToken? }` so the route can set the cookie and
 * respond in one place, uniformly.
 */
import { PLATFORM_ADMIN_ROLE } from '../../shared/platformAdmin.js';
import { filterToKnownRoles, resolveEffectiveRoles, resolveOidcUser } from './ssoIdentity.js';
import {
  randomUUID,
  createPublicKey,
  createHash,
  randomBytes,
} from 'node:crypto';
import jwt from 'jsonwebtoken';
import { QueryTypes } from 'sequelize';
import { authenticator } from 'otplib';
import { config } from '../../config/env.js';
import {
  revocationEnforced,
  revokeAllUserSessions,
  getUserRevocationCutoff,
  assertMfaAttemptsAllowed,
  recordMfaFailure,
  clearMfaFailures,
  consumeMfaPendingJti,
  dmsJwtVerifyOptions,
  type AuthenticatedUser,
} from '../../shared/auth.js';
import { runInTransaction } from '../../shared/transaction.js';
import { getCorrelationId } from '../../shared/requestContext.js';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import {
  User,
  Tenant,
  sequelize,
} from '../../infrastructure/database/index.js';
import { resolveUnionPermissions } from '../roles/roles.service.js';
import { ROLE_RANK, PERMISSIONS } from '../../config/permissions.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { getCacheRedis } from '../../infrastructure/cache/redis.js';
import {
  createFlowBinding,
  flowBindingMatches,
} from '../../shared/flowBinding.js';

/** base64url, for the PKCE verifier and challenge (P2-9 item 24). */
const base64UrlEncode = (buf: Buffer): string =>
  buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// Tenant granted to users with no user_tenants rows: the login-time fallback
// (backward compatibility for pre-membership accounts) and the membership row
// written for newly OIDC-provisioned users both point here.
const DEFAULT_TENANT_ID = 'examplecorp';
/**
 * Custom claim namespaces, as MINTED BY SSO. The authority for both strings is
 * SSO's own source — `SSO/backend/src/config.ts` (AD_GROUPS_CLAIM) and
 * `SSO/backend/src/auth/client-role-claims.ts` (EDAMS_ROLES_CLAIM). If these
 * two literals do not match SSO's byte for byte, the claim silently reads as
 * `undefined` here and every code path that depends on it becomes dead — no
 * error, no log line.
 *
 * That is not hypothetical: AD_GROUPS_CLAIM read `https://dms.examplecorp.com/`
 * while SSO has always emitted `https://edams.examplecorp.com/`, so `adGroups`
 * in the OIDC callback below was permanently `[]` and the entire
 * `idp_role_mappings` AD-group→role fallback never executed once. It was
 * masked because the EDAMS_ROLES_CLAIM path (line above, which was correct)
 * always won first.
 *
 * This is the same failure mode root CLAUDE.md documents for the reverted
 * `edams`→`dms` rename (DMS commit ca06550): the `edams` namespace is
 * load-bearing and must NOT be renamed here without a coordinated migration
 * of `idp_role_mappings` in both repos.
 */
const EDAMS_ROLES_CLAIM = 'https://edams.examplecorp.com/roles';

/**
 * Mirror an SSO-resolved role set into user_roles.
 *
 * WHY. Login and refresh disagreed about what a user's roles are. An OIDC
 * login takes its roles from the verified id_token claim and, when that
 * claim was present, deliberately wrote nothing locally ("SSO mappings are
 * authoritative at login"). But refreshSession re-reads roles FROM
 * user_roles and falls back to ['EMPLOYEE'] when it finds none. So an SSO
 * user with no local rows logged in as, say, SYSTEM_ADMIN and was silently
 * demoted to EMPLOYEE the first time their access token refreshed --
 * observed in production as areas vanishing and 403s appearing after the
 * session sat idle. Persisting the resolved set is what makes the two
 * agree.
 *
 * This is a SYNC, not an insert. A pure insert would let a role SSO has
 * since revoked live on locally forever and be handed straight back by the
 * next refresh -- turning a fixed downgrade bug into a privilege-retention
 * bug. Roles the IdP no longer sends are removed.
 *
 * Two deliberate guards:
 *  - Role names the claim carries that do not exist in `roles` are ignored
 *    and logged, never invented.
 *  - If NOTHING in the claim resolves to a known role, existing rows are
 *    left alone. A malformed or empty claim must not be able to strip a
 *    user's access; that is a fail-closed-on-change, not fail-open.
 */
async function syncUserRolesFromSso(
  userId: string,
  roleNames: readonly string[],
): Promise<void> {
  const wanted = [...new Set(roleNames.filter(Boolean))];
  if (wanted.length === 0) return;

  const known = await sequelize.query<{ id: string; name: string }>(
    `SELECT id, name FROM roles WHERE name = ANY($1::text[])`,
    { bind: [wanted], type: QueryTypes.SELECT },
  );
  const unknown = wanted.filter((n) => !known.some((k) => k.name === n));
  if (unknown.length > 0) {
    logger.warn(
      { userId, unknown },
      'SSO returned role names with no matching row in "roles" - ignored',
    );
  }
  if (known.length === 0) {
    logger.error(
      { userId, roleNames: wanted },
      'SSO role set resolved to zero known roles - leaving existing user_roles untouched rather than stripping access',
    );
    return;
  }

  // The platform-admin role is outside this sync in both directions: an IdP
  // assertion can never GRANT it (only the platform owner's vault-protected
  // seed script does), and an IdP that stops asserting it can never REMOVE it
  // ("no one can kick the platform admin off"). Everything else syncs as before.
  const keepIds = known.map((k) => k.id);
  const grantIds = known.filter((k) => k.name !== PLATFORM_ADMIN_ROLE).map((k) => k.id);
  await runInTransaction(async (tx) => {
    const removed = await sequelize.query<{ role_id: string }>(
      `DELETE FROM user_roles
        WHERE user_id = $1 AND role_id <> ALL($2::uuid[])
          AND role_id NOT IN (SELECT id FROM roles WHERE name = '${PLATFORM_ADMIN_ROLE}')
        RETURNING role_id`,
      { bind: [userId, keepIds], type: QueryTypes.SELECT, transaction: tx },
    );
    await sequelize.query(
      `INSERT INTO user_roles (id, user_id, role_id, assigned_at)
       SELECT gen_random_uuid(), $1, r.id, NOW() FROM roles r WHERE r.id = ANY($2::uuid[])
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      { bind: [userId, grantIds], type: QueryTypes.INSERT, transaction: tx },
    );
    // The IdP's assertion just won this sync (either there was no active
    // local override, or its own comparison against this same snapshot
    // decided a genuine mapping change should override it) — record what it
    // asserted so the NEXT login can tell a further mapping change apart
    // from "unchanged since a DMS admin's edit", and release the local-
    // override flag now that this sync is what's actually live. See
    // rolesManagedLocally/ssoRolesSnapshot on the User model.
    await User.update(
      {
        ssoRolesSnapshot: known.map((k) => k.name),
        rolesManagedLocally: false,
      },
      { where: { id: userId }, transaction: tx },
    );
    if (removed.length > 0) {
      logger.info(
        {
          userId,
          removedRoleIds: removed.map((r) => r.role_id),
          kept: known.map((k) => k.name),
        },
        'Revoked local roles the IdP no longer asserts',
      );
    }
  });
}

/** Apply a department set selected in the SSO admin console. The pending row is
 * consumed once, so first-time OIDC provisioning and later SSO logins converge
 * on the same DMS-owned many-to-many membership without replacing unrelated
 * user data. */
async function applyPendingSsoDepartments(
  userId: string,
  email: string,
  tenantId: string,
): Promise<void> {
  const rows = await sequelize.query<{ department_ids: string[] }>(
    `SELECT department_ids
       FROM sso_pending_department_assignments
      WHERE tenant_id = :tenantId AND email = :email`,
    {
      replacements: { tenantId, email: email.toLowerCase() },
      type: QueryTypes.SELECT,
    },
  );
  const departmentIds = [...new Set(rows[0]?.department_ids ?? [])];
  if (rows.length === 0) return;

  await runInTransaction(async (tx) => {
    await sequelize.query(
      `DELETE FROM user_departments WHERE user_id = :userId`,
      {
        replacements: { userId },
        type: QueryTypes.DELETE,
        transaction: tx,
      },
    );
    if (departmentIds.length > 0) {
      await sequelize.query(
        `INSERT INTO user_departments (user_id, department_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT (user_id, department_id) DO NOTHING`,
        {
          bind: [userId, departmentIds],
          type: QueryTypes.INSERT,
          transaction: tx,
        },
      );
    }
    await sequelize.query(
      `DELETE FROM sso_pending_department_assignments WHERE tenant_id = :tenantId AND email = :email`,
      {
        replacements: { tenantId, email: email.toLowerCase() },
        type: QueryTypes.DELETE,
        transaction: tx,
      },
    );
    await writeAuditLog(
      {
        eventType:
          departmentIds.length > 0
            ? AUDIT_EVENTS.USER_DEPT_ASSIGNED
            : AUDIT_EVENTS.USER_DEPT_REMOVED,
        tenantId,
        userId: userId,
        actionDetails: { email, departmentIds, via: 'sso-pending-assignment' },
      },
      tx,
    );
  });
}

const AD_GROUPS_CLAIM = 'https://edams.examplecorp.com/ad_groups';

/**
 * P2-9 item 19: throws instead of silently returning 8h.
 *
 * The old `if (!match) return 8 * 3_600_000;` meant a malformed
 * JWT_REFRESH_EXPIRES_IN produced a cookie maxAge of 8 hours while
 * jsonwebtoken computed the token's own `exp` from the same (malformed) string —
 * two different session lengths from one config value, with no error. The format
 * is now validated in config/env.ts at boot (durationString), so reaching this
 * throw means someone passed an unvalidated string and wants to know about it.
 */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `Invalid duration string "${duration}" — expected e.g. 15m, 8h, 30d`,
    );
  }
  const value = parseInt(match[1], 10);
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * factors[match[2]]!;
}

// jsonwebtoken v9 changed expiresIn to require ms's branded StringValue; config strings are
// Zod-validated to match that format, so this cast is safe.
const dur = (s: string): any => s;

/**
 * P1-11: the refresh cookie is scoped to DMS's own public path prefix so it is
 * not transmitted to GMS's, SSO's or MRS's backends, which share this origin and
 * are separated from DMS by path alone. '/' in dev (PUBLIC_BASE_PATH empty),
 * because a browser rejects a cookie whose Path does not match the request.
 *
 * Every res.cookie('refreshToken', ...) AND the clearCookie in /auth/logout must
 * use this same value — a clearCookie with a different path silently does
 * nothing.
 */
export const REFRESH_COOKIE_PATH = config.PUBLIC_BASE_PATH || '/';

/** Options shared by every res.cookie('refreshToken', ...)/clearCookie('refreshToken', ...)
 *  call in auth.routes.ts — centralized so the path/flags can never drift between them. */
export function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: parseDurationMs(config.JWT_REFRESH_EXPIRES_IN),
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * Cookie carrying the raw browser-binding token for the authorize -> callback hop.
 *
 * path '/' is deliberate, not laziness. Apache fronts this backend at
 * `/dms/api/v1` and strips the `/dms` prefix before proxying, so the process has
 * no reliable way to know its own browser-visible path; a cookie scoped to
 * `req.baseUrl` would never be sent back and would break every SSO login in
 * production while passing in dev. The token is httpOnly, lives 10 minutes, and
 * is worthless without the matching server-side pending row, so the wider path
 * costs nothing meaningful. It is cleared on the callback either way.
 */
export const OIDC_BIND_COOKIE = 'dms_oidc_bind';

/** A route handler's uniform result shape when it may (branch-dependently) need
 *  the caller to set a new refresh-token cookie alongside the JSON response. */
export type AuthResult<T = Record<string, unknown>> = {
  responseBody: T;
  refreshToken?: string;
};

function displayRoleOf(allRoles: string[]): string {
  return allRoles.reduce((highest, role) => {
    const currentRank = ROLE_RANK.indexOf(role);
    const highestRank = ROLE_RANK.indexOf(highest);
    if (
      currentRank !== -1 &&
      (highestRank === -1 || currentRank < highestRank)
    ) {
      return role;
    }
    return highest;
  }, allRoles[0]);
}

/**
 * Mints the short-lived (5 min) pre-role token returned by loginMock/
 * selectTenant when a user holds more than one role — mirrors the
 * pre-tenant token's own shape (see loginMock's `userTenants.length > 1`
 * branch) one step later in the sequence: tenant is already resolved here,
 * role is not. Consumed by POST /auth/select-role.
 */
const ROLE_SELECTION_TTL_SECONDS = 300;
function issuePreRoleToken(
  userId: string,
  tenantId: string,
  allRoles: string[],
): string {
  const privateKey = Buffer.from(
    config.DEV_RSA_PRIVATE_KEY!,
    'base64',
  ).toString('utf-8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      user_id: userId,
      role: allRoles[0], // Temporary, will be set properly after role selection
      tenant_id: tenantId,
      role_selection_required: true,
      available_roles: allRoles,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
      iat: now,
      exp: now + ROLE_SELECTION_TTL_SECONDS,
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'dev-key' },
  );
}

/**
 * POST /auth/login  (dev-only)
 *
 * Accepts { email } — password-less for local development.
 * Looks up the user in the DB, finds their primary role, then issues an RS256
 * JWT with exactly the claims the backend authenticate() middleware expects:
 *   { user_id, role, tenant_id, iss, aud, iat, exp }
 *
 * In production this endpoint does not exist — the external identity provider
 * issues tokens with the same claim shape.
 */
export async function loginMock(email: string): Promise<AuthResult> {
  if (!config.LOCAL_JWT_MOCK) {
    throw new AppError(
      403,
      'ERR-MOCK-DISABLED',
      'LOCAL_JWT_MOCK is not enabled in .env',
    );
  }
  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set — add it to .env',
    );
  }

  // 1. Look up user
  const user = await User.findOne({ where: { email } });
  if (!user || !user.isActive) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'No active account found for that email',
    );
  }

  // 2. Find ALL roles for the user (not just one random role)
  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = :userId
     ORDER BY r.name ASC`,
    {
      replacements: { userId: user.id },
      type: QueryTypes.SELECT,
    },
  );
  const allRoles =
    roleRows.length > 0 ? roleRows.map((row) => row.role_name) : ['EMPLOYEE'];

  // 3. Look up user's tenant memberships
  const tenantRows = await sequelize.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM user_tenants WHERE user_id = :userId ORDER BY assigned_at ASC`,
    {
      replacements: { userId: user.id },
      type: QueryTypes.SELECT,
    },
  );

  // Default tenant if no memberships exist (backward compatibility during migration)
  const userTenants =
    tenantRows.length > 0
      ? tenantRows.map((row) => row.tenant_id)
      : [DEFAULT_TENANT_ID];

  // If user has multiple tenants, they need to select one
  if (userTenants.length > 1) {
    // Issue a short-lived "pre-tenant" token
    const privateKey = Buffer.from(
      config.DEV_RSA_PRIVATE_KEY,
      'base64',
    ).toString('utf-8');
    const now = Math.floor(Date.now() / 1000);
    const preTenantToken = jwt.sign(
      {
        user_id: user.id,
        roles: allRoles,
        role: allRoles[0], // Temporary, will be set properly after tenant selection
        tenant_selection_required: true,
        available_tenants: userTenants,
        iss:
          config.DEV_JWT_ISSUER ??
          config.AUTH_ISSUER ??
          'http://localhost:7300',
        aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
        iat: now,
        exp: now + 300, // 5 minutes to select tenant
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'dev-key' },
    );

    return {
      responseBody: {
        tenantSelectionRequired: true,
        availableTenants: userTenants,
        preTenantToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: allRoles,
        },
      },
    };
  }

  // Single tenant - proceed with normal login
  const tenantId = userTenants[0];

  // Multi-role users must pick which role they're signing in as before a
  // full token is minted — without this, `permissions` below silently
  // becomes the union of every role the user holds (e.g. SYSTEM_ADMIN +
  // DEPT_MANAGER + EMPLOYEE all at once), which is exactly what made "act as
  // one role at a time" impossible. Single-role users (the overwhelming
  // majority) never reach this branch, so their login is unchanged.
  if (allRoles.length > 1) {
    return {
      responseBody: {
        roleSelectionRequired: true,
        availableRoles: allRoles,
        preRoleToken: issuePreRoleToken(user.id, tenantId, allRoles),
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: allRoles,
          tenantId,
        },
      },
    };
  }

  // 4. Compute union of permissions across all roles
  const permissions = await resolveUnionPermissions(
    allRoles,
    tenantId,
    user.id,
  );

  // 5. Determine display role (highest-ranked) for UI badges only
  const displayRole = displayRoleOf(allRoles);

  // 6. If MFA enabled, issue a short-lived MFA-pending token instead of a full access token
  if (user.isMfaEnabled && user.mfaSecret) {
    const privateKey = Buffer.from(
      config.DEV_RSA_PRIVATE_KEY,
      'base64',
    ).toString('utf-8');
    const now = Math.floor(Date.now() / 1000);
    const mfaPendingToken = jwt.sign(
      {
        jti: randomUUID(), // single-use: consumed at /totp/validate (S19 4.2)
        user_id: user.id,
        roles: allRoles,
        role: displayRole,
        tenant_id: tenantId,
        mfa_pending: true,
        iss:
          config.DEV_JWT_ISSUER ??
          config.AUTH_ISSUER ??
          'http://localhost:7300',
        aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
        iat: now,
        exp: now + 300, // 5 minutes to complete MFA
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'dev-key' },
    );
    return {
      responseBody: {
        mfaRequired: true,
        mfaPendingToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      },
    };
  }

  // 7. Sign RS256 JWT with roles array and permissions
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const jti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti,
      user_id: user.id,
      roles: allRoles,
      role: displayRole, // Kept for backward compatibility
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const refreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: user.id,
      tenant_id: tenantId,
      roles: allRoles,
      role: displayRole,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  // Security-critical: awaited so a login is never issued without its
  // durable audit record (fails the login on audit failure).
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: user.id,
    tenantId,
    actionDetails: { email: user.email, tenantId, roles: allRoles },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: allRoles,
        role: displayRole,
        tenantId,
        permissions,
      },
    },
    refreshToken,
  };
}

/**
 * POST /auth/dev/token  (dev-only, legacy)
 * Issues a token given explicit { userId, role, tenantId } — useful for tests.
 */
export async function issueDevToken(
  userId: string,
  role: string,
  tenantId: string,
): Promise<{ accessToken: string }> {
  if (!config.LOCAL_JWT_MOCK) {
    throw new AppError(403, 'ERR-MOCK-DISABLED', 'Local JWT mock is disabled');
  }
  // Validate that userId exists in the database
  const dbUser = await User.findByPk(userId);
  if (!dbUser || !dbUser.isActive) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'userId does not match an active user — please log in again',
    );
  }

  // SECURITY FIX (chaos-engine finding, 2026-08-17): this endpoint used to mint a
  // token for ANY tenantId/role once userId resolved to an active user, with no
  // check that the user actually belongs to that tenant or holds that role — an
  // unauthenticated caller who knew any single active userId (trivially learned
  // from POST /auth/login's own response body) could self-escalate to SYSTEM_ADMIN
  // in a tenant they have zero membership in. Same membership check /select-tenant
  // and /switch-tenant already enforce, applied here too.
  const membership = await sequelize.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM user_tenants WHERE user_id = :userId AND tenant_id = :tenantId`,
    { replacements: { userId, tenantId }, type: QueryTypes.SELECT },
  );
  if (membership.length === 0) {
    throw new AppError(
      403,
      'ERR-UNAUTHORIZED-TENANT',
      'User does not have access to this tenant',
    );
  }

  // `role` must be one the user actually holds — this endpoint mints a token for
  // testing AS the user, not a mechanism to grant a role they don't have.
  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  const allowedRoles =
    roleRows.length > 0 ? roleRows.map((r) => r.role_name) : ['EMPLOYEE'];
  if (!allowedRoles.includes(role)) {
    throw new AppError(
      403,
      'ERR-INVALID-ROLE',
      `User does not hold role "${role}"`,
    );
  }

  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY is missing',
    );
  }
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      user_id: userId,
      role,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'dev-key' },
  );
  return { accessToken: token };
}

/**
 * POST /auth/select-tenant
 * Called when user has multiple tenants - verifies membership and issues full JWT
 */
export async function selectTenant(
  preTenantToken: string,
  tenantId: string,
): Promise<AuthResult> {
  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set — configure JWT signing keys',
    );
  }

  const publicKey = Buffer.from(config.DEV_RSA_PUBLIC_KEY!, 'base64').toString(
    'utf-8',
  );
  // Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #9: this used to pin only `algorithms`,
  // skipping the issuer/audience check verifyAccessToken enforces on every
  // other token this app issues, even though the pre-tenant token above is
  // minted with the same iss/aud claims.
  const payload = jwt.verify(
    preTenantToken,
    publicKey,
    dmsJwtVerifyOptions(),
  ) as any;

  if (!payload.tenant_selection_required) {
    throw new AppError(400, 'ERR-INVALID-TOKEN', 'Not a pre-tenant token');
  }

  const userId = payload.user_id;

  // Verify user has access to this tenant
  const membership = await sequelize.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM user_tenants WHERE user_id = :userId AND tenant_id = :tenantId`,
    {
      replacements: { userId, tenantId },
      type: QueryTypes.SELECT,
    },
  );

  if (membership.length === 0) {
    throw new AppError(
      403,
      'ERR-UNAUTHORIZED-TENANT',
      'User does not have access to this tenant',
    );
  }

  // Fetch user details
  const user = await User.findByPk(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, 'ERR-AUTH-INVALID', 'User not found or inactive');
  }

  // Fetch all roles
  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = :userId
     ORDER BY r.name ASC`,
    {
      replacements: { userId },
      type: QueryTypes.SELECT,
    },
  );
  const allRoles =
    roleRows.length > 0 ? roleRows.map((row) => row.role_name) : ['EMPLOYEE'];

  // Same role-selection gate as loginMock's single-tenant path — see its
  // comment. Reached here by any multi-role user who ALSO has multiple
  // tenants (tenant is resolved first, then role).
  if (allRoles.length > 1) {
    return {
      responseBody: {
        roleSelectionRequired: true,
        availableRoles: allRoles,
        preRoleToken: issuePreRoleToken(userId, tenantId, allRoles),
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: allRoles,
          tenantId,
        },
      },
    };
  }

  // Compute permissions
  const permissions = await resolveUnionPermissions(allRoles, tenantId, userId);

  // Determine display role
  const displayRole = displayRoleOf(allRoles);

  // Issue full JWT
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const jti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti,
      user_id: userId,
      roles: allRoles,
      role: displayRole,
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const refreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: userId,
      tenant_id: tenantId,
      roles: allRoles,
      role: displayRole,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  /**
   * AUTH_LOGIN belongs HERE, not only on the single-tenant path.
   *
   * The three other login paths (loginMock's single-tenant branch, MFA
   * validate, OIDC callback) each write this row and each carry a comment
   * saying a login must never be issued without its durable audit record.
   * This path did not — and it is the path that issues the real credential
   * for any user with more than one tenant membership: /auth/login returns
   * only a pre-tenant token and returns EARLY, before that write, whenever
   * tenantSelectionRequired is true. So for exactly those users there was no
   * AUTH_LOGIN row for the session that actually got minted, and
   * logout's comment ("AUTH_LOGIN is written on every successful login")
   * was describing a guarantee that did not hold. A forensic "who signed in,
   * when, from where" query silently skipped them.
   *
   * Awaited, like its three siblings, so an unauditable login fails instead
   * of succeeding quietly. source_ip is filled in by writeAuditLog from the
   * request context (see audit.service.ts).
   */
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: user.id,
    tenantId,
    actionDetails: {
      email: user.email,
      tenantId,
      roles: allRoles,
      via: 'select-tenant',
    },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: allRoles,
        role: displayRole,
        tenantId,
        permissions,
      },
    },
    refreshToken,
  };
}

/**
 * POST /auth/select-role
 * Called when a multi-role user's login/select-tenant resolved tenant_id but
 * deferred which role to sign in as (loginMock/selectTenant's
 * `allRoles.length > 1` branch) — verifies the pre-role token, re-validates
 * the chosen role is one the user actually holds, and mints a full JWT
 * scoped to JUST that role: `roles` and `permissions` reflect the single
 * chosen role, not the union of every role the user holds. Mirrors
 * selectTenant's shape.
 */
export async function selectRole(
  preRoleToken: string,
  roleName: string,
): Promise<AuthResult> {
  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set — configure JWT signing keys',
    );
  }

  const publicKey = Buffer.from(config.DEV_RSA_PUBLIC_KEY!, 'base64').toString(
    'utf-8',
  );
  const payload = jwt.verify(
    preRoleToken,
    publicKey,
    dmsJwtVerifyOptions(),
  ) as any;

  if (!payload.role_selection_required) {
    throw new AppError(400, 'ERR-INVALID-TOKEN', 'Not a pre-role token');
  }

  const userId = payload.user_id as string;
  const tenantId = payload.tenant_id as string;
  const availableRoles: string[] = payload.available_roles ?? [];

  // The pre-role token itself already names exactly which roles this user
  // holds (computed at login/select-tenant time) — re-checking against it
  // here, not a fresh DB query, mirrors how selectTenant re-checks
  // user_tenants membership against the request rather than trusting the
  // client's tenantId blindly.
  if (!availableRoles.includes(roleName)) {
    throw new AppError(403, 'ERR-ROLE-NOT-HELD', 'You do not hold that role');
  }

  const user = await User.findByPk(userId);
  if (!user || !user.isActive) {
    throw new AppError(401, 'ERR-AUTH-INVALID', 'User not found or inactive');
  }

  // FIX: this role-selection gate runs BEFORE loginMock's own MFA check (role
  // is picked first, then — for a single-role user — MFA if enabled). Without
  // this, a multi-role MFA-enabled user would pick a role here and walk away
  // with a full access token having never completed MFA at all, silently
  // reintroducing the exact bypass the mfa_pending mechanism exists to close.
  // Same mfa-pending-token shape as loginMock's own branch, scoped to just
  // the chosen role.
  if (user.isMfaEnabled && user.mfaSecret) {
    const now = Math.floor(Date.now() / 1000);
    const mfaPendingToken = jwt.sign(
      {
        jti: randomUUID(),
        user_id: userId,
        roles: [roleName],
        role: roleName,
        tenant_id: tenantId,
        mfa_pending: true,
        iss:
          config.DEV_JWT_ISSUER ??
          config.AUTH_ISSUER ??
          'http://localhost:7300',
        aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
        iat: now,
        exp: now + 300,
      },
      Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString('utf-8'),
      { algorithm: 'RS256', keyid: 'dev-key' },
    );
    return {
      responseBody: {
        mfaRequired: true,
        mfaPendingToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      },
    };
  }

  // Permissions computed from ONLY the chosen role — this is the entire
  // point of the feature. (Still layered with this user's own
  // UserPermissionOverride grants/revokes, same as every other permission
  // resolution in this file.)
  const permissions = await resolveUnionPermissions(
    [roleName],
    tenantId,
    userId,
  );

  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const jti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti,
      user_id: userId,
      roles: [roleName],
      role: roleName,
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const refreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: userId,
      tenant_id: tenantId,
      roles: [roleName],
      role: roleName,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: user.id,
    tenantId,
    actionDetails: {
      email: user.email,
      tenantId,
      activeRole: roleName,
      availableRoles,
      via: 'select-role',
    },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: [roleName],
        role: roleName,
        availableRoles,
        tenantId,
        permissions,
      },
    },
    refreshToken,
  };
}

/**
 * POST /auth/switch-tenant
 * Called by authenticated user to switch to a different tenant they have access to
 */
export async function switchTenant(
  currentUser: AuthenticatedUser,
  tenantId: string,
): Promise<AuthResult> {
  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set — configure JWT signing keys',
    );
  }

  // FIX 2026-09-14: a platform:admin holder (config/permissions.ts —
  // deliberately never granted alongside plain SYSTEM_ADMIN) operates the
  // platform, not one tenant — they can switch into ANY tenant without
  // holding a user_tenants row for it, same reasoning as the assertOwnTenant
  // bypass in tenants.routes.ts. Every other account still needs an actual
  // membership row, unchanged. The target tenant must still exist (a bogus
  // id 404s cleanly rather than minting a token for nothing).
  const isPlatformAdmin = currentUser.permissions.includes(
    PERMISSIONS.PLATFORM_ADMIN,
  );
  if (isPlatformAdmin) {
    const targetTenant = await Tenant.findByPk(tenantId);
    if (!targetTenant) {
      throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');
    }
  } else {
    // Verify user has access to the requested tenant
    const membership = await sequelize.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM user_tenants WHERE user_id = :userId AND tenant_id = :tenantId`,
      {
        replacements: { userId: currentUser.userId, tenantId },
        type: QueryTypes.SELECT,
      },
    );

    if (membership.length === 0) {
      throw new AppError(
        403,
        'ERR-UNAUTHORIZED-TENANT',
        'User does not have access to this tenant',
      );
    }
  }

  // Re-compute permissions for the new tenant
  const permissions = await resolveUnionPermissions(
    currentUser.roles,
    tenantId,
    currentUser.userId,
  );

  // Issue new JWT scoped to the new tenant
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const switchJti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti: switchJti,
      user_id: currentUser.userId,
      roles: currentUser.roles,
      role: currentUser.role,
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  // Rotate refresh cookie to new tenant scope
  const switchRefreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: currentUser.userId,
      tenant_id: tenantId,
      roles: currentUser.roles,
      role: currentUser.role,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  /**
   * Same reason as selectTenant above: a new tenant-scoped credential is
   * being minted here, and the tenant it is scoped to is the whole point of
   * the request — so "this user began acting as tenant X at time T from
   * address A" is exactly the row an investigation needs, and there was none.
   */
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: currentUser.userId,
    tenantId,
    actionDetails: {
      tenantId,
      previousTenantId: currentUser.tenantId,
      roles: currentUser.roles,
      via: 'switch-tenant',
    },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: currentUser.userId,
        roles: currentUser.roles,
        role: currentUser.role,
        tenantId,
        permissions,
      },
    },
    refreshToken: switchRefreshToken,
  };
}

/**
 * POST /auth/switch-role
 * Called by an authenticated multi-role user to change which role they're
 * acting as, without a full re-login — mirrors switchTenant's shape exactly.
 * Re-queries the user's full role list from the DB (rather than trusting
 * currentUser.roles off the token) because selectRole/switchRole always
 * narrow the token's `roles` claim to the single active role, so it no
 * longer carries the complete set to validate the new choice against.
 */
export async function switchRole(
  currentUser: AuthenticatedUser,
  roleName: string,
): Promise<AuthResult> {
  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set — configure JWT signing keys',
    );
  }

  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = :userId
     ORDER BY r.name ASC`,
    { replacements: { userId: currentUser.userId }, type: QueryTypes.SELECT },
  );
  const allRoles =
    roleRows.length > 0 ? roleRows.map((row) => row.role_name) : ['EMPLOYEE'];

  if (!allRoles.includes(roleName)) {
    throw new AppError(403, 'ERR-ROLE-NOT-HELD', 'You do not hold that role');
  }

  const permissions = await resolveUnionPermissions(
    [roleName],
    currentUser.tenantId,
    currentUser.userId,
  );

  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const switchJti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti: switchJti,
      user_id: currentUser.userId,
      roles: [roleName],
      role: roleName,
      permissions,
      tenant_id: currentUser.tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const switchRoleRefreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: currentUser.userId,
      tenant_id: currentUser.tenantId,
      roles: [roleName],
      role: roleName,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: currentUser.userId,
    tenantId: currentUser.tenantId,
    actionDetails: {
      tenantId: currentUser.tenantId,
      previousRole: currentUser.role,
      activeRole: roleName,
      availableRoles: allRoles,
      via: 'switch-role',
    },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: currentUser.userId,
        roles: [roleName],
        role: roleName,
        availableRoles: allRoles,
        tenantId: currentUser.tenantId,
        permissions,
      },
    },
    refreshToken: switchRoleRefreshToken,
  };
}

/**
 * P1-7: how long a just-rotated refresh token is still accepted as a benign
 * concurrent retry rather than treated as theft. Long enough to absorb two tabs
 * or an axios interceptor racing itself; far too short to be useful to anyone
 * replaying a stolen cookie later.
 */
const ROTATION_GRACE_SECONDS = 10;

/**
 * POST /auth/refresh
 * Reads the HttpOnly `refreshToken` cookie, verifies it (HS256 / JWT_REFRESH_SECRET),
 * re-reads roles and tenant membership from the database, and issues a new RS256
 * access token with a fresh jti.
 *
 * The refresh token IS now rotated on every use (P1-7). It previously was not:
 * one cookie stayed valid for its entire lifetime with no reuse detection, so a
 * copied cookie was a long-lived credential and there was no way to notice it had
 * been copied. Both of the platform's other token issuers already rotate —
 * oidc-provider by configuration, GMS in its own refresh handler — DMS was the
 * outlier. See ROTATION_GRACE_SECONDS below for how a rotated token being
 * presented again is told apart from theft.
 */
export async function refreshSession(
  rawRefreshToken: string | undefined,
): Promise<AuthResult> {
  if (!rawRefreshToken) {
    throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Refresh token not present');
  }

  let refreshPayload: {
    jti?: string;
    user_id: string;
    tenant_id: string;
    roles: string[];
    role: string;
    iat?: number;
  };
  try {
    refreshPayload = jwt.verify(
      rawRefreshToken,
      config.JWT_REFRESH_SECRET,
    ) as typeof refreshPayload;
  } catch {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'Refresh token invalid or expired',
    );
  }

  const { user_id: userId, tenant_id: tenantId } = refreshPayload;

  // A deactivated / soft-deleted account must not be able to mint fresh access
  // tokens from an old refresh cookie (C5). This is a direct DB check so it
  // holds even if the Redis revocation cutoff was never set (e.g. Redis down
  // at deactivation time in a non-enforcing environment).
  const refreshingUser = await User.findByPk(userId);
  if (
    !refreshingUser ||
    refreshingUser.isActive === false ||
    refreshingUser.deletedAt
  ) {
    throw new AppError(401, 'ERR-AUTH-REVOKED', 'Account is no longer active');
  }

  // FIX: refresh tokens previously had no jti and logout never revoked
  // them — a copied HttpOnly refresh cookie kept minting fresh access
  // tokens for its full lifetime even after the legitimate user logged
  // out. Mirrors the existing access-token jti blacklist exactly.
  if (refreshPayload.jti) {
    const redis = getCacheRedis();
    if (redis) {
      const revoked = await redis.get(
        `dms:auth:revoked_refresh:${refreshPayload.jti}`,
      );
      if (revoked) {
        throw new AppError(
          401,
          'ERR-AUTH-REVOKED',
          'Refresh token has been revoked',
        );
      }

      /**
       * Reuse detection (P1-7). A refresh token that this endpoint already
       * rotated away must never be usable again — presenting one means either
       * a benign race or that two parties hold the same cookie.
       *
       * Benign race: two tabs (or an interceptor retrying) fire /refresh at
       * once. The first rotates and sets the new cookie; the second was already
       * in flight with the old one. That is not an attack, and nuking every
       * session for it would log real users out constantly — so inside
       * ROTATION_GRACE_SECONDS it returns a distinct, retryable 401. The
       * client's retry carries the new cookie the first response already set,
       * and succeeds.
       *
       * Outside the grace window, the same cookie being presented long after it
       * was replaced means it exists in two places. Treat it as theft: kill
       * every session for the user (which invalidates whichever copy is the
       * attacker's along with the victim's) and make them sign in again. This
       * is the standard rotation-with-reuse-detection trade: an occasional
       * forced re-login beats an undetectable stolen refresh cookie.
       */
      const rotatedAt = await redis.get(
        `dms:auth:rotated_refresh:${refreshPayload.jti}`,
      );
      if (rotatedAt) {
        const age = Math.floor(Date.now() / 1000) - Number(rotatedAt);
        if (age <= ROTATION_GRACE_SECONDS) {
          logger.info(
            { userId, age },
            'refresh token reuse inside the rotation grace window — retryable',
          );
          throw new AppError(
            401,
            'ERR-AUTH-REFRESH-RACE',
            'This refresh token was just rotated by a concurrent request — retry with the new cookie',
          );
        }
        logger.error(
          { userId, jti: refreshPayload.jti, age },
          'REFRESH TOKEN REUSE DETECTED outside the grace window — the same refresh cookie is held by more than one party. Revoking every session for this user.',
        );
        // R-04: the cutoff is durable in Postgres now, so this no longer
        // swallows routine Redis flakiness — only a genuine database failure,
        // at which point the whole request is failing anyway. The catch stays
        // so the response still carries the precise ERR-AUTH-TOKEN-REUSE
        // signal below rather than a bare 500; the token is rejected either
        // way, and the error is logged at error level for follow-up.
        await revokeAllUserSessions(userId, {
          reason: 'refresh-token-reuse',
        }).catch((err) =>
          logger.error(
            { err, userId },
            'failed to revoke sessions after refresh-token reuse',
          ),
        );
        throw new AppError(
          401,
          'ERR-AUTH-TOKEN-REUSE',
          'Refresh token reuse detected — all sessions have been signed out',
        );
      }
    } else if (revocationEnforced()) {
      throw new AppError(
        503,
        'ERR-AUTH-REVOCATION-UNAVAILABLE',
        'Authentication is temporarily unavailable',
      );
    } else {
      logger.warn(
        { userId },
        'Redis unavailable — refresh-token revocation check skipped (fail-open)',
      );
    }
  }

  // User-level revocation cutoff (deactivation, force-logout, permission
  // change, IdP backchannel logout): refuse to mint new access tokens from a
  // refresh token issued at or before the cutoff.
  //
  // R-04: was a direct Redis read that 503'd in production when Redis was
  // down and skipped the check entirely in development. The cutoff is durable
  // in Postgres now, so there is always a correct answer to give — Redis just
  // makes it fast. Same helper as authenticate(), so the refresh path and the
  // request path can no longer disagree about whether a session is revoked.
  if (refreshPayload.iat) {
    const cutoff = await getUserRevocationCutoff(userId);
    if (cutoff !== null && refreshPayload.iat <= cutoff) {
      throw new AppError(
        401,
        'ERR-AUTH-REVOKED',
        'Session has been signed out',
      );
    }
  }

  /**
   * Re-read roles and tenant membership FROM THE DATABASE.
   *
   * These used to be destructured off the refresh token, and the comment here
   * claimed "recompute permissions so any role changes take effect
   * immediately" -- which was false in the way that matters. Only the
   * role->permission MAPPING was recomputed; the role MEMBERSHIP came from
   * the token. So removing a user from ADMIN had no effect on refresh: the
   * stale ['ADMIN'] was fed straight back into resolveUnionPermissions and
   * full admin permissions were re-minted for the life of the refresh token.
   *
   * Tenant membership gets the same treatment: revoking a user's access to a
   * tenant previously did not survive a refresh either.
   */
  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = :userId
      ORDER BY r.name ASC`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  const allRoles =
    roleRows.length > 0 ? roleRows.map((r) => r.role_name) : ['EMPLOYEE'];

  const membership = await sequelize.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM user_tenants WHERE user_id = :userId AND tenant_id = :tenantId`,
    { replacements: { userId, tenantId }, type: QueryTypes.SELECT },
  );
  // DEFAULT_TENANT_ID is the documented backward-compatibility fallback for
  // pre-membership accounts (see the constant's own comment), so a user with
  // NO membership rows at all is still allowed on it -- but a user who has
  // memberships and simply is not in this one is refused.
  if (membership.length === 0) {
    const anyMembership = await sequelize.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM user_tenants WHERE user_id = :userId LIMIT 1`,
      { replacements: { userId }, type: QueryTypes.SELECT },
    );
    if (anyMembership.length > 0 || tenantId !== DEFAULT_TENANT_ID) {
      throw new AppError(
        403,
        'ERR-UNAUTHORIZED-TENANT',
        'User no longer has access to this tenant',
      );
    }
  }

  const displayRole = displayRoleOf(allRoles);

  const permissions = await resolveUnionPermissions(allRoles, tenantId, userId);

  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set',
    );
  }
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const newJti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti: newJti,
      user_id: userId,
      roles: allRoles,
      role: displayRole,
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  /**
   * Rotate the refresh token itself (P1-7 item 3).
   *
   * The new token gets a fresh jti; the presented one is recorded as rotated
   * for the remainder of its own lifetime so the reuse check above can see it.
   * Marking it BEFORE sending the response is deliberate: if the client never
   * receives the new cookie it retries, lands in the grace window, and gets the
   * retryable error — whereas marking it afterwards would leave a window in
   * which the old token is still silently acceptable.
   */
  const newRefreshJti = randomUUID();
  const rotatedRefreshToken = jwt.sign(
    {
      jti: newRefreshJti,
      user_id: userId,
      tenant_id: tenantId,
      roles: allRoles,
      role: displayRole,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  if (refreshPayload.jti) {
    const redis = getCacheRedis();
    if (redis) {
      // TTL = what was left of the old token's life. Past that it fails
      // signature-expiry anyway, so there is nothing to remember.
      const decodedOld = jwt.decode(rawRefreshToken) as { exp?: number } | null;
      const remaining = Math.max(
        1,
        (decodedOld?.exp ?? 0) - Math.floor(Date.now() / 1000),
      );
      await redis
        .set(
          `dms:auth:rotated_refresh:${refreshPayload.jti}`,
          String(Math.floor(Date.now() / 1000)),
          'EX',
          remaining,
        )
        .catch((err: unknown) =>
          logger.error(
            { err, userId },
            'failed to mark refresh token rotated — reuse detection is degraded for it',
          ),
        );
    } else {
      // Rotation still happens (the new cookie replaces the old), but without
      // Redis nothing can notice the old one being presented again. Says so
      // rather than pretending reuse detection is active.
      logger.warn(
        { userId },
        'Redis unavailable — refresh token rotated but reuse detection is not recorded',
      );
    }
  }

  // FIX: only accessToken was ever returned here, but the frontend's
  // refresh interceptor reads user.permissions from this response to
  // update the in-memory permission gate — that field was never present,
  // so it always fell back to whatever permissions were cached at login,
  // no matter how many times refresh recomputed the real permissions into
  // the token above. Return them explicitly so the UI can catch up too.
  return {
    responseBody: { accessToken, user: { id: userId, permissions } },
    refreshToken: rotatedRefreshToken,
  };
}

/**
 * POST /auth/logout
 * Adds the current access token's `jti` AND the refresh token's `jti` to the
 * Redis revocation set (TTL = remaining token lifetime each).
 *
 * FIX: this used to blacklist only the access token. The refresh token was
 * never revoked, so a refresh cookie copied before a legitimate logout kept
 * minting fresh access tokens for the rest of its lifetime — logout did not
 * stop it. Now both are blacklisted the same way.
 */
export async function recordLogout(
  rawAccessToken: string | undefined,
  rawRefreshToken: string | undefined,
  currentUser: { userId?: string; tenantId?: string } | undefined,
): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) {
    logger.warn(
      { userId: currentUser?.userId },
      'Redis unavailable at logout — access/refresh token revocation skipped (fail-open)',
    );
  }

  if (rawAccessToken) {
    const decoded = jwt.decode(rawAccessToken) as Record<
      string,
      unknown
    > | null;
    const jti = decoded?.jti as string | undefined;
    const exp = decoded?.exp as number | undefined;
    if (jti && exp && redis) {
      const ttl = Math.max(0, exp - Math.floor(Date.now() / 1000));
      if (ttl > 0) {
        await redis.set(`dms:auth:revoked:${jti}`, '1', 'EX', ttl);
      }
    }
  }

  if (rawRefreshToken) {
    const decodedRefresh = jwt.decode(rawRefreshToken) as Record<
      string,
      unknown
    > | null;
    const refreshJti = decodedRefresh?.jti as string | undefined;
    const refreshExp = decodedRefresh?.exp as number | undefined;
    if (refreshJti && refreshExp && redis) {
      const ttl = Math.max(0, refreshExp - Math.floor(Date.now() / 1000));
      if (ttl > 0) {
        await redis.set(
          `dms:auth:revoked_refresh:${refreshJti}`,
          '1',
          'EX',
          ttl,
        );
      }
    }
  }

  // AUDIT-FINDINGS-2026-08-11 data-flow sweep #1: AUTH_LOGIN is written on
  // every successful login but AUTH_LOGOUT was a dead constant — a
  // forensic "was this user logged in at time X" query had starts but no
  // ends.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGOUT,
    userId: currentUser?.userId ?? null,
    tenantId: currentUser?.tenantId ?? null,
    actionDetails: {},
  }).catch((err) =>
    logger.warn(
      { err, userId: currentUser?.userId },
      'Failed to write logout audit log',
    ),
  );
}

// ─── TOTP / 2FA ──────────────────────────────────────────────────────────────

/**
 * POST /auth/totp/setup  (authenticated)
 * Generates a new TOTP secret + otpauth URI for the authenticator app.
 * The secret is stored in mfaTempSecret until the user confirms with /totp/confirm.
 */
export async function setupTotp(
  userId: string,
  stepUpCode: string | undefined,
): Promise<{ secret: string; otpauthUrl: string }> {
  const user = await User.findByPk(userId);
  if (!user) throw new AppError(404, 'ERR-NOT-FOUND', 'User not found');

  // Step-up (S19 4.3): if MFA is ALREADY enabled, re-enrolling rebinds the
  // second factor — an attacker on a stolen session must not be able to swap
  // in their own authenticator. Require a valid CURRENT code first.
  if (user.isMfaEnabled && user.mfaSecret) {
    if (!stepUpCode)
      throw new AppError(
        400,
        'ERR-TOTP-STEPUP',
        'Current TOTP code required to re-enroll',
      );
    await assertMfaAttemptsAllowed(user.id);
    const stepUpValid = authenticator.verify({
      token: stepUpCode,
      secret: user.mfaSecret,
    });
    if (!stepUpValid) {
      await recordMfaFailure(user.id);
      throw new AppError(400, 'ERR-TOTP-INVALID', 'Invalid TOTP code');
    }
    await clearMfaFailures(user.id);
  }

  const secret = authenticator.generateSecret();
  await user.update({ mfaTempSecret: secret });

  const otpauthUrl = authenticator.keyuri(user.email, 'DMS', secret);

  return { secret, otpauthUrl };
}

/**
 * POST /auth/totp/confirm  (authenticated)
 * Verifies the TOTP code against mfaTempSecret and permanently enables MFA.
 */
export async function confirmTotp(userId: string, code: string): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user) throw new AppError(404, 'ERR-NOT-FOUND', 'User not found');
  if (!user.mfaTempSecret) {
    throw new AppError(400, 'ERR-TOTP-SETUP', 'Run /auth/totp/setup first');
  }

  const valid = authenticator.verify({
    token: code,
    secret: user.mfaTempSecret,
  });
  if (!valid) throw new AppError(400, 'ERR-TOTP-INVALID', 'Invalid TOTP code');

  await user.update({
    isMfaEnabled: true,
    mfaSecret: user.mfaTempSecret,
    mfaTempSecret: null,
  });

  // Security-critical: awaited so enabling MFA is atomic with its audit.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_UPDATED,
    userId: user.id,
    actionDetails: { change: 'mfa_enabled' },
  });
}

/**
 * POST /auth/totp/validate
 * Exchanges an MFA-pending token + TOTP code for a full access token.
 * Called after login when mfaRequired: true is returned.
 */
export async function validateTotp(
  mfaPendingToken: string,
  code: string,
): Promise<AuthResult> {
  if (!config.DEV_RSA_PUBLIC_KEY) {
    throw new AppError(500, 'ERR-CONFIG-MISSING', 'DEV_RSA_PUBLIC_KEY not set');
  }

  const publicKey = Buffer.from(config.DEV_RSA_PUBLIC_KEY, 'base64').toString(
    'utf-8',
  );
  let payload: any;
  try {
    // Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #9: same fix as /select-tenant above —
    // route through the shared issuer/audience-checked verify options.
    payload = jwt.verify(mfaPendingToken, publicKey, dmsJwtVerifyOptions());
  } catch {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'Invalid or expired MFA pending token',
    );
  }

  if (!payload.mfa_pending) {
    throw new AppError(400, 'ERR-INVALID-TOKEN', 'Not an MFA-pending token');
  }

  const user = await User.findByPk(payload.user_id);
  if (!user || !user.isActive || !user.mfaSecret) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'User not found or MFA not configured',
    );
  }

  // Brute-force guard: refuse once the account has too many recent failures.
  await assertMfaAttemptsAllowed(user.id);

  // Single-use: claim the pending token's jti so a captured (token, code) pair
  // cannot be replayed within the 5-min window (S19 4.2). Older tokens minted
  // before this field existed have no jti — reject them rather than allow replay.
  if (!payload.jti) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'MFA pending token missing id; re-authenticate',
    );
  }
  const remainingTtl = Math.max(
    1,
    (payload.exp ?? 0) - Math.floor(Date.now() / 1000),
  );
  const claimed = await consumeMfaPendingJti(payload.jti, remainingTtl);
  if (!claimed) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      'MFA pending token already used',
    );
  }

  const valid = authenticator.verify({ token: code, secret: user.mfaSecret });
  if (!valid) {
    await recordMfaFailure(user.id);
    throw new AppError(400, 'ERR-TOTP-INVALID', 'Invalid TOTP code');
  }
  await clearMfaFailures(user.id);

  const {
    user_id: userId,
    roles: allRoles,
    role: displayRole,
    tenant_id: tenantId,
  } = payload;

  const permissions = await resolveUnionPermissions(allRoles, tenantId, userId);

  const privateKey = Buffer.from(
    config.DEV_RSA_PRIVATE_KEY!,
    'base64',
  ).toString('utf-8');
  const jti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti,
      user_id: userId,
      roles: allRoles,
      role: displayRole,
      permissions,
      tenant_id: tenantId,
      iss:
        config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const refreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: userId,
      tenant_id: tenantId,
      roles: allRoles,
      role: displayRole,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  // Security-critical: awaited so an MFA login is never issued without audit.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId,
    tenantId,
    actionDetails: { tenantId, mfaValidated: true },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: allRoles,
        role: displayRole,
        tenantId,
        permissions,
      },
    },
    refreshToken,
  };
}

/**
 * POST /auth/totp/disable  (authenticated)
 * Disables MFA for the authenticated user. Requires a valid TOTP code to prevent
 * accidental or unauthorized disabling.
 */
export async function disableTotp(userId: string, code: string): Promise<void> {
  const user = await User.findByPk(userId);
  if (!user || !user.mfaSecret) {
    throw new AppError(400, 'ERR-TOTP-SETUP', 'MFA not enabled');
  }

  await assertMfaAttemptsAllowed(user.id);
  const valid = authenticator.verify({ token: code, secret: user.mfaSecret });
  if (!valid) {
    await recordMfaFailure(user.id);
    throw new AppError(400, 'ERR-TOTP-INVALID', 'Invalid TOTP code');
  }
  await clearMfaFailures(user.id);

  await user.update({
    isMfaEnabled: false,
    mfaSecret: null,
    mfaTempSecret: null,
  });

  // Security-critical: awaited so disabling MFA is atomic with its audit.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_UPDATED,
    userId: user.id,
    actionDetails: { change: 'mfa_disabled' },
  });
}

// ─── SSO / OIDC ──────────────────────────────────────────────────────────────
//
// To enable: set AUTH_ISSUER, AUTH_JWKS_URI, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
// OIDC_REDIRECT_URI in backend/.env.
// The OIDC flow: GET /auth/oidc/authorize → IdP → GET OIDC_REDIRECT_URI?code=&state=
// → frontend posts code+state to POST /auth/callback → backend exchanges code for
// tokens, verifies ID token, and issues an DMS access JWT.

/** In-memory JWKS cache (kid → PEM) with 1-hour TTL. */
interface JwksCache {
  keys: Record<string, string>;
  fetchedAt: number;
}
let _jwksCache: JwksCache | null = null;
const JWKS_TTL_MS = 3_600_000;

// FIX (Finding 8): both fetch()es to SSO in this section (JWKS below, and the
// token-exchange in completeOidcCallback) used to have no timeout at all — if
// SSO's /token or JWKS endpoint accepted a connection but hung, every DMS
// SSO-login attempt and handleBackchannelLogout (also calls getJwksPems)
// would hang with it, indefinitely. A ~5s AbortController timeout bounds the
// wait; the caller still gets the same error shape it already handles for a
// failed request, just faster.
const OIDC_FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OIDC_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Fetch (or return cached) JWKS from AUTH_JWKS_URI, return kid→PEM map. */
async function getJwksPems(
  forceRefresh = false,
): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && _jwksCache && now - _jwksCache.fetchedAt < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }
  if (!config.AUTH_JWKS_URI) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'AUTH_JWKS_URI is not configured',
    );
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(config.AUTH_JWKS_URI);
  } catch (err) {
    if (isAbortError(err)) {
      throw new AppError(
        502,
        'ERR-JWKS-FETCH',
        `JWKS fetch timed out after ${OIDC_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
  if (!response.ok) {
    throw new AppError(
      502,
      'ERR-JWKS-FETCH',
      `JWKS fetch failed: ${response.status}`,
    );
  }
  const { keys } = (await response.json()) as {
    keys: Record<string, unknown>[];
  };
  const pemMap: Record<string, string> = {};
  for (const jwk of keys) {
    if (jwk['use'] !== 'sig' && jwk['use'] !== undefined) continue;
    if (jwk['kty'] !== 'RSA') continue;
    try {
      const pubKey = createPublicKey({
        key: jwk as unknown as import('node:crypto').JsonWebKeyInput['key'],
        format: 'jwk',
      });
      const pem = pubKey.export({ type: 'spki', format: 'pem' }) as string;
      pemMap[(jwk['kid'] as string) ?? '_default'] = pem;
    } catch {
      // skip malformed JWK entries
    }
  }
  _jwksCache = { keys: pemMap, fetchedAt: now };
  return pemMap;
}

/**
 * Verify an OIDC ID token. Fetches JWKS on first call and caches; auto-rotates
 * on unknown kid by fetching fresh JWKS once before failing.
 */
async function verifyOidcIdToken(
  idToken: string,
): Promise<Record<string, unknown>> {
  const headerJson = Buffer.from(idToken.split('.')[0], 'base64url').toString(
    'utf-8',
  );
  const { kid } = JSON.parse(headerJson) as { kid?: string };
  const lookupKid = kid ?? '_default';

  let pems = await getJwksPems();
  if (!pems[lookupKid]) {
    pems = await getJwksPems(true);
  }
  if (!pems[lookupKid]) {
    throw new AppError(
      401,
      'ERR-AUTH-INVALID',
      `JWKS has no key for kid="${lookupKid}"`,
    );
  }

  return jwt.verify(idToken, pems[lookupKid], {
    algorithms: ['RS256'],
    issuer: config.AUTH_ISSUER,
    audience: config.OIDC_CLIENT_ID ?? config.AUTH_AUDIENCE,
  }) as Record<string, unknown>;
}

/**
 * POST /auth/oidc/jwks/refresh
 * Force-refreshes the cached JWKS from AUTH_JWKS_URI.
 */
export async function refreshOidcJwks(): Promise<{
  refreshed: true;
  keyCount: number;
}> {
  const pems = await getJwksPems(true);
  return { refreshed: true, keyCount: Object.keys(pems).length };
}

const OIDC_STATE_TTL_SECONDS = 600;

/**
 * Store the OIDC authorize-time `state` → `nonce` CSRF pair. Prefers Redis
 * (fast, self-expiring); if Redis is unreachable, falls back to Postgres
 * (oidc_state_nonces, S6-RLS-exempt global table) so SSO login doesn't
 * depend on Redis being up — matching every other cache in this codebase
 * (see infrastructure/cache/redis.ts), instead of failing closed.
 */
async function storeOidcState(
  state: string,
  nonce: string,
  bindingHash: string,
  codeVerifier: string,
): Promise<void> {
  const redis = getCacheRedis();
  if (redis) {
    try {
      // JSON now, not a bare nonce string: the record carries the browser
      // binding as well. consumeOidcState below still accepts the old bare-string
      // shape so a rolling deploy does not 500 on keys written by the old build
      // (it treats them as unbound, which fails the binding check closed).
      await redis.set(
        `dms:auth:oidc-state:${state}`,
        JSON.stringify({ n: nonce, b: bindingHash, v: codeVerifier }),
        'EX',
        OIDC_STATE_TTL_SECONDS,
      );
      return;
    } catch (error) {
      logger.warn(
        { error },
        'redis unavailable for OIDC state; falling back to DB',
      );
    }
  }
  await sequelize.query(
    `INSERT INTO oidc_state_nonces (state, nonce, binding_hash, code_verifier, expires_at)
     VALUES (:state, :nonce, :bindingHash, :codeVerifier, NOW() + INTERVAL '${OIDC_STATE_TTL_SECONDS} seconds')
     ON CONFLICT (state) DO UPDATE SET nonce = EXCLUDED.nonce,
       binding_hash = EXCLUDED.binding_hash, code_verifier = EXCLUDED.code_verifier,
       expires_at = EXCLUDED.expires_at`,
    { replacements: { state, nonce, bindingHash, codeVerifier } },
  );
}

/**
 * Consume (read + delete) the nonce stored for `state`. Checks Redis first,
 * then Postgres — covers both "Redis is down" and "Redis came back up after
 * we wrote to Postgres" without needing to know which store has it.
 * Returns null if `state` is unknown, expired, or already consumed.
 */
export interface OidcPendingState {
  nonce: string;
  bindingHash: string | null;
  codeVerifier: string | null;
}

/** Tolerates the pre-P1-1 bare-nonce Redis value (treated as unbound, no PKCE). */
function parseRedisPendingState(raw: string): OidcPendingState {
  try {
    const parsed = JSON.parse(raw) as { n?: unknown; b?: unknown; v?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.n === 'string') {
      return {
        nonce: parsed.n,
        bindingHash: typeof parsed.b === 'string' ? parsed.b : null,
        codeVerifier: typeof parsed.v === 'string' ? parsed.v : null,
      };
    }
  } catch {
    // not JSON — an older build wrote the nonce directly
  }
  return { nonce: raw, bindingHash: null, codeVerifier: null };
}

/** Exported so auth.routes.ts can consume the state and clear the OIDC bind
 *  cookie BEFORE deciding whether to throw "unknown/expired state" — the
 *  cookie must be cleared either way, which is a transport (Set-Cookie)
 *  concern the route owns. */
export async function consumeOidcState(
  state: string,
): Promise<OidcPendingState | null> {
  const redis = getCacheRedis();
  if (redis) {
    try {
      const raw = await redis.get(`dms:auth:oidc-state:${state}`);
      if (raw) {
        await redis.del(`dms:auth:oidc-state:${state}`);
        return parseRedisPendingState(raw);
      }
    } catch (error) {
      logger.warn(
        { error },
        'redis unavailable for OIDC state; falling back to DB',
      );
    }
  }
  const rows = await sequelize.query<{
    nonce: string;
    binding_hash: string | null;
    code_verifier: string | null;
  }>(
    `DELETE FROM oidc_state_nonces WHERE state = :state AND expires_at > NOW()
     RETURNING nonce, binding_hash, code_verifier`,
    { replacements: { state }, type: QueryTypes.SELECT },
  );
  const row = rows[0];
  return row
    ? {
        nonce: row.nonce,
        bindingHash: row.binding_hash ?? null,
        codeVerifier: row.code_verifier ?? null,
      }
    : null;
}

/**
 * GET /auth/oidc/authorize
 * Builds the IdP authorization URL with a CSRF-safe `state` and `nonce`
 * (stored via storeOidcState), plus the browser-binding token the route
 * needs to set as a cookie before redirecting.
 */
export async function beginOidcAuthorize(): Promise<{
  redirectUrl: string;
  bindingToken: string;
  bindCookieMaxAgeMs: number;
}> {
  if (
    !config.OIDC_CLIENT_ID ||
    !config.OIDC_REDIRECT_URI ||
    !config.AUTH_ISSUER
  ) {
    throw new AppError(
      501,
      'ERR-SSO-DISABLED',
      'SSO/OIDC is not configured on this server',
    );
  }

  const state = randomUUID();
  const nonce = randomUUID();
  // Bind this authorization to THIS browser (P1-1). Without it, POST
  // /auth/callback accepts a code+state pair from anyone, so an attacker can
  // replay their own valid pair into a victim's browser and have the victim
  // silently signed in as the attacker.
  const binding = createFlowBinding();

  /**
   * PKCE (P2-9 item 24). DMS's authorize request carried no code_challenge, so
   * SSO's `pkce.required` predicate — which only demands PKCE from clients using
   * token_endpoint_auth_method 'none' — never applied to it, and the provider's
   * own comment noted that PKCE was therefore enforced for nobody. Correct
   * policy, zero effect.
   *
   * DMS is a confidential client, so the spec does not force PKCE here; this is
   * defence in depth against an authorization code that leaks (Referer header,
   * proxy log, a URL read over someone's shoulder) being redeemable at all.
   * With this in place SSO's predicate can be flipped to always-true, which is
   * the actual point of the change.
   */
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(
    createHash('sha256').update(codeVerifier).digest(),
  );

  await storeOidcState(state, nonce, binding.hash, codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.OIDC_CLIENT_ID,
    redirect_uri: config.OIDC_REDIRECT_URI,
    scope: config.OIDC_SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authEndpoint = `${config.AUTH_ISSUER.replace(/\/$/, '')}/authorize`;
  return {
    redirectUrl: `${authEndpoint}?${params.toString()}`,
    bindingToken: binding.token,
    bindCookieMaxAgeMs: OIDC_STATE_TTL_SECONDS * 1000,
  };
}

/**
 * POST /auth/callback (continuation)
 * Given the already-consumed pending state (see consumeOidcState above) and
 * the browser-binding cookie value, exchanges the code for tokens, verifies
 * the ID token, finds/provisions the local user, and issues a DMS token.
 */
export async function completeOidcCallback(
  code: string,
  pendingState: OidcPendingState,
  presentedBinding: string | undefined,
): Promise<AuthResult> {
  if (
    !config.OIDC_CLIENT_ID ||
    !config.OIDC_CLIENT_SECRET ||
    !config.OIDC_REDIRECT_URI ||
    !config.AUTH_ISSUER
  ) {
    throw new AppError(
      501,
      'ERR-SSO-DISABLED',
      'SSO/OIDC is not configured on this server',
    );
  }
  if (!config.AUTH_JWKS_URI) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'AUTH_JWKS_URI is required for OIDC callback verification',
    );
  }

  // Browser-binding check BEFORE the token exchange: a request that cannot
  // prove it is the browser that started this flow must not cause the
  // authorization code to be redeemed at all. Fails closed when the cookie is
  // absent, and when the pending record predates this check.
  if (!flowBindingMatches(presentedBinding, pendingState.bindingHash)) {
    logger.warn(
      'OIDC callback rejected: browser binding missing or mismatched',
    );
    throw new AppError(
      400,
      'ERR-OIDC-BINDING',
      'This sign-in was started in a different browser or has expired — start the sign-in again',
    );
  }
  const storedNonce = pendingState.nonce;

  // Exchange authorization code for tokens at the IdP token endpoint
  const tokenEndpoint =
    config.OIDC_TOKEN_ENDPOINT ??
    `${config.AUTH_ISSUER.replace(/\/$/, '')}/token`;

  // No retry on a timeout/failure here, deliberately: the authorization code
  // is single-use, so retrying this call would just fail a second time with
  // "code already used" instead of the real timeout error.
  let tokenRes: Response;
  try {
    tokenRes = await fetchWithTimeout(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Carries this request's correlation id across the hop into SSO's own
        // logs — SSO's requestId-stamping middleware (main.ts) reads either
        // header name, so setting both is safe/redundant rather than order-
        // dependent. Read ambiently (no req/res threading needed here) via
        // DMS's own AsyncLocalStorage-backed correlation id.
        ...(getCorrelationId()
          ? {
              'x-request-id': getCorrelationId()!,
              'x-correlation-id': getCorrelationId()!,
            }
          : {}),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.OIDC_REDIRECT_URI,
        client_id: config.OIDC_CLIENT_ID,
        client_secret: config.OIDC_CLIENT_SECRET,
        // PKCE (P2-9 item 24). Omitted only for a pending record written by a
        // build that predates it, so an authorization already in flight across the
        // deploy still completes instead of failing at the token endpoint.
        ...(pendingState.codeVerifier
          ? { code_verifier: pendingState.codeVerifier }
          : {}),
      }).toString(),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new AppError(
        502,
        'ERR-TOKEN-EXCHANGE',
        `IdP token exchange timed out after ${OIDC_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new AppError(
      502,
      'ERR-TOKEN-EXCHANGE',
      `IdP token exchange failed: ${tokenRes.status} — ${body.slice(0, 200)}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!tokenData.id_token) {
    throw new AppError(
      502,
      'ERR-TOKEN-MISSING',
      'IdP did not return an id_token',
    );
  }

  // Verify ID token signature + claims against IdP JWKS
  const idClaims = await verifyOidcIdToken(tokenData.id_token);

  // Guard against ID token replay: the nonce in the token must match what we
  // stored in Redis at authorize time.
  if (idClaims['nonce'] !== storedNonce) {
    throw new AppError(
      400,
      'ERR-OIDC-NONCE',
      'ID token nonce mismatch — possible replay attack',
    );
  }

  // Require email_verified to prevent account-takeover via an unverified email
  // claim.  Some IdPs omit the field entirely (treat as unverified).
  if (idClaims['email_verified'] !== true) {
    throw new AppError(
      403,
      'ERR-OIDC-EMAIL-UNVERIFIED',
      'Identity provider has not verified this email address',
    );
  }

  const externalSub = String(idClaims['sub'] ?? '');
  const externalEmail = String(
    idClaims['email'] ?? idClaims['preferred_username'] ?? '',
  );
  const givenName = String(
    idClaims['given_name'] ?? idClaims['name'] ?? '',
  ).split(' ')[0];
  const familyName = String(idClaims['family_name'] ?? idClaims['name'] ?? '')
    .split(' ')
    .slice(1)
    .join(' ');

  if (!externalEmail) {
    throw new AppError(400, 'ERR-OIDC-CLAIMS', 'ID token missing email claim');
  }

  // The IdP subject is the stable identifier for the identity; email is not.
  // A verified id_token without a `sub` should be impossible (verifyOidcIdToken
  // ran above), but the account-matching below is only sound if it is present,
  // so refuse rather than fall through to email-only matching.
  if (!externalSub) {
    throw new AppError(400, 'ERR-OIDC-CLAIMS', 'ID token missing sub claim');
  }

  /**
   * Find or provision the local user (P1-18).
   *
   * This used to be a bare `User.findOne({ where: { email } })`. Two problems
   * with that, both exploitable:
   *
   *  1. It matched on email only, so `external_sub` was written once at
   *     provisioning time and then never consulted again. If an IdP account is
   *     deleted and the same address is later reissued to a different person
   *     — a normal thing in AD when someone leaves and a namesake joins — the
   *     new person silently inherits the old person's DMS account, documents,
   *     roles and history. Matching on `sub` first, and refusing when a row
   *     already carries a *different* `sub`, makes that a hard failure an
   *     admin has to look at instead of a silent takeover.
   *
   *  2. It also meant an SSO login could adopt a *locally created* account
   *     (password login, its own roles) purely because the addresses matched.
   *     Adoption is still allowed — that is the intended migration path — but
   *     only for a row that has no `sub` yet, and the link is recorded.
   *
   * Provisioning is now transactional. Previously User.create() and
   * UserTenant.create() were two independent statements: a crash or a failing
   * membership insert between them left a user row with no tenant membership,
   * which is exactly the state the comment below says must not exist — the
   * account is then invisible to the users RLS policy and unmanageable from
   * the admin panels.
   */
  // The matching, adoption, email-follow and JIT-provisioning rules (case-insensitive
  // email, unique-violation races, conflicts that need an admin) live in ssoIdentity.ts.
  const user = await resolveOidcUser(
    { externalSub, email: externalEmail, givenName, familyName },
    DEFAULT_TENANT_ID,
  );

  // deletedAt too: users.service softDeleteUser sets both, but the model is not
  // paranoid, so a row that was re-activated without being un-deleted would
  // otherwise log in here while refreshSession (which checks deletedAt) refuses it.
  if (!user.isActive || user.deletedAt) {
    throw new AppError(403, 'ERR-AUTH-INACTIVE', 'Account is deactivated');
  }

  await applyPendingSsoDepartments(user.id, user.email, DEFAULT_TENANT_ID);

  // Resolve roles for OIDC logins (directive §6.3, revised — see
  // rolesManagedLocally on the User model): SSO-issued client-scoped roles in
  // the verified id_token take precedence over local user_roles rows UNLESS a
  // DMS admin explicitly edited this user's roles via DMS's own admin UI
  // (users.service.ts's assignRole/removeRole) and the IdP's assertion hasn't
  // actually moved since that edit — comparing against the snapshot
  // syncUserRolesFromSso stores every time the IdP's assertion wins. This is
  // what makes assigning a role from DMS's own admin UI actually stick for an
  // SSO-authenticated user instead of being silently reverted on their next
  // login, while a genuine SSO-side mapping CHANGE still wins once it
  // changes — the two admin surfaces take turns rather than fighting.
  const claimRoles = [
    ...new Set(
      ((idClaims[EDAMS_ROLES_CLAIM] as string[] | undefined) ?? []).filter(
        Boolean,
      ),
    ),
  ];
  const roleRows = await sequelize.query<{ role_name: string }>(
    `SELECT r.name AS role_name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :userId ORDER BY r.name ASC`,
    { replacements: { userId: user.id }, type: QueryTypes.SELECT },
  );
  const localRoles = roleRows.map((r) => r.role_name);

  // What the IdP itself is asserting right now — the claim, else the
  // ad_groups -> idp_role_mappings fallback — independent of any local
  // override. This is the value compared against the stored snapshot below,
  // and the value syncUserRolesFromSso persists when it wins.
  let idpRoles = claimRoles;
  if (idpRoles.length === 0) {
    const adGroups = (idClaims[AD_GROUPS_CLAIM] as string[] | undefined) ?? [];
    if (adGroups.length > 0) {
      // Use bind ($1) so the JS array is sent as a real Postgres text[] for
      // ANY(); Sequelize `replacements` would inline it as a single string and
      // Postgres rejects it (22P02).
      const mappingRows = await sequelize.query<{ role_name: string }>(
        `SELECT DISTINCT role_name FROM idp_role_mappings
         WHERE relying_party = 'edams' AND ad_group_dn = ANY($1)
         ORDER BY role_name ASC`,
        { bind: [adGroups], type: QueryTypes.SELECT },
      );
      idpRoles = mappingRows.map((r) => r.role_name);
    }
  }
  // Names the IdP asserts that DMS has no role for (typo in the SSO console, a role
  // since deleted) are dropped here, BEFORE the comparison with the stored snapshot
  // and before anything is minted, so the token, user_roles and the next refresh
  // all agree. If nothing survives, the assertion counts as absent and the local
  // roles are kept (never stripped). PLATFORM_ADMIN: see resolveEffectiveRoles.
  idpRoles = await filterToKnownRoles(idpRoles);
  const resolution = resolveEffectiveRoles({
    idpRoles,
    localRoles,
    rolesManagedLocally: user.rolesManagedLocally,
    ssoRolesSnapshot: user.ssoRolesSnapshot,
  });
  const allRoles = resolution.allRoles;

  // Persist an IdP-sourced role set so refreshSession -- which reads
  // user_roles and nothing else -- resolves the SAME roles this login just
  // issued. Without this an SSO user was demoted to the ['EMPLOYEE']
  // fallback on their first token refresh. See syncUserRolesFromSso. Skipped
  // while a local override is active: nothing about the IdP's assertion has
  // changed, so there is nothing new to mirror and doing so would just
  // immediately undo the override it was just found to still apply.
  if (resolution.action === 'sync-idp') {
    await syncUserRolesFromSso(user.id, idpRoles);
  } else if (resolution.action === 'seed-default') {
    // No claim, no AD groups, no local rows: this is a first-time provision
    // and allRoles is the ['EMPLOYEE'] default. Write it so the admin panel
    // and refresh both see something.
    await syncUserRolesFromSso(user.id, allRoles);
  } else if (resolution.recordSnapshot) {
    // A DMS admin's edit stands, but the IdP baseline it is compared against was
    // never recorded (see resolveEffectiveRoles): record it now so only a LATER SSO
    // change can override the edit.
    await User.update({ ssoRolesSnapshot: idpRoles }, { where: { id: user.id } });
  }

  // Audit what the sync actually changed (re-read, so a no-op sync writes nothing and
  // an ignored/unknown role is not reported as granted).
  if (resolution.action !== 'keep-local') {
    const afterRows = await sequelize.query<{ role_name: string }>(
      `SELECT r.name AS role_name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :userId ORDER BY r.name ASC`,
      { replacements: { userId: user.id }, type: QueryTypes.SELECT },
    );
    const after = afterRows.map((r) => r.role_name);
    const added = after.filter((n) => !localRoles.includes(n));
    const removed = localRoles.filter((n) => !after.includes(n));
    if (added.length > 0 || removed.length > 0) {
      await writeAuditLog({
        eventType: AUDIT_EVENTS.SSO_ROLES_SYNCED,
        tenantId: DEFAULT_TENANT_ID,
        userId: user.id,
        previousState: localRoles.join(',').slice(0, 200),
        newState: after.join(',').slice(0, 200),
        actionDetails: { added, removed, via: 'oidc-login' },
      });
    }
  }

  const tenantRows = await sequelize.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM user_tenants WHERE user_id = :userId ORDER BY assigned_at ASC`,
    { replacements: { userId: user.id }, type: QueryTypes.SELECT },
  );
  const userTenants =
    tenantRows.length > 0
      ? tenantRows.map((r) => r.tenant_id)
      : [DEFAULT_TENANT_ID];

  // Multi-tenant users must still select a tenant (return pre-tenant token)
  if (userTenants.length > 1) {
    if (!config.DEV_RSA_PRIVATE_KEY) {
      throw new AppError(
        500,
        'ERR-CONFIG-MISSING',
        'DEV_RSA_PRIVATE_KEY not set',
      );
    }
    const privateKey = Buffer.from(
      config.DEV_RSA_PRIVATE_KEY,
      'base64',
    ).toString('utf-8');
    const now = Math.floor(Date.now() / 1000);
    const preTenantToken = jwt.sign(
      {
        user_id: user.id,
        roles: allRoles,
        role: allRoles[0],
        tenant_selection_required: true,
        available_tenants: userTenants,
        iss: config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER,
        aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE,
        iat: now,
        exp: now + 300,
      },
      privateKey,
      { algorithm: 'RS256', keyid: 'dev-key' },
    );
    return {
      responseBody: {
        tenantSelectionRequired: true,
        availableTenants: userTenants,
        preTenantToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: allRoles,
        },
      },
    };
  }

  // Single-tenant: tenant is resolved, but a multi-role user must still pick
  // which role to act as before a full token is minted — same gate loginMock
  // and selectTenant already apply (see their comments). Without this, an SSO
  // user holding e.g. SYSTEM_ADMIN + AUDITOR + EMPLOYEE silently got the union
  // of all of them on every login, with no way to act as just one.
  const tenantId = userTenants[0];
  if (allRoles.length > 1) {
    if (!config.DEV_RSA_PRIVATE_KEY) {
      throw new AppError(
        500,
        'ERR-CONFIG-MISSING',
        'DEV_RSA_PRIVATE_KEY not set',
      );
    }
    return {
      responseBody: {
        roleSelectionRequired: true,
        availableRoles: allRoles,
        preRoleToken: issuePreRoleToken(user.id, tenantId, allRoles),
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: allRoles,
          tenantId,
        },
      },
    };
  }
  const permissions = await resolveUnionPermissions(
    allRoles,
    tenantId,
    user.id,
  );
  const displayRole = displayRoleOf(allRoles);

  if (!config.DEV_RSA_PRIVATE_KEY) {
    throw new AppError(
      500,
      'ERR-CONFIG-MISSING',
      'DEV_RSA_PRIVATE_KEY not set',
    );
  }
  const privateKey = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString(
    'utf-8',
  );
  const accessJti = randomUUID();
  const accessToken = jwt.sign(
    {
      jti: accessJti,
      user_id: user.id,
      roles: allRoles,
      role: displayRole,
      permissions,
      tenant_id: tenantId,
      iss: config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER,
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE,
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'dev-key',
      expiresIn: dur(config.JWT_ACCESS_EXPIRES_IN),
    },
  );

  const refreshToken = jwt.sign(
    {
      jti: randomUUID(),
      user_id: user.id,
      tenant_id: tenantId,
      roles: allRoles,
      role: displayRole,
    },
    config.JWT_REFRESH_SECRET,
    { expiresIn: dur(config.JWT_REFRESH_EXPIRES_IN) },
  );

  // Security-critical: awaited so an OIDC login is never issued without audit.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUTH_LOGIN,
    userId: user.id,
    tenantId,
    actionDetails: { tenantId, method: 'oidc', externalSub },
  });

  return {
    responseBody: {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: allRoles,
        role: displayRole,
        tenantId,
        permissions,
      },
    },
    refreshToken,
  };
}

/**
 * POST /auth/backchannel-logout
 * OIDC backchannel logout receiver. The IdP POSTs a signed logout token
 * (RS256, verified against AUTH_JWKS_URI) when a user signs out at the SSO
 * portal or is disabled. We resolve the IdP subject to our local user via
 * external_sub and set a user-level revocation cutoff in Redis — every access
 * and refresh token issued at or before that moment dies immediately
 * (enforced in shared/auth.ts and /auth/refresh).
 */
export async function handleBackchannelLogout(
  logoutToken: string,
): Promise<void> {
  if (!logoutToken) {
    throw new AppError(400, 'ERR-INVALID-INPUT', 'logout_token is required');
  }

  // Same JWKS verification path as the OIDC callback (kid→PEM with refresh).
  const headerJson = Buffer.from(
    logoutToken.split('.')[0],
    'base64url',
  ).toString('utf-8');
  const { kid } = JSON.parse(headerJson) as { kid?: string };
  let pems = await getJwksPems();
  if (!pems[kid ?? '_default']) pems = await getJwksPems(true);
  const pem = pems[kid ?? '_default'];
  if (!pem) throw new AppError(400, 'ERR-AUTH-INVALID', 'Unknown signing key');

  let claims: Record<string, unknown>;
  try {
    claims = jwt.verify(logoutToken, pem, {
      algorithms: ['RS256'],
      issuer: config.AUTH_ISSUER,
      audience: config.OIDC_CLIENT_ID ?? config.AUTH_AUDIENCE,
    }) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'ERR-AUTH-INVALID', 'Invalid logout token');
  }

  // Spec checks: the backchannel-logout event must be present; nonce must not.
  const events = claims['events'] as Record<string, unknown> | undefined;
  if (
    !events ||
    !('http://schemas.openid.net/event/backchannel-logout' in events) ||
    claims['nonce']
  ) {
    throw new AppError(400, 'ERR-AUTH-INVALID', 'Not a valid logout token');
  }
  const sub = String(claims['sub'] ?? '');
  if (!sub)
    throw new AppError(400, 'ERR-AUTH-INVALID', 'logout token missing sub');

  const user = await User.findOne({ where: { externalSub: sub } as any });
  if (user) {
    // R-04: was a raw Redis SET, so an IdP-initiated logout was silently a
    // no-op whenever Redis was unavailable — the one revocation path where
    // the caller is an external system that will never retry. Routed through
    // revokeAllUserSessions so it lands in Postgres like every other
    // revocation; no transaction to join here, since there is no accompanying
    // domain change to be atomic with.
    await revokeAllUserSessions(user.id, { reason: 'idp-backchannel-logout' });
    // The only DMS-side trace that SSO ended this person's sessions (sign-out, disable,
    // role or group change). Best-effort: the revocation above is already durable, and a
    // failure here must not turn into a 5xx that makes the IdP retry a finished job.
    await writeAuditLog({
      eventType: AUDIT_EVENTS.AUTH_LOGOUT,
      tenantId: DEFAULT_TENANT_ID,
      userId: user.id,
      actionDetails: { via: 'idp-backchannel-logout', externalSub: sub },
    }).catch((err) => logger.error({ err, userId: user.id }, 'failed to audit IdP backchannel logout'));
  }
  // Always ok for unknown users — do not leak which subjects exist here (the
  // route always responds 200 regardless of whether a user was found).
}
