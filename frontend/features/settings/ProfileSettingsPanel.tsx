'use client';

// Settings → Profile: the two per-user knobs the backend supports —
//  * handwritten signature image (SYSTEM-DECISIONS.md D8c), rendered above the
//    typed name on letters this user finally approves;
//  * executive-notice opt-out (D10) — stop the approved-letter emails.

import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronUp, IdCard, PenLine, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { useOrgUnits } from '../../shared/hooks/useLookups';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useAuthStore } from '../../state/auth.store';

// getMe (users.service.ts) includes both associations unconditionally, so
// this is always present on a successful response — not an optional extra
// the frontend has to degrade around.
type Me = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  signatureImage?: string | null;
  execNoticeOptOut?: boolean;
  roles?: Array<{ id?: string; name?: string }>;
  departments?: Array<{ id: string; name: string; code: string; orgUnitId?: string | null }>;
};

// FIX 2026-09-14: was PNG/JPEG-only at 200 KB. The backend
// (users.service.ts's setSignatureImage) now accepts PNG/JPEG/WEBP/GIF and
// converts whatever comes in to a canonical PNG server-side (with sharp) —
// letterPdf.ts's embedder only knows PNG/JPEG, pdf-lib has no native
// WEBP/GIF support, so normalizing at save time is what makes those formats
// actually work end to end rather than uploading fine and then silently
// never appearing on a letter. ACCEPTED_TYPES/MAX_INPUT_BYTES mirror the
// backend's pre-conversion checks so a rejection surfaces immediately
// instead of after a round trip; the backend's own 1 MB cap is on the
// *converted* PNG, which can't be known client-side before uploading.
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

/** PERMISSION -> "Category" for the account/access card below — purely a
 *  display grouping (derived from the `resource:action` naming convention
 *  every permission in config/permissions.ts already follows), not a new
 *  source of truth for what any permission means. */
function permissionCategory(permission: string): string {
  return permission.split(':')[0] ?? 'other';
}

