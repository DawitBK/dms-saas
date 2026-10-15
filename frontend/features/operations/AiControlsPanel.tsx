'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { apiClient } from '../../shared/lib/apiClient';
import { useAuthStore } from '../../state/auth.store';
import { cn } from '../../shared/lib/cn';
import { useResetOnChange } from '../../shared/hooks/useResetOnChange';
import type { Classification } from '../../shared/lib/classification';

type Confidentiality = Classification;

type AiPolicy = {
  features: { chat: boolean; summarize: boolean; extract: boolean; form_extraction: boolean };
  autoProcessOnUpload: boolean;
  maxConfidentiality: Confidentiality;
  blockedDocumentTypeIds: string[];
  blockedDepartmentIds: string[];
  userLimitPer24h: number | null;
  tenantLimitPer24h: number | null;
};

type PolicyResponse = { data: { enabled: boolean; policy: AiPolicy } };

type UsageSummary = {
  windowHours: number;
  totals: { allowed: number; denied: number; completed: number; failed: number; inputTokens: number; outputTokens: number };
  byFeature: { feature: string; allowed: number; denied: number }[];
  byUser: { userId: string | null; email: string | null; name: string | null; allowed: number; denied: number; inputTokens: number; outputTokens: number }[];
  recent: { id: string; createdAt: string; userId: string | null; email: string | null; feature: string; trigger: string; documentId: string | null; outcome: string; reason: string | null }[];
  yourUsage: { allowedLast24h: number; limit: number | null };
  tenantUsage: { allowedLast24h: number; limit: number | null };
};

type Named = { id: string; name: string; code?: string };

const FEATURE_LABELS: Record<keyof AiPolicy['features'], { label: string; desc: string }> = {
  chat: { label: 'Compliance assistant', desc: 'Chat over the audit trail and documents (people with the AI chat permission).' },
  summarize: { label: 'Document summaries', desc: 'Short summaries on the document page, on request and after upload.' },
  extract: { label: 'Metadata suggestions', desc: 'Suggested classification, keywords and dates for a document.' },
  form_extraction: { label: 'Build a form from a photo', desc: 'Reads an image or PDF of a paper form and proposes its fields.' },
};

const CONFIDENTIALITY: { value: Confidentiality; label: string }[] = [
  { value: 'PUBLIC', label: 'Public only' },
  { value: 'INTERNAL', label: 'Up to Internal (recommended)' },
  { value: 'CONFIDENTIAL', label: 'Up to Confidential' },
  { value: 'RESTRICTED', label: 'Everything, including Restricted' },
];

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-brand-600' : 'bg-border')}
    >
      <span className={cn('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5', on ? 'translate-x-4 ml-0.5' : 'translate-x-0.5')} />
    </button>
  );
}

function limitToInput(v: number | null): string {
  return v === null ? '' : String(v);
}
function inputToLimit(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null;
}

