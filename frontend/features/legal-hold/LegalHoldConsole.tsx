"use client";

import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Shield, Plus, FileText, Download, CheckCircle, XCircle, Eye, History, Loader2 } from 'lucide-react';
import { apiClient, apiClientBlob } from '@/shared/lib/apiClient';
import { DocumentMultiPicker, type PickedDocument } from '@/shared/components/DocumentMultiPicker';
import { PaginationControls } from '@/shared/components/ui/PaginationControls';

interface HoldDocumentLink {
  id: string;
  documentId: string;
  addedAt?: string;
  removedAt?: string | null;
  document?: {
    id: string;
    documentName?: string;
    title?: string;
    documentNumber?: string | null;
    status?: string;
  };
}

interface LegalHold {
  id: string;
  caseReference: string;
  status: string; // backend stores 'ACTIVE' | 'RELEASED'
  custodianName: string;
  legalBasis?: string;
  expectedDuration?: string | null;
  description?: string;
  appliedAt: string;
  releasedAt?: string | null;
  releaseClosureRef?: string | null;
  releaseReason?: string | null;
  appliedBy?: { id: string; firstName: string; lastName: string; email: string };
  affectedDocuments?: HoldDocumentLink[];
}

interface HoldHistoryEntry {
  id: string;
  sequenceNumber: string;
  timestamp: string;
  eventType: string;
  userId: string | null;
  userRole: string | null;
  actionDetails: string;
  isSuccess: boolean;
}

const isActive = (hold: LegalHold) => hold.status?.toUpperCase() === 'ACTIVE';
const activeDocCount = (hold: LegalHold) =>
  (hold.affectedDocuments ?? []).filter((d) => !d.removedAt).length;