export function ProfileSettingsPanel() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const { data: me } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => apiClient<Me>('/users/me'),
  });
  const { data: orgUnits } = useOrgUnits();
  const orgUnitNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of orgUnits ?? []) map.set(u.id, u.name);
    return map;
  }, [orgUnits]);
  // The resolved, EFFECTIVE permission set (role permissions unioned with
  // any personal grant/revoke overrides, already baked into the session by
  // the backend at login/refresh — see roles.service.ts's
  // resolveUnionPermissions) — this is what actually gates every action in
  // the app, so it's the accurate answer to "what can I do", not just the
  // role's default static list.
  const { permissions, role } = usePermissions();
  const switchRoleAction = useAuthStore((s) => s.switchRole);
  const [switchingRole, setSwitchingRole] = useState<string | null>(null);
  // FIX 2026-09-14: this list is a transparency feature (verify exactly what
  // the system resolves, not the role's default), but rendered flat it's a
  // wall of raw resource:action strings — fine for a handful of permissions,
  // overwhelming for an account holding dozens across every category (e.g.
  // PLATFORM_ADMIN). Collapsed by default behind a one-line summary; still
  // one click away, not buried.
  const [showAllPermissions, setShowAllPermissions] = useState(false);

  // FIX: multi-role users (e.g. SYSTEM_ADMIN + DEPT_MANAGER + EMPLOYEE all at
  // once) previously had every role's permissions silently unioned together
  // with no way to act as just one — "sign in as role X" only makes sense if
  // there's somewhere to change your mind afterward. `me.roles` (the live DB
  // join from GET /users/me, unaffected by which role happens to be active in
  // the current token) is the authoritative list of roles this user actually
  // holds; `role` (from the session's permissions) is the one currently active.
  const otherRoles = (me?.roles ?? [])
    .map((r) => r.name)
    .filter((name): name is string => Boolean(name) && name !== role);

  async function handleSwitchRole(roleName: string) {
    if (switchingRole) return;
    setSwitchingRole(roleName);
    try {
      await switchRoleAction(roleName);
      toast.success(`Now signed in as ${roleName.replace(/_/g, ' ')}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to switch role');
    } finally {
      setSwitchingRole(null);
    }
  }
  const permissionsByCategory = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const p of permissions) {
      const cat = permissionCategory(p);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  const setImage = useMutation({
    mutationFn: (signatureImage: string | null) =>
      apiClient('/users/me/signature-image', { method: 'PUT', body: JSON.stringify({ signatureImage }) }),
    onSuccess: (_r, img) => {
      toast.success(img ? 'Signature image saved' : 'Signature image removed');
      qc.invalidateQueries({ queryKey: ['me-profile'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const setOptOut = useMutation({
    mutationFn: (optOut: boolean) =>
      apiClient('/users/me/exec-notice-opt-out', { method: 'PUT', body: JSON.stringify({ optOut }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-profile'] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error('Signature must be a PNG, JPEG, WEBP, or GIF image');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      toast.error('Signature image must be under 5 MB');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsDataURL(file);
      });
      await setImage.mutateAsync(dataUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="ui-card">
        <h3 className="text-sm font-bold flex items-center gap-2 mb-1">
          <IdCard className="h-4 w-4 text-brand-600" /> Account &amp; access
        </h3>
        <p className="text-xs text-text-muted mb-4">
          Your identity and current effective permissions, exactly as the system
          resolves them right now — this is what actually gates what you can do
          (role permissions plus any personal grant/revoke on top), not just the
          role&apos;s default list.
        </p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm mb-4">
          <div>
            <dt className="text-xs font-semibold text-text-muted uppercase tracking-wide">Name</dt>
            <dd className="text-text-primary">{me ? `${me.firstName} ${me.lastName}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-text-muted uppercase tracking-wide">Email</dt>
            <dd className="text-text-primary">{me?.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Role{(me?.roles?.length ?? 0) > 1 ? 's held' : ''}
            </dt>
            <dd className="text-text-primary">
              {me?.roles?.length ? me.roles.map((r) => r.name).filter(Boolean).join(', ') : (role ?? '—')}
            </dd>
            {otherRoles.length > 0 && (
              <div className="mt-1.5">
                <p className="text-[11px] text-text-muted mb-1">
                  Currently signed in as <span className="font-semibold text-text-primary">{role}</span> — switch to:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {otherRoles.map((roleName) => (
                    <button
                      key={roleName}
                      onClick={() => handleSwitchRole(roleName)}
                      disabled={Boolean(switchingRole)}
                      className="text-[11px] font-medium px-2 py-1 rounded-full border border-border-subtle hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {switchingRole === roleName ? 'Switching…' : roleName.replace(/_/g, ' ')}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <dt className="text-xs font-semibold text-text-muted uppercase tracking-wide">Department{(me?.departments?.length ?? 0) > 1 ? 's' : ''} / Org Unit</dt>
            <dd className="text-text-primary">
              {me?.departments?.length ? (
                <ul className="space-y-0.5">
                  {me.departments.map((d) => (
                    <li key={d.id}>
                      {d.name} ({d.code})
                      {d.orgUnitId && orgUnitNameById.get(d.orgUnitId) ? (
                        <span className="text-text-muted"> — {orgUnitNameById.get(d.orgUnitId)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-text-muted">Not a member of any department</span>
              )}
            </dd>
          </div>
        </dl>
        <div>
          <button
            type="button"
            onClick={() => setShowAllPermissions((v) => !v)}
            disabled={permissionsByCategory.length === 0}
            className="flex w-full items-center justify-between gap-2 text-left disabled:cursor-default"
          >
            <h4 className="flex items-center gap-1.5 text-xs font-semibold text-text-muted uppercase tracking-wide">
              <ShieldCheck className="h-3.5 w-3.5" /> Permissions ({permissions.length} across {permissionsByCategory.length} categor{permissionsByCategory.length === 1 ? 'y' : 'ies'})
            </h4>
            {permissionsByCategory.length > 0 && (
              showAllPermissions
                ? <ChevronUp className="h-3.5 w-3.5 text-text-muted shrink-0" />
                : <ChevronDown className="h-3.5 w-3.5 text-text-muted shrink-0" />
            )}
          </button>
          {permissionsByCategory.length === 0 && (
            <p className="text-xs text-text-muted mt-2">No permissions resolved for this session.</p>
          )}
          {permissionsByCategory.length > 0 && !showAllPermissions && (
            <p className="text-xs text-text-muted mt-2">
              {permissionsByCategory.map(([category]) => category).sort().join(', ')} — click to expand
            </p>
          )}
          {permissionsByCategory.length > 0 && showAllPermissions && (
            <div className="space-y-2 mt-2">
              {permissionsByCategory.map(([category, perms]) => (
                <div key={category} className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-xs font-semibold text-text-secondary capitalize shrink-0">{category}:</span>
                  {perms.sort().map((p) => (
                    <span
                      key={p}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-raised border border-border-subtle text-text-secondary"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ui-card">
        <h3 className="text-sm font-bold flex items-center gap-2 mb-1">
          <PenLine className="h-4 w-4 text-brand-600" /> Handwritten signature
        </h3>
        <p className="text-xs text-text-muted mb-4">
          Optional. A PNG, JPEG, WEBP, or GIF of your signature (under 5 MB, ideally dark ink
          on a transparent or white background). It is printed above your typed name on
          letters you finally approve — the content hash and QR code remain the real
          authenticity guarantee.
        </p>
        {/* Drag-and-drop is a pointer-only shortcut layered over the real
            control: the file <input> and the button that opens it are inside
            this box and are fully keyboard operable, so nothing here is
            reachable only by dragging. role="presentation" states that
            honestly — the drop target itself carries no semantics a screen
            reader should announce or try to operate. */}
        <div
          onDrop={(e) => { e.preventDefault(); setIsDragOver(false); void onPickFile(e.dataTransfer.files?.[0]); }}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          role="presentation"
          className="rounded-lg"
          style={isDragOver ? { outline: '2px dashed var(--brand-500)', outlineOffset: 4 } : undefined}
        >
          {me?.signatureImage ? (
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={me.signatureImage} alt="Your signature" className="h-16 max-w-[240px] object-contain rounded border border-border-subtle bg-white p-1" />
              <div className="flex gap-2">
                <button onClick={() => fileInput.current?.click()} disabled={busy} className="ui-btn ui-btn-secondary text-xs">
                  <Upload className="h-3.5 w-3.5" /> Replace
                </button>
                <button onClick={() => setImage.mutate(null)} disabled={setImage.isPending} className="ui-btn ui-btn-danger text-xs">
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="w-full flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-4 text-xs"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              <Upload className="h-5 w-5" />
              <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Upload signature image</span>
              <span>Drag & drop an image here, or click to browse</span>
            </button>
          )}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0])} />
      </div>

      <div className="ui-card">
        <h3 className="text-sm font-bold mb-1">Executive letter notices</h3>
        <p className="text-xs text-text-muted mb-3">
          Executives receive an email whenever a letter is finally approved (subject to
          the tenant&apos;s notice policy). Opting out stops those emails for you personally —
          you keep your read access to the letters register.
        </p>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={me?.execNoticeOptOut ?? false}
            onChange={(e) => setOptOut.mutate(e.target.checked)}
            disabled={setOptOut.isPending}
          />
          Don&apos;t email me approved-letter notices
        </label>
      </div>
    </div>
  );
}
