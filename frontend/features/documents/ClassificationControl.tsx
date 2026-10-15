'use client';

// The classification of a document, what it means for who can open it, and (for the owner, the head of the document's department and
// administrators) a way to change it. Backed by PATCH /documents/:id/classification.
//
// What each class means (owner decision 2026-10-10):
//   Public / Internal  every member of the document's department can open it, as always;
//   Confidential       only the owner, people it is shared with, the head of the department and the oversight roles;
//   Restricted         the same without the head.
// A platform administrator and the oversight roles (records officer, executive, auditor, system administrator) read everything.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Lock, Shield } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { Modal } from '../../shared/components/Modal';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useAuthStore } from '../../state/auth.store';
import { CLASSIFICATION_LABEL, type Classification } from '../../shared/lib/classification';

const RANK: Record<Classification, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };
const LABEL = CLASSIFICATION_LABEL;

export const WHO_CAN_OPEN: Record<Classification, string> = {
  PUBLIC: 'Everyone in the department can open it.',
  INTERNAL: 'Everyone in the department can open it.',
  CONFIDENTIAL:
    'Only the owner, people it has been shared with, the head of the department, and the oversight roles (records officer, executive, auditor, administrators) can open it. Other department members cannot.',
  RESTRICTED:
    'Only the owner, people it has been shared with, and the oversight roles (records officer, executive, auditor, administrators) can open it. Not even the head of the department, unless it is shared with them.',
};

export function isClassifiedLevel(c: string | null | undefined): boolean {
  return c === 'CONFIDENTIAL' || c === 'RESTRICTED';
}

export function ClassificationControl({
  documentId,
  classification,
  ownerId,
}: {
  documentId: string;
  classification: string;
  ownerId: string | null;
}) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const userId = useAuthStore((s) => s.userId);
  const current = (classification as Classification) in RANK ? (classification as Classification) : 'INTERNAL';
  const canChange = (userId && ownerId === userId) || can(PERMISSIONS.ACL_BYPASS_ADMIN) || can(PERMISSIONS.DEPT_MANAGE);

  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<Classification>(current);
  const [reason, setReason] = useState('');
  const lowering = RANK[next] < RANK[current];
  const reasonOk = !lowering || reason.trim().length >= 10;

  const change = useMutation({
    mutationFn: () =>
      apiClient(`/documents/${documentId}/classification`, {
        method: 'PATCH',
        body: JSON.stringify({ classification: next, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      }),
    onSuccess: () => {
      toast.success(`Classification is now ${LABEL[next]}`);
      setOpen(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['document', documentId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents-list'] });
      qc.invalidateQueries({ queryKey: ['folder-contents'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not change the classification'),
  });

  return (
    <>
      <span
        className="flex items-center gap-1"
        title={WHO_CAN_OPEN[current]}
        data-testid="classification-badge"
      >
        {isClassifiedLevel(current) ? <Lock className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
        {current}
      </span>
      {canChange && (
        <button
          type="button"
          onClick={() => { setNext(current); setReason(''); setOpen(true); }}
          className="text-xs font-semibold text-brand-600 hover:underline"
          title="Change who can open this document"
        >
          Change classification
        </button>
      )}

      <Modal isOpen={open} onClose={() => setOpen(false)} title="Change classification">
        <div className="space-y-3">
          <label className="block text-xs font-semibold uppercase tracking-wider" htmlFor="classification-select">New classification</label>
          <select
            id="classification-select"
            className="ui-input w-full"
            value={next}
            onChange={(e) => setNext(e.target.value as Classification)}
          >
            {(Object.keys(RANK) as Classification[]).map((c) => <option key={c} value={c}>{LABEL[c]}</option>)}
          </select>
          <p className="text-sm text-text-secondary" data-testid="classification-explainer">{WHO_CAN_OPEN[next]}</p>
          {lowering && (
            <>
              <p className="text-xs text-amber-700">
                Lowering the classification lets more people open this document. Say why (at least 10 characters); it is written to the audit log.
              </p>
              <textarea
                className="ui-input w-full"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is it safe to lower the classification?"
                aria-label="Reason for lowering the classification"
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="ui-btn ui-btn-secondary">Back</button>
            <button
              onClick={() => change.mutate()}
              disabled={change.isPending || next === current || !reasonOk}
              className="ui-btn ui-btn-primary"
            >
              {change.isPending ? 'Working…' : 'Change classification'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
