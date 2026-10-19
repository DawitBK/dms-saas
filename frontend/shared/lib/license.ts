// shared/lib/license.ts
//
// Platform licensing, frontend half (docs/operations/PLATFORM-LICENSING.md at the repo root; backend:
// backend/src/modules/license/). Pure helpers only: the status type, the module keys, which sidebar entries belong to
// which module, the banner wording, and the plain-language wording for the three licence error codes the API can
// answer. Anything that needs React or the network is in shared/hooks/useLicense.ts and
// shared/components/LicenseBanner.tsx.
//
// Fail OPEN everywhere in the UI too: no status yet (loading, SSO or the API unreachable, an older backend with no
// /license/status) means "show everything, no banner". The server is the enforcement; the UI only explains.

export type LicenseState = 'unconfigured' | 'unknown' | 'active' | 'expiring' | 'grace' | 'expired';

/** GET /license/status (contract section 5; `enforcement` is DMS's additive field). */
export interface LicenseStatus {
  system: string;
  state: LicenseState;
  customer: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  daysRemaining: number | null;
  warnDays: number | null;
  graceDays: number | null;
  readOnly: boolean;
  maxUsers: number | null;
  seatsUsed: number | null;
  /** null = every module enabled */
  modules: string[] | null;
  source: 'sso' | 'cache' | 'none';
  fetchedAt: string | null;
  version: number | null;
  enforcement?: 'enforce' | 'warn' | 'off';
}

export const LICENSE_QUERY_KEY = ['license', 'status'] as const;

/** Gateable module keys, verbatim from the contract (backend: license.constants.ts DMS_LICENSE_MODULES). */
export const LICENSE_MODULES = [
  'letters',
  'workflow',
  'esigning',
  'legal_hold',
  'retention',
  'ai',
  'ocr',
  'search',
  'archive',
  'reports',
  'bundles',
  'webhooks',
  'forms',
] as const;
export type LicenseModuleKey = (typeof LICENSE_MODULES)[number];

export const LICENSE_ERROR = {
  EXPIRED: 'LICENSE_EXPIRED',
  MODULE_DISABLED: 'LICENSE_MODULE_DISABLED',
  SEAT_LIMIT: 'LICENSE_SEAT_LIMIT',
} as const;

/** Is this module available? No status (yet) or no enforcement means yes. */
export function isModuleEnabled(status: LicenseStatus | null | undefined, key: LicenseModuleKey): boolean {
  if (!status) return true;
  if (status.state === 'unconfigured' || status.state === 'unknown') return true;
  if (status.enforcement === 'off') return true;
  return status.modules === null || status.modules.includes(key);
}

// ── error wording ────────────────────────────────────────────────────────────────────────────────────────

const WORDING: Record<string, { title: string; message: string }> = {
  [LICENSE_ERROR.EXPIRED]: {
    title: 'Read-only: licence expired',
    message:
      'The DMS licence has expired, so the system is read-only. You can still open and download documents, but nothing can be created or changed until the licence is renewed. Contact your administrator.',
  },
  [LICENSE_ERROR.MODULE_DISABLED]: {
    title: 'Not included in your licence',
    message: 'This part of DMS is not included in your organisation’s licence. Contact your administrator if you need it.',
  },
  [LICENSE_ERROR.SEAT_LIMIT]: {
    title: 'User limit reached',
    message:
      'Your licence’s user limit has been reached, so no more accounts can be created or activated. Deactivate an account that is no longer needed, or ask your administrator to raise the limit.',
  },
};

export function isLicenseErrorCode(code: string | undefined | null): boolean {
  return !!code && Object.prototype.hasOwnProperty.call(WORDING, code);
}

/** Plain-language wording for a licence error code, or undefined for any other code. */
export function licenseWording(code: string | undefined | null): { title: string; message: string } | undefined {
  return isLicenseErrorCode(code) ? WORDING[code as string] : undefined;
}

// ── sidebar: which entries belong to which module ─────────────────────────────────────────────────────────

/**
 * Sidebar entries (by href) that disappear when their module is not licensed. Mirrors the backend's route groups
 * (licenseGate.ts MODULE_ROUTES): an entry whose page reads a gated route group is hidden with it, otherwise the page
 * would open onto a 403. `ocr` has no route group of its own; it hides only the OCR review panel.
 */
