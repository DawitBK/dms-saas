/**
 * SSO -> DMS identity and role reconciliation, as used by the OIDC callback
 * (auth.service.ts completeOidcCallback). Extracted from that function so the
 * conflict rules can be unit-tested; the rules themselves are written down in
 * Documentations/SSO-DMS-SYNC-AND-CONFLICT-RULES.md and every branch below is
 * one row of that table.
 *
 * Two independent questions are answered here:
 *
 *  1. WHICH DMS ACCOUNT is this IdP identity?  (resolveOidcUser)
 *     `sub` is the identity; email is only a lookup key for the one-time
 *     adoption of a pre-existing account and a value to follow when the IdP
 *     changes it. Email comparison is CASE-INSENSITIVE because the database
 *     unique index (users_email_key) is case-sensitive: matching exactly would
 *     let `Alice@x.com` (legacy row) and `alice@x.com` (what SSO sends, always
 *     lower-cased) become two accounts that split one person's documents.
 *
 *  2. WHICH ROLES does the login carry?  (resolveEffectiveRoles)
 *     SSO's assertion wins unless a DMS admin edited the user's roles locally
 *     and SSO's assertion has not moved since (turn-taking, see User model).
 *     PLATFORM_ADMIN is outside the exchange in both directions.
 */
import { randomUUID } from 'node:crypto';
import { UniqueConstraintError, QueryTypes, fn, col, where as sqlWhere } from 'sequelize';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import { User, UserTenant, sequelize } from '../../infrastructure/database/index.js';
import { runInTransaction } from '../../shared/transaction.js';
import { PLATFORM_ADMIN_ROLE, getPlatformAdminUserIds } from '../../shared/platformAdmin.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';

export interface OidcIdentity {
  externalSub: string;
  email: string;
  givenName: string;
  familyName: string;
}

/** Every row (soft-deleted included, the model is not paranoid) whose email equals `email` ignoring case. */
export async function findUsersByEmailCI(email: string): Promise<User[]> {
  const lower = email.trim().toLowerCase();
  return User.findAll({ where: sqlWhere(fn('lower', col('email')), lower) });
}

/**
 * Find, adopt, update or provision the DMS account for a verified IdP identity.
 * Throws AppError 409 for every case that needs an administrator instead of a
 * guess; never silently merges, re-points or duplicates an account.
 */
