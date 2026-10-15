"use client";

import React, { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Clock, Plus, Edit2, Trash2, Archive, RotateCcw, AlertTriangle } from 'lucide-react';
import { apiClient } from '@/shared/lib/apiClient';
import { PaginationControls } from '@/shared/components/ui/PaginationControls';
import { useResetOnChange } from '../../shared/hooks/useResetOnChange';

const DISPOSAL_PAGE_SIZE = 15;

function DocumentSearch({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [results, setResults] = React.useState<any[]>([]);
  const [open, setOpen] = React.useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Clearing the list when the box is emptied is a render-time adjustment, not
  // a side effect — it is derived purely from `query`, so doing it in an effect
  // meant painting one frame with the previous results still on screen under an
  // empty box. Only the debounced fetch below is a real effect.
  useResetOnChange([query, displayName], () => {
    if (!query || query === displayName) setResults([]);
  });

  React.useEffect(() => {
    if (!query || query === displayName) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiClient<{ data: any[] }>(`/documents?q=${encodeURIComponent(query)}&take=10`);
        setResults(res.data || []);
        setOpen(true);
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [query, displayName]);

  const select = (doc: any) => {
    setDisplayName(doc.title || doc.documentName);
    setQuery(doc.title || doc.documentName);
    setResults([]);
    setOpen(false);
    onChange(doc.id);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); if (!e.target.value) onChange(''); }}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Search document by name or number..."
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        required
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((doc) => (
            <li
              key={doc.id}
              onMouseDown={() => select(doc)}
              className="px-3 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
            >
              <span className="font-medium">{doc.title || doc.documentName}</span>
              {doc.documentNumber && <span className="ml-2 text-gray-500 text-xs">#{doc.documentNumber}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ConsoleTab = 'policies' | 'disposal' | 'cold-restore';

interface RetentionPolicy {
  id: string;
  code: string;
  name: string;
  retentionYears: number | null;
  isPermanent: boolean;
  triggerEvent: string;
  disposalAction: string;
  authority: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const TRIGGER_EVENTS = [
  'DOCUMENT_DATE',
  'TRANSACTION_DATE',
  'CONTRACT_COMPLETION',
  'EMPLOYEE_TERMINATION',
  'AUDIT_COMPLETION',
];
const DISPOSAL_ACTIONS = ['CERTIFIED_DELETION', 'PERMANENT_ARCHIVE', 'REVIEW'];

const emptyPolicyForm = {
  code: '',
  name: '',
  retentionYears: 7 as number | null,
  isPermanent: false,
  triggerEvent: 'DOCUMENT_DATE',
  disposalAction: 'CERTIFIED_DELETION',
  authority: '',
};

interface DisposalDocument {
  id: string;
  documentName: string;
  title: string;
  documentNumber?: string;
  status: string;
  disposalEligibleDate?: string;
}

export function RetentionConsole() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('policies');
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<RetentionPolicy | null>(null);
  const [form, setForm] = useState({ ...emptyPolicyForm });

  // Disposal queue state
  const [disposalDocs, setDisposalDocs] = useState<DisposalDocument[]>([]);
  const [disposalLoading, setDisposalLoading] = useState(false);
  const [disposalPage, setDisposalPage] = useState(1);
  const [disposalTotal, setDisposalTotal] = useState(0);

  // Cold restore state
  const [coldRestoreDocId, setColdRestoreDocId] = useState('');
  const [coldRestoreLoading, setColdRestoreLoading] = useState(false);
  
  // The fetch, with no synchronous setState, so the mount effect below can
  // call it: react-hooks/set-state-in-effect (an error under eslint-config-next
  // 16) does not treat `await` as a boundary, only a real callback — hence the
  // promise chain rather than async/await.
  const fetchPolicies = useCallback(
    () =>
      apiClient<{ data: RetentionPolicy[] }>('/retention')
        .then((response) => setPolicies(response.data || []))
        .catch((error: any) => toast.error(`Failed to load policies: ${error.message}`))
        .finally(() => setLoading(false)),
    [],
  );

  // What the mutation handlers call: same fetch with the spinner raised first.
  const loadPolicies = useCallback(async () => {
    setLoading(true);
    await fetchPolicies();
  }, [fetchPolicies]);

  // Declared AFTER its loader — reading `loadPolicies` before its declaration
  // is what react-hooks/immutability was reporting here, and it is a real
  // staleness trap, not a style preference. `loading` already starts true.
  useEffect(() => {
    void fetchPolicies();
  }, [fetchPolicies]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      retentionYears: form.isPermanent ? null : form.retentionYears,
      isPermanent: form.isPermanent,
      triggerEvent: form.triggerEvent.trim(),
      disposalAction: form.disposalAction.trim(),
      authority: form.authority.trim(),
    };
    try {
      if (editingPolicy) {
        await apiClient(`/retention/${editingPolicy.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        toast.success('Policy updated');
      } else {
        await apiClient('/retention', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        toast.success('Policy created');
      }
      setShowModal(false);
      resetForm();
      loadPolicies();
    } catch (error: any) {
      toast.error(`Failed to save policy: ${error.message}`);
    }
  };

  const policyToForm = (policy: RetentionPolicy) => ({
    code: policy.code,
    name: policy.name,
    retentionYears: policy.retentionYears,
    isPermanent: policy.isPermanent,
    triggerEvent: policy.triggerEvent,
    disposalAction: policy.disposalAction,
    authority: policy.authority,
  });

  const handleEdit = async (policy: RetentionPolicy) => {
    setEditingPolicy(policy);
    setForm(policyToForm(policy));
    setShowModal(true);
    // Refresh from the single-policy endpoint so edits start from current data,
    // not a possibly stale list row.
    try {
      const res = await apiClient<{ data: RetentionPolicy }>(`/retention/${policy.id}`);
      if (res.data) {
        setEditingPolicy(res.data);
        setForm(policyToForm(res.data));
      }
    } catch {
      // fall back to the list-row snapshot already in the form
    }
  };
  
  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to deactivate this retention policy?')) return;
    
    try {
      await apiClient(`/retention/${id}`, { method: 'DELETE' });
      toast.success('Policy deactivated');
      loadPolicies();
    } catch (error: any) {
      toast.error(`Failed to deactivate policy: ${error.message}`);
    }
  };
  
  const resetForm = () => {
    setForm({ ...emptyPolicyForm });
    setEditingPolicy(null);
  };

  const loadDisposalQueue = async (page = disposalPage) => {
    setDisposalLoading(true);
    try {
      const skip = (page - 1) * DISPOSAL_PAGE_SIZE;
      const response = await apiClient<{ data: DisposalDocument[]; total: number }>(
        `/documents?status=DISPOSAL_PENDING&skip=${skip}&take=${DISPOSAL_PAGE_SIZE}`,
      );
      setDisposalDocs(response.data || []);
      setDisposalTotal(response.total ?? response.data?.length ?? 0);
      setDisposalPage(page);
    } catch (error: any) {
      toast.error(`Failed to load disposal queue: ${error.message}`);
    } finally {
      setDisposalLoading(false);
    }
  };

  const handleAuthoriseDisposal = async (documentId: string, documentName: string) => {
    if (!confirm(
      `PERMANENT ACTION: Authorize disposal of "${documentName}"?\n\n` +
      `This will permanently mark the document as DISPOSED and delete all stored versions. ` +
      `This action cannot be undone.`
    )) return;

    try {
      await apiClient(`/retention/disposal/${documentId}/authorise`, { method: 'POST' });
      toast.success('Disposal authorized');
      loadDisposalQueue();
    } catch (error: any) {
      toast.error(`Failed to authorize disposal: ${error.message}`);
    }
  };

  const handleColdRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coldRestoreDocId.trim()) return;
    if (!confirm(`Restore document from cold storage?\n\nDocument ID: ${coldRestoreDocId}\n\nThis will move the document from COLD to WARM storage tier.`)) return;

    setColdRestoreLoading(true);
    try {
      await apiClient(`/retention/cold-restore/${coldRestoreDocId}`, { method: 'POST' });
      toast.success('Document restored from cold storage');
      setColdRestoreDocId('');
    } catch (error: any) {
      toast.error(`Failed to restore from cold storage: ${error.message}`);
    } finally {
      setColdRestoreLoading(false);
    }
  };

  if (loading && activeTab === 'policies') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }
  
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center space-x-2 mb-3">
          <Clock className="h-5 w-5" />
          <span>Retention Management</span>
        </h2>
        <div className="flex space-x-1">
          {([
            { id: 'policies', label: 'Retention Policies' },
            { id: 'disposal', label: 'Disposal Queue' },
            { id: 'cold-restore', label: 'Cold Restore' },
          ] as { id: ConsoleTab; label: string }[]).map(tab => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.id === 'disposal') loadDisposalQueue();
              }}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                activeTab === tab.id
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'policies' && (
      <div className="p-6">
        <div className="flex justify-end mb-4">
          <button
            onClick={() => { resetForm(); setShowModal(true); }}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            <span>New Policy</span>
          </button>
        </div>
        {policies.length === 0 ? (
          <div className="text-center py-12">
            <Archive className="h-12 w-12 text-gray-400 mx-auto mb-3" />
            <p className="text-gray-600 dark:text-gray-400 font-medium">No retention policies found</p>
            <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">
              Create your first retention policy to manage document lifecycles.
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Policy Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Retention</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Trigger</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Disposal</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {policies.map(policy => (
                  <tr key={policy.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3">
                      <span className="px-2 py-1 text-xs font-mono font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                        {policy.code}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{policy.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-xs truncate" title={policy.authority}>
                        {policy.authority}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {policy.isPermanent ? 'Permanent' : `${policy.retentionYears ?? '—'} years`}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{policy.triggerEvent.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{policy.disposalAction.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${
                        policy.isActive
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                      }`}>
                        {policy.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleEdit(policy)}
                          className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                          title="Edit"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(policy.id)}
                          className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                          title="Deactivate"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {activeTab === 'disposal' && (
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Documents awaiting disposal authorization. Only System Admin or Records Officer can authorize disposal.
            </p>
            <button
              onClick={() => loadDisposalQueue()}
              className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400"
            >
              Refresh
            </button>
          </div>
          {disposalLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : disposalDocs.length === 0 ? (
            <div className="text-center py-12">
              <Archive className="h-12 w-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-600 dark:text-gray-400 font-medium">No documents pending disposal</p>
              <p className="text-gray-500 text-sm mt-1">Documents reach this state when their retention period expires.</p>
            </div>
          ) : (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Document</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Number</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Eligible Since</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {disposalDocs.map(doc => (
                    <tr key={doc.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{doc.documentName || doc.title}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{doc.documentNumber || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                        {doc.disposalEligibleDate ? new Date(doc.disposalEligibleDate).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleAuthoriseDisposal(doc.id, doc.documentName || doc.title)}
                          className="flex items-center space-x-1 px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          <span>Authorize Disposal</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {disposalTotal > DISPOSAL_PAGE_SIZE && (
                <div className="border-t border-gray-200 dark:border-gray-700 px-4">
                  <PaginationControls
                    page={disposalPage}
                    onPageChange={(p) => loadDisposalQueue(p)}
                    hasPrevious={disposalPage > 1}
                    hasNext={disposalPage < Math.max(1, Math.ceil(disposalTotal / DISPOSAL_PAGE_SIZE))}
                    totalPages={Math.max(1, Math.ceil(disposalTotal / DISPOSAL_PAGE_SIZE))}
                    isLoading={disposalLoading}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'cold-restore' && (
        <div className="p-6 max-w-lg">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            Restore a document from COLD storage tier back to WARM. Enter the document ID to initiate restore.
          </p>
          <form onSubmit={handleColdRestore} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Document
              </label>
              <DocumentSearch value={coldRestoreDocId} onChange={setColdRestoreDocId} />
            </div>
            <button
              type="submit"
              disabled={coldRestoreLoading || !coldRestoreDocId.trim()}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCcw className="h-4 w-4" />
              <span>{coldRestoreLoading ? 'Restoring...' : 'Restore from Cold Storage'}</span>
            </button>
          </form>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              {editingPolicy ? 'Edit Retention Policy' : 'New Retention Policy'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Code *
                  </label>
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="RET-FIN-7Y"
                    minLength={2}
                    maxLength={50}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Policy Name *
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    required
                  />
                </div>
              </div>

              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Retention Period (Years)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="99"
                    value={form.isPermanent ? '' : form.retentionYears ?? ''}
                    onChange={(e) => setForm({ ...form, retentionYears: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                    disabled={form.isPermanent}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white disabled:opacity-50"
                    required={!form.isPermanent}
                  />
                </div>
                <label className="flex items-center gap-2 pb-2.5 text-sm text-gray-700 dark:text-gray-300 select-none">
                  <input
                    type="checkbox"
                    checked={form.isPermanent}
                    onChange={(e) => setForm({ ...form, isPermanent: e.target.checked, retentionYears: e.target.checked ? null : form.retentionYears ?? 7 })}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Permanent retention
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Trigger Event *
                  </label>
                  <input
                    type="text"
                    list="retention-trigger-events"
                    value={form.triggerEvent}
                    onChange={(e) => setForm({ ...form, triggerEvent: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    required
                  />
                  <datalist id="retention-trigger-events">
                    {TRIGGER_EVENTS.map((t) => <option key={t} value={t} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Disposal Action *
                  </label>
                  <input
                    type="text"
                    list="retention-disposal-actions"
                    value={form.disposalAction}
                    onChange={(e) => setForm({ ...form, disposalAction: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                    required
                  />
                  <datalist id="retention-disposal-actions">
                    {DISPOSAL_ACTIONS.map((d) => <option key={d} value={d} />)}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Authority *
                </label>
                <input
                  type="text"
                  value={form.authority}
                  onChange={(e) => setForm({ ...form, authority: e.target.value })}
                  placeholder="Regulation, standard, or internal governance policy mandating this retention"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  required
                />
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    resetForm();
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {editingPolicy ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