export function AiControlsPanel() {
  const { tenantId } = useAuthStore();
  const qc = useQueryClient();

  const policyQ = useQuery({ queryKey: ['ai-policy'], queryFn: () => apiClient<PolicyResponse>('/ai/policy') });
  const usageQ = useQuery({ queryKey: ['ai-usage'], queryFn: () => apiClient<{ data: UsageSummary }>('/ai/usage?hours=168'), refetchInterval: 60_000 });
  const typesQ = useQuery({ queryKey: ['ai-doctypes'], queryFn: () => apiClient<{ data: Named[] }>('/document-types') });
  const deptsQ = useQuery({ queryKey: ['ai-depts'], queryFn: () => apiClient<{ data: Named[] }>('/departments') });

  const stored = policyQ.data?.data.policy;
  const [draft, setDraft] = useState<AiPolicy | null>(null);
  // Adopt the server copy whenever it changes (first load, or after a save).
  useResetOnChange([stored], () => setDraft(stored ?? null));

  const consentOn = policyQ.data?.data.enabled === true;

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(stored), [draft, stored]);

  const save = useMutation({
    mutationFn: (p: AiPolicy) => apiClient<PolicyResponse>('/ai/policy', { method: 'PUT', body: JSON.stringify(p) }),
    onSuccess: (res) => {
      qc.setQueryData(['ai-policy'], res);
      toast.success('AI policy saved');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save the AI policy'),
  });

  const consent = useMutation({
    mutationFn: (enabled: boolean) =>
      apiClient(`/tenants/${tenantId}/feature-flags`, { method: 'PATCH', body: JSON.stringify({ flag: 'ai_processing', enabled }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-policy'] });
      toast.success('Master switch updated');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not change the master switch (needs tenant management rights)'),
  });

  if (policyQ.isLoading || !draft) return <div className="ui-skeleton h-40 rounded-xl" />;
  if (policyQ.isError) return <p className="text-sm text-red-600">Could not load the AI policy. You need the AI management permission.</p>;

  const set = (patch: Partial<AiPolicy>) => setDraft({ ...draft, ...patch });
  const toggleId = (key: 'blockedDocumentTypeIds' | 'blockedDepartmentIds', id: string) => {
    const cur = draft[key];
    set({ [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } as Partial<AiPolicy>);
  };
  const usage = usageQ.data?.data;

  return (
    <div className="space-y-8">
      <div>
        <h3 className="font-semibold text-text-primary">AI Controls</h3>
        <p className="text-sm text-text-muted mt-0.5">
          Decide what may be sent to the AI provider, for whom and how often. Every change is audit-logged; every AI request, allowed or refused, is recorded below.
        </p>
      </div>

      {/* Master switch */}
      <section className="border border-border rounded-xl p-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-text-primary">AI for this organisation</p>
          <p className="text-xs text-text-muted">
            The master switch. Off by default: while it is off nothing leaves the building, whatever else is set here.
          </p>
        </div>
        <Toggle on={consentOn} disabled={consent.isPending} onChange={(v) => consent.mutate(v)} label="AI for this organisation" />
      </section>

      {/* Features */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">What is allowed</h4>
        {(Object.keys(FEATURE_LABELS) as (keyof AiPolicy['features'])[]).map((k) => (
          <div key={k} className="flex items-start justify-between gap-4 border border-border rounded-lg p-3">
            <div>
              <p className="text-sm font-medium text-text-primary">{FEATURE_LABELS[k].label}</p>
              <p className="text-xs text-text-muted">{FEATURE_LABELS[k].desc}</p>
            </div>
            <Toggle on={draft.features[k]} onChange={(v) => set({ features: { ...draft.features, [k]: v } })} label={FEATURE_LABELS[k].label} />
          </div>
        ))}
        <div className="flex items-start justify-between gap-4 border border-border rounded-lg p-3">
          <div>
            <p className="text-sm font-medium text-text-primary">Process uploads automatically</p>
            <p className="text-xs text-text-muted">After a document is read (OCR), summarise it and suggest metadata without anyone asking. Turn off to make AI strictly on request.</p>
          </div>
          <Toggle on={draft.autoProcessOnUpload} onChange={(v) => set({ autoProcessOnUpload: v })} label="Process uploads automatically" />
        </div>
      </section>

      {/* Content rules */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">What may be sent</h4>
        <div className="border border-border rounded-lg p-3 space-y-2">
          <label className="block text-xs font-medium text-text-secondary" htmlFor="ai-maxconf">Most confidential document class allowed</label>
          <select
            id="ai-maxconf"
            value={draft.maxConfidentiality}
            onChange={(e) => set({ maxConfidentiality: e.target.value as Confidentiality })}
            className="w-full max-w-sm px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
          >
            {CONFIDENTIALITY.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <p className="text-xs text-text-muted">A document above this class is never sent, even by someone who may use AI and may read the document.</p>
        </div>

        {([
          { key: 'blockedDocumentTypeIds' as const, title: 'Blocked document types', items: typesQ.data?.data ?? [] },
          { key: 'blockedDepartmentIds' as const, title: 'Blocked departments', items: deptsQ.data?.data ?? [] },
        ]).map(({ key, title, items }) => (
          <div key={key} className="border border-border rounded-lg p-3">
            <p className="text-xs font-medium text-text-secondary mb-2">{title} <span className="text-text-muted">({draft[key].length} blocked)</span></p>
            {items.length === 0 ? (
              <p className="text-xs text-text-muted">None to choose from.</p>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto ui-scrollbar">
                {items.map((it) => {
                  const on = draft[key].includes(it.id);
                  return (
                    <button
                      key={it.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleId(key, it.id)}
                      className={cn('px-2.5 py-1 rounded-full text-xs border transition-colors', on ? 'bg-red-500/10 border-red-500/40 text-red-600' : 'border-border text-text-secondary hover:bg-surface-raised')}
                    >
                      {on ? '⛔ ' : ''}{it.name}{it.code ? ` (${it.code})` : ''}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </section>

      {/* Limits */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">How often</h4>
        <p className="text-xs text-text-muted">Counted over any rolling 24 hours. Leave empty for no limit. Refused requests do not use up an allowance.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block border border-border rounded-lg p-3">
            <span className="block text-xs font-medium text-text-secondary mb-1">Per person</span>
            <input
              inputMode="numeric"
              value={limitToInput(draft.userLimitPer24h)}
              onChange={(e) => set({ userLimitPer24h: inputToLimit(e.target.value) })}
              placeholder="no limit"
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
            />
          </label>
          <label className="block border border-border rounded-lg p-3">
            <span className="block text-xs font-medium text-text-secondary mb-1">Whole organisation</span>
            <input
              inputMode="numeric"
              value={limitToInput(draft.tenantLimitPer24h)}
              onChange={(e) => set({ tenantLimitPer24h: inputToLimit(e.target.value) })}
              placeholder="no limit"
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface-card text-text-primary"
            />
          </label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button className="ui-btn ui-btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Saving…' : 'Save policy'}
        </button>
        <button className="ui-btn ui-btn-secondary" disabled={!dirty || save.isPending} onClick={() => setDraft(stored ?? null)}>Discard changes</button>
        {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
      </div>

      <p className="text-xs text-text-muted">
        Who may use AI at all is a permission: <code>ai:use</code> (summaries, suggestions, forms), <code>ai:chat</code> (assistant) and <code>ai:manage</code> (this screen).
        Grant or take them away per role in the Role Editor, or per person from the user&apos;s page.
      </p>

      {/* Usage */}
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary">Usage, last 7 days</h4>
        {!usage ? (
          <div className="ui-skeleton h-24 rounded-xl" />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Allowed', usage.totals.allowed],
                ['Refused', usage.totals.denied],
                ['Tokens in', usage.totals.inputTokens.toLocaleString()],
                ['Tokens out', usage.totals.outputTokens.toLocaleString()],
              ].map(([k, v]) => (
                <div key={String(k)} className="border border-border rounded-lg p-3">
                  <p className="text-xs text-text-muted">{k}</p>
                  <p className="text-xl font-bold text-text-primary">{v}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              Organisation, last 24 hours: {usage.tenantUsage.allowedLast24h}{usage.tenantUsage.limit ? ` of ${usage.tenantUsage.limit}` : ''}.
              You: {usage.yourUsage.allowedLast24h}{usage.yourUsage.limit ? ` of ${usage.yourUsage.limit}` : ''}.
            </p>

            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-text-secondary text-xs">
                  <tr><th className="text-left p-2">Person</th><th className="text-right p-2">Allowed</th><th className="text-right p-2">Refused</th><th className="text-right p-2">Tokens (in / out)</th></tr>
                </thead>
                <tbody>
                  {usage.byUser.length === 0 && <tr><td className="p-3 text-text-muted" colSpan={4}>No AI activity in this period.</td></tr>}
                  {usage.byUser.map((u) => (
                    <tr key={u.userId ?? 'system'} className="border-t border-border">
                      <td className="p-2">{u.name || u.email || (u.userId ? u.userId : 'Automatic (upload pipeline)')}{u.name && u.email ? <span className="text-text-muted"> · {u.email}</span> : null}</td>
                      <td className="p-2 text-right">{u.allowed}</td>
                      <td className="p-2 text-right">{u.denied}</td>
                      <td className="p-2 text-right">{u.inputTokens.toLocaleString()} / {u.outputTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details className="border border-border rounded-lg">
              <summary className="cursor-pointer p-3 text-sm font-medium text-text-primary">Recent requests ({usage.recent.length})</summary>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-surface-raised text-text-secondary">
                    <tr><th className="text-left p-2">When</th><th className="text-left p-2">Who</th><th className="text-left p-2">What</th><th className="text-left p-2">Outcome</th></tr>
                  </thead>
                  <tbody>
                    {usage.recent.map((r) => (
                      <tr key={r.id} className="border-t border-border align-top">
                        <td className="p-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                        <td className="p-2">{r.email ?? (r.trigger === 'auto' ? 'Automatic' : '—')}</td>
                        <td className="p-2">{r.feature.replace('_', ' ')}{r.documentId ? ` · ${r.documentId.slice(0, 8)}` : ''}</td>
                        <td className={cn('p-2', r.outcome.startsWith('denied') ? 'text-red-600' : '')}>{r.outcome.replace(/_/g, ' ')}{r.reason ? ` — ${r.reason}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
