'use client';

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { apiClient } from '../../shared/lib/apiClient';
import { cn } from '../../shared/lib/cn';
import { useAuthStore } from '../../state/auth.store';
import { Server, CheckCircle2, XCircle, RefreshCw, Cpu, Globe, Trash2, Plus, AlertTriangle, KeyRound, ScanText, Sparkles, Send, BellOff } from 'lucide-react';

export function SystemHealthPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => apiClient<any>('/operations/health'),
    refetchInterval: 30000,
    staleTime: 15_000,
  });

  const services = [
    { name: 'API Server', key: 'api', status: 'UP' },
    {
      name: 'Database (PostgreSQL)',
      key: 'db',
      status: data?.db === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
    },
    {
      name: 'MinIO Storage',
      key: 'minio',
      status: data?.minio === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
    },
    {
      name: 'Meilisearch',
      key: 'meilisearch',
      status:
        data?.meilisearch === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
    },
    {
      name: 'Redis / BullMQ',
      key: 'redis',
      status: data?.redis === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
    },
    {
      name: 'Outbox Processor',
      key: 'outbox',
      status:
        data?.outbox === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
    },
    // The API returned these two all along but the screen never showed them: a background-worker
    // process that has silently stopped, and a virus scanner that is switched off or unreachable
    // (uploads still succeed in both cases, so nothing else would reveal it).
    {
      name: 'Background workers',
      key: 'workers',
      status: data?.workers === 'ok' ? 'UP' : isLoading ? 'CHECKING' : 'DEGRADED',
      note: data?.workers !== 'ok' && data?.workersOfflineReason ? String(data.workersOfflineReason) : null,
    },
    {
      name: 'Antivirus (ClamAV)',
      key: 'antivirus',
      status: data?.antivirus === 'ok' ? 'UP' : data?.antivirus === 'disabled' ? 'DISABLED' : isLoading ? 'CHECKING' : 'DEGRADED',
      note: data?.antivirus === 'unreachable' ? 'Scanner not reachable: uploads are accepted unscanned' : data?.antivirus === 'disabled' ? 'Scanning is switched off for this deployment' : null,
    },
  ] as { name: string; key: string; status: string; note?: string | null }[];

  // Was computed by /health but never rendered anywhere — an admin had no way
  // to see the outbox backlog growing without querying the DB directly.
  const outboxPending = data?.outboxPending != null ? Number(data.outboxPending) : null;

  return (
    <div className="space-y-3">
      {services.map((svc) => (
        <div
          key={svc.key}
          className="flex items-center justify-between p-3 bg-surface-hover rounded-xl border border-border-subtle"
        >
          <div className="flex items-center gap-2.5">
            <Server className="h-4 w-4 text-text-muted" />
            <span className="text-sm font-semibold text-text-primary">
              {svc.name}
            </span>
            {svc.note && <span className="text-xs text-text-muted">{svc.note}</span>}
          </div>
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${
              svc.status === 'UP'
                ? 'bg-green-100 text-green-700'
                : svc.status === 'CHECKING' || svc.status === 'DISABLED'
                  ? 'bg-surface-raised text-text-muted'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {svc.status === 'UP' ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : svc.status === 'CHECKING' ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            {svc.status}
          </span>
        </div>
      ))}
      {outboxPending !== null && (
        <div className="flex items-center justify-between p-3 bg-surface-hover rounded-xl border border-border-subtle">
          <span className="text-sm font-semibold text-text-primary">Outbox backlog</span>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
              outboxPending === 0 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
            }`}
          >
            {outboxPending} pending
          </span>
        </div>
      )}
      <button
        onClick={() => refetch()}
        className="w-full mt-2 text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center justify-center gap-1.5 py-2"
      >
        <RefreshCw className="h-3 w-3" /> Refresh Status
      </button>
    </div>
  );
}

import { UsersManagementPanel } from '../users/UsersManagementPanel';

export function UsersPanel() {
  return <UsersManagementPanel />;
}

export function OutboxPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-outbox'],
    queryFn: () =>
      apiClient<any>('/operations/outbox').catch(() => ({ data: [] })),
    refetchInterval: 10000,
    staleTime: 5_000,
  });
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const events: any[] = data?.data ?? [];

  // Re-drive a stuck event. Backend resets it to PENDING so the outbox poller
  // picks it up on its next 5s tick. Offered for FAILED/DEAD rows — the whole
  // point of an ops queue view is being able to re-run stuck side effects.
  const retry = async (id: string) => {
    setRetryingId(id);
    try {
      await apiClient(`/operations/outbox/${id}/retry`, { method: 'POST' });
      toast.success('Event requeued');
      refetch();
    } catch (err: any) {
      toast.error(err?.message ?? 'Retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  const statusColor: Record<string, string> = {
    PENDING: 'bg-yellow-100 text-yellow-700',
    PROCESSING: 'bg-blue-100 text-blue-700',
    DONE: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-700',
    // FIX (platform audit finding 2026-08-14, follow-up): the real exhausted-
    // retries status outbox.ts writes is "DEAD_LETTER", not "DEAD" — this
    // key (and the Retry-button check below) never matched a real event.
    DEAD_LETTER: 'bg-surface-raised text-text-muted',
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() => refetch()}
          className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
      {isLoading ? (
        <div className="py-8 text-center">
          <Cpu className="h-6 w-6 animate-pulse text-indigo-600 mx-auto" />
        </div>
      ) : events.length === 0 ? (
        <div className="py-8 text-center text-text-muted text-sm flex flex-col items-center gap-2">
          <CheckCircle2 className="h-8 w-8 text-green-400" />
          Outbox queue is clear
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {events.map((evt: any) => (
            <div
              key={evt.id}
              className="flex items-center justify-between p-3 bg-surface-hover rounded-lg border border-border-subtle text-xs"
            >
              <div>
                <span className="font-bold text-text-primary">{evt.type}</span>
                <span className="ml-2 text-text-muted">{evt.channel}</span>
                {typeof evt.attempts === 'number' && (
                  <span className="ml-2 text-text-muted">· {evt.attempts} attempt{evt.attempts === 1 ? '' : 's'}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* FIX (platform audit finding 2026-08-14, follow-up): was
                    ['FAILED', 'DEAD'] — outbox.ts's real terminal status is
                    "DEAD_LETTER" (see the comment above), and DEAD_LETTER
                    events are explicitly excluded from the poller's own
                    automatic-retry claim query, making this button their
                    ONLY recovery path. The mismatch meant it silently never
                    rendered for exactly the events that needed it. */}
                {['FAILED', 'DEAD_LETTER'].includes(evt.status) && (
                  <button
                    onClick={() => retry(evt.id)}
                    disabled={retryingId === evt.id}
                    className="font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${retryingId === evt.id ? 'animate-spin' : ''}`} /> Retry
                  </button>
                )}
                <span
                  className={`font-bold px-2 py-0.5 rounded-full ${statusColor[evt.status] ?? 'bg-surface-raised text-text-muted'}`}
                >
                  {evt.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WebhooksPanel() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ url: '', secret: '' });
  const [adding, setAdding] = useState(false);
  // Editing one subscription: its URL and, optionally, a NEW secret (the stored one is write-only and never shown).
  const [editing, setEditing] = useState<{ id: string; url: string; secret: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => apiClient<{ data: any[] }>('/webhooks'),
  });

  const subs: any[] = data?.data ?? [];

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.url || !form.secret) return;
    try {
      // The tenant is taken from your sign-in on the server, never from the form.
      await apiClient('/webhooks', { method: 'POST', body: JSON.stringify(form) });
      setForm({ url: '', secret: '' });
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err: any) {
      toast.error(`Failed to create webhook: ${err.message}`);
    }
  };

  const patchSub = async (id: string, body: Record<string, unknown>, done: string) => {
    try {
      await apiClient(`/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast.success(done);
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      return true;
    } catch (err: any) {
      toast.error(`Failed to update webhook: ${err.message}`);
      return false;
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this webhook subscription?')) return;
    try {
      await apiClient(`/webhooks/${id}`, { method: 'DELETE' });
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err: any) {
      toast.error(`Failed to delete webhook: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-text-primary">Webhook Subscriptions</h3>
          <p className="text-sm text-text-muted mt-0.5">Outbound HTTP callbacks for document events</p>
        </div>
        <button
          onClick={() => setAdding(!adding)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {adding && (
        <form onSubmit={handleAdd} className="bg-surface-raised rounded-lg p-4 space-y-3 border border-border">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">URL</label>
              <input
                type="url"
                required
                maxLength={2000}
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://example.com/hook"
                className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Secret</label>
              <input
                type="text"
                required
                minLength={16}
                maxLength={255}
                value={form.secret}
                onChange={(e) => setForm({ ...form, secret: e.target.value })}
                placeholder="HMAC signing secret"
                className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
              />
            </div>
          </div>
          <p className="text-xs text-text-muted">The secret must be at least 16 characters. It signs every delivery and is never shown again.</p>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm border border-border rounded text-text-secondary hover:bg-surface-raised">Cancel</button>
            <button type="submit" className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded hover:bg-brand-700">Save</button>
          </div>
        </form>
      )}

      {editing && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await patchSub(editing.id, { url: editing.url, ...(editing.secret ? { secret: editing.secret } : {}) }, 'Webhook updated');
            if (ok) setEditing(null);
          }}
          className="bg-surface-raised rounded-lg p-4 space-y-3 border border-border"
          data-testid="webhook-editor"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">URL</label>
              <input type="url" required maxLength={2000} value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">New secret (leave empty to keep the current one)</label>
              <input type="text" value={editing.secret} minLength={editing.secret ? 16 : undefined} maxLength={255} onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                placeholder="at least 16 characters" className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary" />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm border border-border rounded text-text-secondary hover:bg-surface-raised">Cancel</button>
            <button type="submit" className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded hover:bg-brand-700">Save changes</button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" /></div>
      ) : subs.length === 0 ? (
        <div className="text-center py-10 text-text-muted text-sm">No webhook subscriptions configured.</div>
      ) : (
        <div className="divide-y divide-border">
          {subs.map((sub) => (
            <div key={sub.id} className="py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <Globe className="h-4 w-4 text-text-muted shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{sub.url}</p>
                  <p className="text-xs text-text-muted">{sub.isActive ? 'Active' : 'Paused (receives nothing)'}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => patchSub(sub.id, { isActive: !sub.isActive }, sub.isActive ? 'Webhook paused' : 'Webhook resumed')}
                  className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-raised"
                  title={sub.isActive ? 'Pause: keep the subscription but send nothing' : 'Resume sending'}
                >
                  {sub.isActive ? 'Pause' : 'Resume'}
                </button>
                <button
                  onClick={() => setEditing({ id: sub.id, url: sub.url, secret: '' })}
                  className="px-2 py-1 text-xs border border-border rounded text-text-secondary hover:bg-surface-raised"
                  title="Change the URL or replace the signing secret"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(sub.id)}
                  className="p-1.5 text-text-muted hover:text-red-600 transition-colors rounded"
                  title="Remove"
                  aria-label="Remove webhook"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type CryptoStatus = {
  vaultMode: string;
  currentKekVersion: number;
  totalDeks: number;
  byVersion: Record<string, number>;
  behindCurrentVersion: number;
  unparseableKekId: number;
  rotationUpToDate: boolean;
  rewrapCommand: string;
};

// S15 follow-up: rewrap-deks.ts (KEK rotation) was CLI-only with no way to see
// whether a rotation was even needed without shelling into the box and
// querying document_deks by hand. Backed by the read-only
// GET /operations/crypto-status endpoint (operations.routes.ts).
export function CryptoStatusPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['crypto-status'],
    queryFn: () => apiClient<{ data: CryptoStatus }>('/operations/crypto-status'),
    staleTime: 30_000,
  });

  const status = data?.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Encryption key-encryption-key (KEK) rotation status for document data-encryption keys (DEKs).
        </p>
        <button
          onClick={() => refetch()}
          className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {isLoading || !status ? (
        <div className="py-8 text-center">
          <KeyRound className="h-6 w-6 animate-pulse text-indigo-600 mx-auto" />
        </div>
      ) : (
        <>
          <div
            className={`rounded-xl border p-4 flex items-start gap-3 ${
              status.rotationUpToDate ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
            }`}
          >
            {status.rotationUpToDate ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            )}
            <div>
              <p className={`text-sm font-bold ${status.rotationUpToDate ? 'text-green-800' : 'text-amber-800'}`}>
                {status.rotationUpToDate
                  ? 'All DEKs are wrapped under the current KEK version'
                  : `${status.behindCurrentVersion} DEK(s) still wrapped under an older KEK version`}
              </p>
              <p className="text-xs text-text-muted mt-1">
                Vault mode: <span className="font-mono">{status.vaultMode}</span> · Current KEK version:{' '}
                <span className="font-mono">v{status.currentKekVersion}</span>
              </p>
              {!status.rotationUpToDate && (
                <p className="text-xs text-text-muted mt-1">
                  Run <code className="font-mono bg-surface-raised px-1 py-0.5 rounded">{status.rewrapCommand}</code> to
                  re-wrap outdated DEKs onto the current version.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="bg-surface-hover rounded-lg border border-border-subtle p-3 text-center">
              <p className="text-xl font-bold text-text-primary">{status.totalDeks}</p>
              <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mt-1">Total DEKs</p>
            </div>
            {Object.entries(status.byVersion)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([version, count]) => (
                <div
                  key={version}
                  className={`rounded-lg border p-3 text-center ${
                    Number(version) < status.currentKekVersion
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-surface-hover border-border-subtle'
                  }`}
                >
                  <p className="text-xl font-bold text-text-primary">{count}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mt-1">KEK v{version}</p>
                </div>
              ))}
            {status.unparseableKekId > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
                <p className="text-xl font-bold text-red-700">{status.unparseableKekId}</p>
                <p className="text-[10px] font-bold uppercase tracking-wide text-red-600 mt-1">Unrecognized</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Feature Flags (per-tenant operational switches) ─────────────────────────
// Backed by GET/PATCH /tenants/:tenantId/feature-flags (requires tenant:manage).
// The important one is `ai_processing`: the AI consent gate. Until it's on for a
// tenant, the chat/summarize/extract routes 403 and the AIWorker skips — so
// without this surface the gate could only be lifted by a raw API call, reading
// to users as "AI is broken" (S19 handoff Tier-2). Defaults to the current
// tenant; a multi-tenant admin can point it at another tenant they manage.
const KNOWN_FLAGS: { key: string; label: string; desc: string }[] = [
  {
    key: 'ai_processing',
    label: 'AI processing (consent gate)',
    desc: 'Allow document text to be sent to the AI provider for chat / summarize / extract. Off by default.',
  },
];

export function FeatureFlagsPanel() {
  const { tenantId: currentTenant } = useAuthStore();
  const [tenantId, setTenantId] = useState(currentTenant ?? '');
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['feature-flags', tenantId],
    queryFn: () => apiClient<{ data: Record<string, boolean> }>(`/tenants/${tenantId}/feature-flags`),
    enabled: !!tenantId,
  });

  const flags = data?.data ?? {};

  const { mutate: setFlag, isPending } = useMutation({
    mutationFn: (vars: { flag: string; enabled: boolean }) =>
      apiClient<{ data: Record<string, boolean> }>(`/tenants/${tenantId}/feature-flags`, {
        method: 'PATCH',
        body: JSON.stringify(vars),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['feature-flags', tenantId], updated);
      toast.success('Feature flag updated');
    },
    onError: (err: any) => toast.error(`Failed to update flag: ${err.message}`),
  });

  // Any flags set on the tenant that aren't in KNOWN_FLAGS still get a row so an
  // admin can see/toggle them rather than being invisible.
  const extraFlags = Object.keys(flags).filter((k) => !KNOWN_FLAGS.some((f) => f.key === k));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-text-primary">Feature Flags</h3>
        <p className="text-sm text-text-muted mt-0.5">Per-tenant operational switches. Changes are audit-logged.</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Tenant</label>
        <input
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value.trim())}
          placeholder="examplecorp"
          className="w-full max-w-xs px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
        />
      </div>

      {!tenantId ? (
        <p className="text-sm text-text-muted">Enter a tenant id to view its flags.</p>
      ) : isLoading ? (
        <div className="ui-skeleton h-12 rounded-xl" />
      ) : isError ? (
        <p className="text-sm text-red-600">Could not load flags for “{tenantId}”. Check the tenant id and your permissions.</p>
      ) : (
        <div className="space-y-3">
          {[...KNOWN_FLAGS, ...extraFlags.map((k) => ({ key: k, label: k, desc: 'Custom flag' }))].map(
            ({ key, label, desc }) => {
              const on = flags[key] === true;
              return (
                <div key={key} className="flex items-start justify-between gap-4 border border-border rounded-lg p-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{label}</p>
                    <p className="text-xs text-text-muted">{desc}</p>
                  </div>
                  <button
                    onClick={() => setFlag({ flag: key, enabled: !on })}
                    disabled={isPending}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
                      on ? 'bg-brand-600' : 'bg-border',
                    )}
                    aria-label={`Toggle ${label}`}
                  >
                    <span
                      className={cn(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5',
                        on ? 'translate-x-4 ml-0.5' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                </div>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}

// ─── OCR/AI Pipeline Observability ────────────────────────────────────────
// Backed by GET /operations/pipeline-metrics, which reads the prom-client
// counters/histograms wired up in OCRWorker.ts/AIWorker.ts/outbox.ts. Exists
// because clicking "Summarize" used to just say "queued" forever with zero
// visibility into whether jobs were completing, being skipped (no OCR text /
// tenant hasn't enabled AI), or failing outright — the only way to tell was
// grepping pino log lines on the box.
// ocr/ai come from a Redis-backed cross-process store (the OCR/AI workers run
// in a separate OS process from this API) — `available: false` means the
// store itself couldn't be reached, which is a materially different problem
// from "no jobs have run yet" and must be shown differently, not as zeros.
type PipelineMetrics = {
  ocr:
    | ({ available: true; completed?: number; low_confidence?: number; unsupported?: number; failed?: number; avgDurationSeconds: number | null })
    | { available: false; reason: string };
  ai:
    | ({ available: true } & Record<string, { completed?: number; skipped_insufficient_text?: number; skipped_no_consent?: number; failed?: number; avgDurationSeconds: number | null } | boolean>)
    | { available: false; reason: string };
  outbox: Record<string, Record<string, number>>;
};

const OCR_OUTCOME_LABELS: Record<string, string> = {
  completed: 'Completed',
  low_confidence: 'Low confidence',
  unsupported: 'Unsupported file type',
  failed: 'Failed',
};

const AI_OUTCOME_LABELS: Record<string, string> = {
  completed: 'Completed',
  skipped_insufficient_text: 'Skipped — no OCR text',
  skipped_no_consent: 'Skipped — AI not enabled',
  skipped_policy: 'Skipped — blocked by AI Controls',
  skipped_no_provider: 'Skipped — no AI provider configured',
  failed: 'Failed',
};

const AI_OPERATION_LABELS: Record<string, string> = {
  AI_SUMMARIZE: 'Summarize',
  AI_EXTRACT_METADATA: 'Extract metadata',
};

function StatTile({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'warning' | 'danger' | 'success' }) {
  const toneClass =
    tone === 'danger'
      ? 'text-red-600'
      : tone === 'warning'
        ? 'text-amber-600'
        : tone === 'success'
          ? 'text-green-600'
          : 'text-text-primary';
  return (
    <div className="bg-surface-hover rounded-lg border border-border-subtle p-3 text-center">
      <p className={`text-xl font-bold ${toneClass}`}>{value}</p>
      <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted mt-1">{label}</p>
    </div>
  );
}

// Honest failure state — a metrics store that's down or unconfigured must
// never render as if the pipeline has processed zero jobs. Those are two
// different, equally real problems and the operator needs to know which one
// they're looking at.
function MetricsUnavailableNotice({ reason }: { reason: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-bold">Metrics unavailable</span> — {reason}. Job counts above cannot be
        shown accurately right now; this is not the same as zero jobs having run.
      </span>
    </div>
  );
}

export function PipelinePanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['pipeline-metrics'],
    queryFn: () => apiClient<{ data: PipelineMetrics }>('/operations/pipeline-metrics'),
    refetchInterval: 15000,
    staleTime: 10_000,
  });

  const metrics = data?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Job counts and average duration for background OCR and AI document processing — process-level metrics
          (Prometheus counters/histograms), not per-document logs.
        </p>
        <button
          onClick={() => refetch()}
          className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {isLoading || !metrics ? (
        <div className="py-8 text-center">
          <Cpu className="h-6 w-6 animate-pulse text-indigo-600 mx-auto" />
        </div>
      ) : (
        <>
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-3">
              <ScanText className="h-4 w-4 text-indigo-600" /> OCR jobs
              {metrics.ocr.available && metrics.ocr.avgDurationSeconds != null && (
                <span className="text-xs font-normal text-text-muted">
                  · avg {metrics.ocr.avgDurationSeconds.toFixed(1)}s
                </span>
              )}
            </h3>
            {metrics.ocr.available ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Object.entries(OCR_OUTCOME_LABELS).map(([outcome, label]) => (
                  <StatTile
                    key={outcome}
                    label={label}
                    value={(metrics.ocr as unknown as Record<string, number | undefined>)[outcome] ?? 0}
                    tone={outcome === 'failed' ? 'danger' : outcome === 'low_confidence' ? 'warning' : outcome === 'completed' ? 'success' : 'default'}
                  />
                ))}
              </div>
            ) : (
              <MetricsUnavailableNotice reason={metrics.ocr.reason} />
            )}
          </div>

          {metrics.ai.available ? (
            Object.entries(AI_OPERATION_LABELS).map(([operation, opLabel]) => {
              const stats = (metrics.ai as unknown as Record<string, { avgDurationSeconds: number | null } & Record<string, number | undefined>>)[operation];
              return (
                <div key={operation}>
                  <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-3">
                    <Sparkles className="h-4 w-4 text-indigo-600" /> AI — {opLabel}
                    {stats?.avgDurationSeconds != null && (
                      <span className="text-xs font-normal text-text-muted">
                        · avg {stats.avgDurationSeconds.toFixed(1)}s
                      </span>
                    )}
                  </h3>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {Object.entries(AI_OUTCOME_LABELS).map(([outcome, label]) => (
                      <StatTile
                        key={outcome}
                        label={label}
                        value={stats?.[outcome] ?? 0}
                        tone={outcome === 'failed' ? 'danger' : outcome.startsWith('skipped') ? 'warning' : outcome === 'completed' ? 'success' : 'default'}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-3">
                <Sparkles className="h-4 w-4 text-indigo-600" /> AI jobs
              </h3>
              <MetricsUnavailableNotice reason={metrics.ai.reason} />
            </div>
          )}

          <div>
            <h3 className="text-sm font-bold text-text-primary mb-3">Outbox dispatch (all channels)</h3>
            {Object.keys(metrics.outbox).length === 0 ? (
              <p className="text-sm text-text-muted">No outbox events processed yet.</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(metrics.outbox).map(([channel, outcomes]) => (
                  <div key={channel} className="flex items-center justify-between p-2.5 bg-surface-hover rounded-lg border border-border-subtle text-xs">
                    <span className="font-bold text-text-primary">{channel}</span>
                    <div className="flex gap-3">
                      {Object.entries(outcomes).map(([outcome, count]) => (
                        <span
                          key={outcome}
                          className={outcome === 'dead_letter' || outcome === 'failed' ? 'text-red-600 font-bold' : 'text-text-muted'}
                        >
                          {outcome}: {count}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type AntivirusStatus = {
  scanner: {
    enabled: boolean;
    reachable: boolean;
    host: string;
    port: number;
    cooldownActive: boolean;
    version: string | null;
    engineVersion: string | null;
    signatureVersion: string | null;
    signatureDate: string | null;
    checkedAt: string;
  };
  coverage: {
    totalVersions: number;
    scanned: number;
    unscanned: number;
    byStatus: Record<string, number>;
    scannedPercent: number | null;
  };
};

// Whether uploads are actually being virus-scanned had no representation
// anywhere in the product before 2026-09-09 -- it existed only as a line in
// the boot log. That matters more here than it would elsewhere because the
// scan policy is fail-OPEN: a file that cannot be scanned is still accepted
// and stored, stamped `unscanned`. So a clamd that is down looks exactly like
// one that is working from every other screen. Backed by
// GET /operations/antivirus.
export function AntivirusPanel() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['antivirus-status'],
    queryFn: () => apiClient<{ data: AntivirusStatus }>('/operations/antivirus'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const status = data?.data;
  const scanner = status?.scanner;
  const coverage = status?.coverage;

  // Three distinct states, not two. "Disabled" is a deployment decision;
  // "enabled but unreachable" is a fault that is silently degrading every
  // upload. Collapsing them into one red banner would hide which is which.
  const state: 'ok' | 'unreachable' | 'disabled' | 'unknown' = !scanner
    ? 'unknown'
    : !scanner.enabled
      ? 'disabled'
      : scanner.reachable
        ? 'ok'
        : 'unreachable';

  const banner = {
    ok: {
      cls: 'bg-green-50 border-green-200',
      text: 'text-green-800',
      icon: <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />,
      title: 'ClamAV is running — uploads are being scanned',
    },
    unreachable: {
      cls: 'bg-red-50 border-red-200',
      text: 'text-red-800',
      icon: <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />,
      title: 'ClamAV is enabled but NOT reachable — uploads are being accepted unscanned',
    },
    disabled: {
      cls: 'bg-amber-50 border-amber-200',
      text: 'text-amber-800',
      icon: <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />,
      title: 'Virus scanning is switched off — nothing uploaded is being checked',
    },
    unknown: {
      cls: 'bg-surface-2 border-border',
      text: 'text-text-muted',
      icon: <Server className="h-5 w-5 text-text-muted shrink-0 mt-0.5" />,
      title: 'Checking scanner status…',
    },
  }[state];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Live antivirus daemon status and how much of what is already stored was genuinely scanned.
        </p>
        <button
          onClick={() => refetch()}
          className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 shrink-0"
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>

      {isLoading || !status ? (
        <div className="py-8 text-center">
          <Server className="h-6 w-6 animate-pulse text-indigo-600 mx-auto" />
        </div>
      ) : (
        <>
          <div className={cn('rounded-xl border p-4 flex items-start gap-3', banner.cls)}>
            {banner.icon}
            <div className="min-w-0">
              <p className={cn('text-sm font-bold', banner.text)}>{banner.title}</p>
              <p className="text-xs text-text-muted mt-1 break-words">
                <span className="font-mono">
                  {scanner!.host}:{scanner!.port}
                </span>
                {scanner!.engineVersion && <> · engine <span className="font-mono">{scanner!.engineVersion}</span></>}
                {scanner!.signatureVersion && <> · signatures <span className="font-mono">#{scanner!.signatureVersion}</span></>}
              </p>
              {scanner!.signatureDate && (
                <p className="text-xs text-text-muted mt-0.5">
                  Signature database built <span className="font-mono">{scanner!.signatureDate}</span>
                </p>
              )}
              {scanner!.cooldownActive && (
                <p className="text-xs text-amber-700 mt-1">
                  A scan recently failed, so the scanner is in its 60-second back-off. Uploads during this
                  window are recorded as not scanned.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">Stored file versions</p>
              <p className="text-2xl font-bold">{coverage!.totalVersions}</p>
            </div>
            <div className="rounded-xl border border-border p-4">
              <p className="text-xs text-text-muted">Scanned clean</p>
              <p className="text-2xl font-bold text-green-700">{coverage!.scanned}</p>
            </div>
            <div
              className={cn(
                'rounded-xl border p-4',
                coverage!.unscanned > 0 ? 'border-amber-300 bg-amber-50' : 'border-border',
              )}
            >
              <p className="text-xs text-text-muted">Never scanned</p>
              <p className={cn('text-2xl font-bold', coverage!.unscanned > 0 ? 'text-amber-700' : '')}>
                {coverage!.unscanned}
              </p>
            </div>
          </div>

          {coverage!.scannedPercent !== null && (
            <div>
              <div className="flex items-center justify-between text-xs text-text-muted mb-1">
                <span>Scan coverage</span>
                <span className="font-mono">{coverage!.scannedPercent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
                <div
                  className={cn('h-full rounded-full', coverage!.scannedPercent === 100 ? 'bg-green-500' : 'bg-amber-500')}
                  style={{ width: `${coverage!.scannedPercent}%` }}
                />
              </div>
            </div>
          )}

          <p className="text-xs text-text-muted">
            A file that cannot be scanned is still accepted and stored, marked{' '}
            <span className="font-semibold">not scanned</span>, rather than blocking the upload. An infected
            file is always rejected outright. Last checked{' '}
            <span className="font-mono">{new Date(scanner!.checkedAt).toLocaleTimeString()}</span>.
          </p>
        </>
      )}
    </div>
  );
}

interface SystemErrorRecord {
  fingerprint: string;
  method: string;
  route: string;
  errorName: string;
  errorMessage: string;
  requestId: string;
  tenantId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  lastAlertedAt: string | null;
}

interface AlertingStatus {
  slackConfigured: boolean;
  emailConfigured: boolean;
  throttleMs: number;
}

// The whole point of this panel: the ERR-INTERNAL response text ("The team
// has been notified") used to be backed by nothing but a local log line.
// infrastructure/alerting/adminAlerts.ts now actually posts to Slack/email on
// every unhandled 500 (deduped per route+error for ADMIN_ALERT_THROTTLE_MS),
// and this panel is how an admin verifies that from the product instead of
// trusting the copy — see which channels are configured, fire a real test
// alert on demand, and see every distinct fault DMS has hit since the process
// started, including ones a throttle window may have suppressed from Slack/
// email but never hides here.
export function SystemErrorsPanel() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['system-errors'],
    queryFn: () => apiClient<{ data: SystemErrorRecord[]; alerting: AlertingStatus }>('/operations/system-errors'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const [sendingTest, setSendingTest] = useState(false);
  const [clearing, setClearing] = useState(false);

  const errors = data?.data ?? [];
  const alerting = data?.alerting;
  const noChannelsConfigured = alerting && !alerting.slackConfigured && !alerting.emailConfigured;

  const sendTest = async () => {
    setSendingTest(true);
    try {
      const result = await apiClient<{ success: boolean; slackAttempted: boolean; emailAttempted: boolean }>(
        '/operations/system-errors/test-alert',
        { method: 'POST' },
      );
      if (!result.slackAttempted && !result.emailAttempted) {
        toast.error('No alert channel is configured — set ADMIN_ALERT_WEBHOOK_URL and/or ADMIN_ALERT_EMAIL_TO');
      } else {
        const via = [result.slackAttempted && 'Slack', result.emailAttempted && 'email'].filter(Boolean).join(' + ');
        toast.success(`Test alert sent via ${via}. Check the destination to confirm it arrived.`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to send test alert');
    } finally {
      setSendingTest(false);
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await apiClient('/operations/system-errors/clear', { method: 'POST' });
      toast.success('Cleared');
      refetch();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to clear');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-text-muted">
          Every unhandled 500 DMS has hit since this process started, and whether it actually paged anyone.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={sendTest}
            disabled={sendingTest}
            className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 disabled:opacity-50"
          >
            <Send className={cn('h-3 w-3', sendingTest && 'animate-pulse')} /> Send test alert
          </button>
          <button
            onClick={clearAll}
            disabled={clearing || errors.length === 0}
            className="text-xs font-bold text-text-muted hover:text-text-primary flex items-center gap-1 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </button>
          <button
            onClick={() => refetch()}
            className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
          >
            <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {alerting && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div
            className={cn(
              'rounded-xl border p-3 flex items-center gap-2',
              alerting.slackConfigured ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            {alerting.slackConfigured ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-bold text-text-primary">Slack</p>
              <p className="text-[11px] text-text-muted">{alerting.slackConfigured ? 'Configured' : 'Not configured'}</p>
            </div>
          </div>
          <div
            className={cn(
              'rounded-xl border p-3 flex items-center gap-2',
              alerting.emailConfigured ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            {alerting.emailConfigured ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-bold text-text-primary">Email</p>
              <p className="text-[11px] text-text-muted">{alerting.emailConfigured ? 'Configured' : 'Not configured'}</p>
            </div>
          </div>
          <div className="rounded-xl border border-border p-3 flex items-center gap-2">
            <Server className="h-4 w-4 text-text-muted shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-text-primary">Repeat throttle</p>
              <p className="text-[11px] text-text-muted">1 alert / {Math.round(alerting.throttleMs / 60000)}m per error</p>
            </div>
          </div>
        </div>
      )}

      {noChannelsConfigured && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            No alert channel is configured. Unhandled errors are still tracked below, but nobody is being
            paged — set <span className="font-mono">ADMIN_ALERT_WEBHOOK_URL</span> and/or{' '}
            <span className="font-mono">ADMIN_ALERT_EMAIL_TO</span> in this environment&apos;s env file.
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center">
          <Cpu className="h-6 w-6 animate-pulse text-indigo-600 mx-auto" />
        </div>
      ) : errors.length === 0 ? (
        <div className="py-8 text-center text-text-muted text-sm flex flex-col items-center gap-2">
          <CheckCircle2 className="h-8 w-8 text-green-400" />
          No unhandled errors since this process started
        </div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {errors.map((err) => (
            <div key={err.fingerprint} className="p-3 bg-surface-hover rounded-lg border border-border-subtle text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="font-mono font-bold text-text-primary">{err.method}</span>
                  <span className="font-mono text-text-muted truncate">{err.route}</span>
                </div>
                <span className="font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 shrink-0">
                  {err.count} occurrence{err.count === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-text-primary font-semibold">{err.errorName}</p>
              <p className="text-text-muted break-words">{err.errorMessage}</p>
              <div className="flex items-center gap-3 text-[11px] text-text-muted pt-1 flex-wrap">
                <span>First seen {new Date(err.firstSeenAt).toLocaleString()}</span>
                <span>Last seen {new Date(err.lastSeenAt).toLocaleString()}</span>
                {err.tenantId && <span>Tenant {err.tenantId}</span>}
                <span className="font-mono">req {err.requestId}</span>
                {err.lastAlertedAt ? (
                  <span className="inline-flex items-center gap-1 text-green-700">
                    <CheckCircle2 className="h-3 w-3" /> Alerted {new Date(err.lastAlertedAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <BellOff className="h-3 w-3" /> Not alerted (no channel configured)
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