export async function resolveOidcUser(identity: OidcIdentity, defaultTenantId: string): Promise<User> {
  const { externalSub } = identity;
  const email = identity.email.trim();
  const emailLc = email.toLowerCase();

  let user = await User.findOne({ where: { externalSub } });

  if (!user) {
    const matches = await findUsersByEmailCI(emailLc);
    if (matches.length > 1) {
      // Two DMS rows differ only by letter case (the unique index allows it). Which one
      // is "the" account cannot be decided here without risking documents going to the
      // wrong person; an admin merges or removes one.
      logger.error(
        { email: emailLc, userIds: matches.map((m) => m.id), presentedSub: externalSub },
        'OIDC login refused: several DMS accounts match this email ignoring case',
      );
      throw new AppError(
        409,
        'ERR-OIDC-EMAIL-AMBIGUOUS',
        'More than one account matches this email address — contact an administrator',
      );
    }
    const byEmail = matches[0];
    if (byEmail) {
      if (byEmail.externalSub && byEmail.externalSub !== externalSub) {
        logger.error(
          { email: emailLc, existingSub: byEmail.externalSub, presentedSub: externalSub },
          'OIDC login refused: email already bound to a different IdP subject',
        );
        throw new AppError(
          409,
          'ERR-OIDC-SUBJECT-CONFLICT',
          'This email address is already linked to a different identity-provider account — contact an administrator',
        );
      }
      // Adopt an existing local (or unlinked) account exactly once, and record
      // it, so the link is auditable rather than inferred later from a NULL.
      try {
        await byEmail.update({ externalSub });
      } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        // A concurrent callback for the same identity linked a row first.
        const winner = await User.findOne({ where: { externalSub } });
        if (!winner) throw err;
        return winner;
      }
      logger.info({ userId: byEmail.id, email: emailLc }, 'linked existing DMS account to IdP subject');
      await writeAuditLog({
        eventType: AUDIT_EVENTS.SSO_ACCOUNT_LINKED,
        tenantId: defaultTenantId,
        userId: byEmail.id,
        actionDetails: { email: emailLc, externalSub, via: 'oidc-login-email-adoption' },
      });
      user = byEmail;
    }
  } else if (user.email.toLowerCase() !== emailLc) {
    // Same person, address changed at the IdP. `sub` is the identity, so follow
    // it rather than provisioning a second account for the new address.
    const platformAdminIds = await getPlatformAdminUserIds();
    if (platformAdminIds.includes(user.id)) {
      // The database refuses to rename this account (platform_admin_guard); do not
      // even try, or the platform owner's own login would fail with a 500.
      logger.warn({ userId: user.id }, 'IdP email differs for the platform admin account - DMS email left unchanged');
    } else {
      const clash = (await findUsersByEmailCI(emailLc)).filter((u) => u.id !== user!.id);
      if (clash.length > 0) {
        logger.error(
          { userId: user.id, newEmail: emailLc, holderIds: clash.map((c) => c.id) },
          'OIDC login refused: the IdP changed this identity to an email another DMS account already holds',
        );
        throw new AppError(
          409,
          'ERR-OIDC-EMAIL-CONFLICT',
          'The email address on your identity-provider account is already used by another account — contact an administrator',
        );
      }
      const previousEmail = user.email;
      try {
        await user.update({ email: emailLc });
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new AppError(
            409,
            'ERR-OIDC-EMAIL-CONFLICT',
            'The email address on your identity-provider account is already used by another account — contact an administrator',
          );
        }
        throw err;
      }
      logger.info({ userId: user.id }, 'updated DMS account email from IdP subject');
      await writeAuditLog({
        eventType: AUDIT_EVENTS.SSO_EMAIL_UPDATED,
        tenantId: defaultTenantId,
        userId: user.id,
        previousState: previousEmail,
        newState: emailLc,
        actionDetails: { externalSub, via: 'oidc-login-sub-match' },
      });
    }
  }

  if (user) return user;

  // runInTransaction, not a bare sequelize.transaction(): DMS/CLAUDE.md makes
  // that the convention for request-path writes. Here it lands on the fallback
  // branch (this is a public route, so tenantContext has not opened an ambient
  // transaction) which is exactly the real transaction wanted.
  try {
    const created = await runInTransaction(async () => {
      const row = await User.create({
        // Lower-cased like createUser does, so the case-insensitive lookups above
        // and users.service's lower(email) comparisons agree on one form.
        email: emailLc,
        firstName: identity.givenName || emailLc.split('@')[0],
        lastName: identity.familyName || '',
        passwordHash: randomUUID(), // unusable password: OIDC-provisioned users authenticate via the IdP
        isActive: true,
        externalSub,
      } as any);
      // Real membership, not just the login-time fallback: without a
      // user_tenants row the user is invisible to the users RLS policy inside
      // any tenant context and only reachable via the legacy default-tenant
      // fallback. assignedBy is null: no acting user on this public callback.
      await UserTenant.create({ userId: row.id, tenantId: defaultTenantId, assignedBy: null });
      return row;
    });
    await writeAuditLog({
      eventType: AUDIT_EVENTS.SSO_USER_PROVISIONED,
      tenantId: defaultTenantId,
      userId: created.id,
      actionDetails: { email: emailLc, externalSub, via: 'oidc-login-jit' },
    });
    return created;
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    // Two callbacks for the same new identity raced (second tab, retried
    // request): the loser's INSERT violates users_external_sub_unique or
    // users_email_key. If the winner is this identity, use its row.
    const winner = await User.findOne({ where: { externalSub } });
    if (winner) return winner;
    // Otherwise the violation was on email: an account appeared (or exists under
    // an exact-case spelling the CI lookup could not see) between our check and
    // our insert. Do not guess.
    throw new AppError(
      409,
      'ERR-OIDC-EMAIL-CONFLICT',
      'This email address is already used by another account — contact an administrator',
    );
  }
}

/**
 * Keep only the role names that exist in `roles`. An IdP claim (or a stored
 * group mapping) can name a role DMS does not have - a typo in the SSO console,
 * a role since deleted from DMS. Such a name must not reach the token: the
 * token would carry a role with no permissions while user_roles (which cannot
 * hold it) keeps the old set, and the next refresh would silently disagree
 * with the login. Dropping it up front makes login, sync and refresh agree;
 * if NOTHING survives, the caller treats the assertion as absent and falls
 * back to the local roles instead of stripping access.
 */
export async function filterToKnownRoles(names: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(names.filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await sequelize.query<{ name: string }>(`SELECT name FROM roles WHERE name = ANY($1::text[])`, {
    bind: [wanted],
    type: QueryTypes.SELECT,
  });
  const known = new Set(rows.map((r) => r.name));
  const unknown = wanted.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    logger.warn({ unknown }, 'IdP asserted role names with no matching DMS role - ignored');
  }
  return wanted.filter((n) => known.has(n));
}