export const NAV_MODULE_BY_HREF: Record<string, LicenseModuleKey> = {
  '/dashboard/mywork': 'workflow', // reads /approvals/my/work
  '/dashboard/reports': 'reports',
  '/dashboard/storage': 'reports', // reads /reports/storage/analytics
  '/dashboard/search': 'search',
  '/dashboard/ai': 'ai',
  '/dashboard/forms/templates': 'forms',
  '/dashboard/forms/fill': 'forms',
  '/dashboard/forms/submissions': 'forms',
  '/dashboard/signing/pending': 'esigning',
  '/dashboard/signing/sent': 'esigning',
  '/dashboard/signing/completed': 'esigning',
  '/dashboard/signing/overview': 'esigning',
  '/dashboard/signing': 'esigning',
  '/dashboard/letters': 'letters',
  '/dashboard/bundles': 'bundles',
  '/operations?panel=workflows': 'workflow',
  '/operations?panel=workflowDefs': 'workflow',
  '/operations?panel=approvalChains': 'workflow',
  '/operations?panel=lifecycle': 'retention',
  '/operations?panel=retentionPolicies': 'retention',
  '/operations?panel=legalHold': 'legal_hold',
  '/operations?panel=ocr': 'ocr',
  '/operations?panel=aiControls': 'ai',
  '/operations?panel=webhooks': 'webhooks',
  // Command-palette destinations that are not sidebar entries (same module as the screens they stand for).
  '/approver': 'workflow',
  '/records-officer': 'retention',
};

/**
 * Is a navigation target (sidebar entry or command-palette link) available under the licence? Hrefs with no module
 * (core pages, anything unmapped) always are. `isModuleOn` is `useLicenseModules().isModuleOn`. The ONE helper the
 * sidebar and the command palette share, so a module a licence switches off disappears from both.
 */
export function isNavHrefLicensed(href: string, isModuleOn: (key: LicenseModuleKey) => boolean): boolean {
  const m = NAV_MODULE_BY_HREF[href];
  return !m || isModuleOn(m);
}

// ── banner ───────────────────────────────────────────────────────────────────────────────────────────────

export interface LicenseBannerModel {
  tone: 'warning' | 'danger';
  title: string;
  body: string;
}

const DAY_MS = 86_400_000;

export function formatLicenseDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What to tell the user, or null for nothing. `active`, `unknown` and `unconfigured` never show anything (owner decision
 * 2026-10-19: "no licence configured" is not a message anyone should see).
 */
export function licenseBanner(
  status: LicenseStatus | null | undefined,
  opts: { now?: Date; locale?: string } = {},
): LicenseBannerModel | null {
  if (!status) return null;
  const now = opts.now ?? new Date();
  const on = formatLicenseDate(status.expiresAt, opts.locale);

  switch (status.state) {
    case 'expiring': {
      const days = Math.max(0, status.daysRemaining ?? 0);
      return {
        tone: 'warning',
        title: days === 0 ? 'Licence expires today' : `Licence expires in ${plural(days, 'day', 'days')}`,
        body: `Your DMS licence expires on ${on}. Contact your administrator to renew it so nothing is interrupted.`,
      };
    }

    case 'grace': {
      const left = status.graceEndsAt ? Math.max(0, Math.ceil((new Date(status.graceEndsAt).getTime() - now.getTime()) / DAY_MS)) : null;
      const until = formatLicenseDate(status.graceEndsAt, opts.locale);
      return {
        tone: 'warning',
        title: 'Licence expired: grace period',
        body:
          `Your DMS licence expired on ${on}. Everything keeps working` +
          (until ? ` until ${until}${left !== null ? ` (${plural(left, 'day', 'days')} left)` : ''}` : '') +
          ', then DMS becomes read-only. Contact your administrator to renew it.',
      };
    }

    case 'expired':
      return status.readOnly
        ? {
            tone: 'danger',
            title: 'Licence expired: DMS is read-only',
            body: 'You can still open and download documents, but nothing can be created or changed until the licence is renewed. Contact your administrator.',
          }
        : {
            tone: 'warning',
            title: 'Licence expired (warning only)',
            body: `The DMS licence expired${on ? ` on ${on}` : ''}. Enforcement is set to warn, so nothing is blocked yet. Contact your administrator to renew it.`,
          };

    default:
      return null;
  }
}