function parseDetails(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function LegalHoldConsole() {
  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [holdsPage, setHoldsPage] = useState(1);
  const HOLDS_PAGE_SIZE = 15;
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [showAddDocsModal, setShowAddDocsModal] = useState(false);
  const [selectedHold, setSelectedHold] = useState<LegalHold | null>(null);
  const [saving, setSaving] = useState(false);

  // Detail drawer state
  const [detailHold, setDetailHold] = useState<LegalHold | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'documents' | 'history'>('documents');
  const [history, setHistory] = useState<HoldHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [createForm, setCreateForm] = useState({
    caseReference: '',
    custodianName: '',
    legalBasis: '',
    description: '',
    expectedDuration: '',
  });
  const [createDocs, setCreateDocs] = useState<PickedDocument[]>([]);
  const [releaseForm, setReleaseForm] = useState({ closureRef: '', reason: '' });
  const [addDocs, setAddDocs] = useState<PickedDocument[]>([]);

  // Split so the mount effect can call the fetch without raising the spinner
  // synchronously — react-hooks/set-state-in-effect (an error under
  // eslint-config-next 16) reaches into the callee, and does not treat `await`
  // as a boundary, which is why this is a promise chain. `loading` already
  // starts true, so the mount path needs nothing set.
  const fetchHolds = useCallback(
    () =>
      apiClient<{ data: LegalHold[] }>('/legal-hold')
        .then((response) => setHolds(response.data || []))
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Failed to load legal holds'),
        )
        .finally(() => setLoading(false)),
    [],
  );

  // What the mutation handlers call: same fetch, spinner first.
  const loadHolds = useCallback(async () => {
    setLoading(true);
    await fetchHolds();
  }, [fetchHolds]);

  useEffect(() => {
    void fetchHolds();
  }, [fetchHolds]);

  const resetCreateForm = () => {
    setCreateForm({ caseReference: '', custodianName: '', legalBasis: '', description: '', expectedDuration: '' });
    setCreateDocs([]);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createForm.description.trim().length < 20) {
      toast.error('Description must be at least 20 characters');
      return;
    }
    if (createForm.legalBasis.trim().length < 20) {
      toast.error('Legal basis must be at least 20 characters');
      return;
    }
    setSaving(true);
    try {
      await apiClient('/legal-hold', {
        method: 'POST',
        body: JSON.stringify({
          caseReference: createForm.caseReference.trim(),
          custodianName: createForm.custodianName.trim(),
          legalBasis: createForm.legalBasis.trim(),
          description: createForm.description.trim(),
          expectedDuration: createForm.expectedDuration.trim() || undefined,
          documentIds: createDocs.map((d) => d.id),
        }),
      });
      toast.success('Legal hold created');
      setShowCreateModal(false);
      resetCreateForm();
      loadHolds();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create legal hold');
    } finally {
      setSaving(false);
    }
  };

  const handleRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedHold) return;
    setSaving(true);
    try {
      await apiClient(`/legal-hold/${selectedHold.id}/release`, {
        method: 'POST',
        body: JSON.stringify({ closureRef: releaseForm.closureRef, reason: releaseForm.reason }),
      });
      toast.success('Legal hold released');
      setShowReleaseModal(false);
      setReleaseForm({ closureRef: '', reason: '' });
      setSelectedHold(null);
      loadHolds();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to release legal hold');
    } finally {
      setSaving(false);
    }
  };

  const handleAddDocuments = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedHold || addDocs.length === 0) return;
    setSaving(true);
    try {
      await apiClient(`/legal-hold/${selectedHold.id}/add-documents`, {
        method: 'POST',
        body: JSON.stringify({ documentIds: addDocs.map((d) => d.id) }),
      });
      toast.success(`${addDocs.length} document${addDocs.length > 1 ? 's' : ''} added to hold`);
      setShowAddDocsModal(false);
      setAddDocs([]);
      setSelectedHold(null);
      loadHolds();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add documents');
    } finally {
      setSaving(false);
    }
  };

  const openDetail = async (hold: LegalHold) => {
    setDetailHold(hold);
    setDetailTab('documents');
    setHistory(null);
    setDetailLoading(true);
    try {
      const res = await apiClient<{ data: LegalHold }>(`/legal-hold/${hold.id}`);
      setDetailHold(res.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load hold details');
    } finally {
      setDetailLoading(false);
    }
  };

  const loadHistory = async (holdId: string) => {
    setHistoryLoading(true);
    try {
      const res = await apiClient<{ data: HoldHistoryEntry[] }>(`/legal-hold/${holdId}/history`);
      setHistory(res.data || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load hold history');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleExport = async (format: 'csv' | 'json') => {
    try {
      const blob = await apiClientBlob(`/legal-hold/export?format=${format}`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `legal-hold-export-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="p-6 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center space-x-2">
              <Shield className="h-5 w-5" />
              <span>Legal Hold Management</span>
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Manage legal holds on documents for litigation and compliance
            </p>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => handleExport('csv')}
              className="flex items-center space-x-2 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              title="Export to CSV"
            >
              <Download className="h-4 w-4" />
              <span>CSV</span>
            </button>
            <button
              onClick={() => handleExport('json')}
              className="flex items-center space-x-2 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              title="Export to JSON"
            >
              <Download className="h-4 w-4" />
              <span>JSON</span>
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              <span>New Hold</span>
            </button>
          </div>
        </div>
      </div>

      <div className="p-6">
        {holds.length === 0 ? (
          <div className="text-center py-12">
            <Shield className="h-12 w-12 text-gray-400 mx-auto mb-3" />
            <p className="text-gray-600 dark:text-gray-400 font-medium">No legal holds found</p>
            <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">
              Create a legal hold to preserve documents for litigation or compliance.
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Case Reference</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Custodian</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Documents</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Applied Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {holds.slice((holdsPage - 1) * HOLDS_PAGE_SIZE, holdsPage * HOLDS_PAGE_SIZE).map((hold) => (
                  <tr key={hold.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-3">
                      <div>
                        <button
                          onClick={() => openDetail(hold)}
                          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {hold.caseReference}
                        </button>
                        {hold.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-md truncate" title={hold.description}>
                            {hold.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{hold.custodianName}</td>
                    <td className="px-4 py-3">
                      {isActive(hold) ? (
                        <span className="inline-flex items-center space-x-1 px-2 py-1 text-xs font-medium rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                          <Shield className="h-3 w-3" />
                          <span>Active</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center space-x-1 px-2 py-1 text-xs font-medium rounded bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                          <CheckCircle className="h-3 w-3" />
                          <span>Released</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{activeDocCount(hold)}</td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {new Date(hold.appliedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => openDetail(hold)}
                          className="text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                          title="View Details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {isActive(hold) && (
                          <>
                            <button
                              onClick={() => {
                                setSelectedHold(hold);
                                setAddDocs([]);
                                setShowAddDocsModal(true);
                              }}
                              className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                              title="Add Documents"
                            >
                              <FileText className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => {
                                setSelectedHold(hold);
                                setShowReleaseModal(true);
                              }}
                              className="text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300"
                              title="Release Hold"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {holds.length > HOLDS_PAGE_SIZE && (
              <PaginationControls
                page={holdsPage}
                onPageChange={setHoldsPage}
                hasPrevious={holdsPage > 1}
                hasNext={holdsPage * HOLDS_PAGE_SIZE < holds.length}
                totalPages={Math.max(1, Math.ceil(holds.length / HOLDS_PAGE_SIZE))}
              />
            )}
          </div>
        )}
      </div>

      {/* Create Hold Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Create Legal Hold</h3>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Case Reference *
                </label>
                <input
                  type="text"
                  value={createForm.caseReference}
                  onChange={(e) => setCreateForm({ ...createForm, caseReference: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  pattern="[a-zA-Z0-9\-_/]{3,50}"
                  title="3-50 characters: letters, numbers, hyphens, underscores, or slashes"
                  required
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  3-50 characters: letters, numbers, hyphens, underscores, or slashes.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Custodian Name *
                </label>
                <input
                  type="text"
                  value={createForm.custodianName}
                  onChange={(e) => setCreateForm({ ...createForm, custodianName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Legal Basis * <span className="font-normal text-gray-500">(min 20 characters)</span>
                </label>
                <textarea
                  value={createForm.legalBasis}
                  onChange={(e) => setCreateForm({ ...createForm, legalBasis: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={2}
                  minLength={20}
                  placeholder="Statute, regulation, litigation matter, or investigation requiring preservation"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description * <span className="font-normal text-gray-500">(min 20 characters)</span>
                </label>
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={3}
                  minLength={20}
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Expected Duration
                </label>
                <input
                  type="text"
                  value={createForm.expectedDuration}
                  onChange={(e) => setCreateForm({ ...createForm, expectedDuration: e.target.value })}
                  placeholder="e.g. 12 months, until case closure"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Documents to place on hold
                </label>
                <DocumentMultiPicker selected={createDocs} onChange={setCreateDocs} />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Optional. You can add documents later.
                </p>
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    resetCreateForm();
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Creating…' : 'Create Hold'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Release Hold Modal */}
      {showReleaseModal && selectedHold && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Release Legal Hold</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Case: <strong>{selectedHold.caseReference}</strong>
            </p>
            <form onSubmit={handleRelease} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Closure Reference *
                </label>
                <input
                  type="text"
                  value={releaseForm.closureRef}
                  onChange={(e) => setReleaseForm({ ...releaseForm, closureRef: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Release Reason *
                </label>
                <textarea
                  value={releaseForm.reason}
                  onChange={(e) => setReleaseForm({ ...releaseForm, reason: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  rows={3}
                  required
                />
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowReleaseModal(false);
                    setReleaseForm({ closureRef: '', reason: '' });
                    setSelectedHold(null);
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {saving ? 'Releasing…' : 'Release Hold'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Documents Modal */}
      {showAddDocsModal && selectedHold && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-6 w-full max-w-lg">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Add Documents to Hold</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Case: <strong>{selectedHold.caseReference}</strong>
            </p>
            <form onSubmit={handleAddDocuments} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Documents *
                </label>
                <DocumentMultiPicker selected={addDocs} onChange={setAddDocs} />
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddDocsModal(false);
                    setAddDocs([]);
                    setSelectedHold(null);
                  }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || addDocs.length === 0}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Adding…' : `Add ${addDocs.length || ''} Document${addDocs.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      {detailHold && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center space-x-2">
                  <Shield className="h-5 w-5" />
                  <span>{detailHold.caseReference}</span>
                  {isActive(detailHold) ? (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">Active</span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Released</span>
                  )}
                </h3>
                {detailHold.description && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{detailHold.description}</p>
                )}
              </div>
              <button
                onClick={() => setDetailHold(null)}
                className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                aria-label="Close details"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 border-b border-gray-200 dark:border-gray-700 text-sm">
              <DetailField label="Custodian" value={detailHold.custodianName} />
              <DetailField
                label="Applied"
                value={`${new Date(detailHold.appliedAt).toLocaleString()}${detailHold.appliedBy ? ` by ${detailHold.appliedBy.firstName} ${detailHold.appliedBy.lastName}` : ''}`}
              />
              <DetailField label="Expected Duration" value={detailHold.expectedDuration || '—'} />
              <DetailField label="Legal Basis" value={detailHold.legalBasis || '—'} className="col-span-2 sm:col-span-3" />
              {detailHold.releasedAt && (
                <>
                  <DetailField label="Released" value={new Date(detailHold.releasedAt).toLocaleString()} />
                  <DetailField label="Closure Ref" value={detailHold.releaseClosureRef || '—'} />
                  <DetailField label="Release Reason" value={detailHold.releaseReason || '—'} />
                </>
              )}
            </div>

            <div className="px-6 pt-3 flex space-x-1 border-b border-gray-200 dark:border-gray-700">
              {([
                { id: 'documents', label: `Affected Documents (${(detailHold.affectedDocuments ?? []).filter((d) => !d.removedAt).length})`, icon: FileText },
                { id: 'history', label: 'History', icon: History },
              ] as const).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setDetailTab(tab.id);
                    if (tab.id === 'history' && history === null) loadHistory(detailHold.id);
                  }}
                  className={`flex items-center space-x-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                    detailTab === tab.id
                      ? 'border-blue-600 text-blue-700 dark:text-blue-300'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  <tab.icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            <div className="p-6 overflow-y-auto flex-1 min-h-0">
              {detailLoading ? (
                <div className="flex items-center justify-center py-8 text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
                </div>
              ) : detailTab === 'documents' ? (
                (detailHold.affectedDocuments ?? []).filter((d) => !d.removedAt).length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                    No documents currently on this hold.
                  </p>
                ) : (
                  <table className="w-full">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Document</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Number</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Added</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {(detailHold.affectedDocuments ?? [])
                        .filter((d) => !d.removedAt)
                        .map((link) => (
                          <tr key={link.id}>
                            <td className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-white">
                              {link.document?.title || link.document?.documentName || link.documentId}
                            </td>
                            <td className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
                              {link.document?.documentNumber || '—'}
                            </td>
                            <td className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
                              {link.document?.status || '—'}
                            </td>
                            <td className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
                              {link.addedAt ? new Date(link.addedAt).toLocaleDateString() : '—'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )
              ) : historyLoading ? (
                <div className="flex items-center justify-center py-8 text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading history…
                </div>
              ) : !history || history.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                  No audit events recorded for this hold.
                </p>
              ) : (
                <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-2 space-y-5">
                  {history.map((entry) => {
                    const details = parseDetails(entry.actionDetails);
                    return (
                      <li key={entry.id} className="ml-4">
                        <span
                          className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${
                            entry.isSuccess === false ? 'bg-red-500' : 'bg-blue-500'
                          }`}
                        />
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <p className="text-sm font-medium text-gray-900 dark:text-white">
                            {entry.eventType.replace(/[._]/g, ' ')}
                          </p>
                          <time className="text-xs text-gray-500 dark:text-gray-400">
                            {new Date(entry.timestamp).toLocaleString()}
                          </time>
                          {entry.userRole && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">by {entry.userRole}</span>
                          )}
                        </div>
                        {details && (
                          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400 break-all">
                            {Object.entries(details)
                              .filter(([, v]) => typeof v !== 'object')
                              .map(([k, v]) => `${k}: ${String(v)}`)
                              .join(' · ')}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailField({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-0.5 text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}