/**
 * Validate the role names of a group -> role mapping write (internal API, called by the
 * SSO admin console): every name must be a role DMS has, PLATFORM_ADMIN can never be
 * mapped, duplicates collapse (the table's unique key would turn ['A','A'] into a 500
 * halfway through the replace). Returns the de-duplicated list to store; throws 422.
 * An empty list is valid - it unmaps the group.
 */
export async function assertMappableRoleNames(roleNames: readonly string[]): Promise<string[]> {
  const requested = [...new Set(roleNames)];
  if (requested.includes(PLATFORM_ADMIN_ROLE)) {
    // Same generic answer as the hidden-role rule elsewhere, so it cannot be probed.
    throw new AppError(422, 'ERR-ROLE-INVALID', 'One or more roles are not valid');
  }
  if (requested.length === 0) return requested;
  const rows = await sequelize.query<{ name: string }>(`SELECT name FROM roles WHERE name = ANY($1::text[])`, {
    bind: [requested],
    type: QueryTypes.SELECT,
  });
  const existing = new Set(rows.map((r) => r.name));
  const unknown = requested.filter((n) => !existing.has(n));
  if (unknown.length > 0) {
    throw new AppError(422, 'ERR-ROLE-NOT-FOUND', `Unknown DMS role(s): ${unknown.join(', ')}`);
  }
  return requested;
}

export interface RoleResolutionInput {
  /** What the IdP asserts now, already reduced to roles that exist in DMS. */
  idpRoles: readonly string[];
  /** Role names currently in user_roles. */
  localRoles: readonly string[];
  rolesManagedLocally: boolean;
  ssoRolesSnapshot: readonly string[] | null | undefined;
}

export interface RoleResolution {
  allRoles: string[];
  /** 'keep-local': write nothing. 'sync-idp': mirror the IdP set into user_roles.
   *  'seed-default': first provision with no IdP set and no local rows. */
  action: 'keep-local' | 'sync-idp' | 'seed-default';
  /** Under a local override whose IdP baseline was never recorded: store it now. */
  recordSnapshot: boolean;
  localOverrideActive: boolean;
}

/** Order-independent equality for role-name arrays (SSO claim vs. stored snapshot). */
export function sameRoleSet(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

/**
 * The conflict rule between SSO's role assertion and a DMS admin's local edit.
 *
 *  - PLATFORM_ADMIN is never granted from an assertion (only an account that
 *    already holds it keeps it) and is never removed by one.
 *  - SSO asserts roles and has not changed its assertion since the last time it
 *    won, and a DMS admin edited the roles since: the DMS edit stands.
 *  - A DMS edit exists but no baseline was ever recorded (user predates the
 *    snapshot column, or never had an IdP-won login): the edit stands and the
 *    current assertion becomes the baseline, so only a LATER SSO change can
 *    override it. (Previously a missing baseline compared as "changed" and the
 *    admin's edit was wiped at the very next login.)
 *  - Otherwise SSO's assertion wins; with no assertion the local roles are kept;
 *    with neither, EMPLOYEE.
 */
export function resolveEffectiveRoles(input: RoleResolutionInput): RoleResolution {
  const holdsPlatformAdmin = input.localRoles.includes(PLATFORM_ADMIN_ROLE);
  const idpRoles = holdsPlatformAdmin ? [...input.idpRoles] : input.idpRoles.filter((r) => r !== PLATFORM_ADMIN_ROLE);
  const rolesFromIdp = idpRoles.length > 0;

  const baselineMissing = input.ssoRolesSnapshot == null;
  const localOverrideActive =
    input.rolesManagedLocally &&
    input.localRoles.length > 0 &&
    (baselineMissing || sameRoleSet(idpRoles, input.ssoRolesSnapshot));

  let allRoles: string[];
  let action: RoleResolution['action'];
  if (localOverrideActive) {
    allRoles = [...input.localRoles];
    action = 'keep-local';
  } else if (rolesFromIdp) {
    allRoles = idpRoles;
    action = 'sync-idp';
  } else if (input.localRoles.length > 0) {
    allRoles = [...input.localRoles];
    action = 'keep-local';
  } else {
    allRoles = ['EMPLOYEE'];
    action = 'seed-default';
  }

  if (holdsPlatformAdmin && !allRoles.includes(PLATFORM_ADMIN_ROLE)) allRoles = [PLATFORM_ADMIN_ROLE, ...allRoles];

  return {
    allRoles,
    action,
    localOverrideActive,
    recordSnapshot: localOverrideActive && baselineMissing && rolesFromIdp,
  };
}
