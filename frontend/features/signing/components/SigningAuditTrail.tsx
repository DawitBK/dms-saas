'use client';

import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { getSignatureRequestAudit, type SigningAuditEntry } from '../internalApi';
import { signingAuditActionLabel, signingErrorMessage } from '../errors';

function when(value: string): string {
  const d = new Date(value);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy HH:mm:ss');
}

function who(e: SigningAuditEntry): string {
  if (e.actor) return e.actor.name ?? 'A user';
  if (e.externalSigner) return `External signer (${e.externalSigner})`;
  return 'System';
}

/** The audit trail of one signature request: who did what, when, from which address and browser. */
export function SigningAuditTrail({ requestId }: { requestId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['signing', 'audit', requestId],
    queryFn: () => getSignatureRequestAudit(requestId),
  });

  if (isLoading) return <p className="text-xs py-2" style={{ color: 'var(--text-secondary)' }}>Loading history...</p>;
  if (error) {
    return <p role="alert" className="text-xs py-2" style={{ color: 'var(--text-secondary)' }}>{signingErrorMessage(error, 'Could not load the history')}</p>;
  }
  const entries = data?.data ?? [];
  if (entries.length === 0) return <p className="text-xs py-2" style={{ color: 'var(--text-secondary)' }}>No history recorded for this request.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left" style={{ color: 'var(--text-tertiary)' }}>
            <th className="py-1 pr-3 font-medium">When</th>
            <th className="py-1 pr-3 font-medium">Who</th>
            <th className="py-1 pr-3 font-medium">Action</th>
            <th className="py-1 pr-3 font-medium">Address</th>
            <th className="py-1 font-medium">Browser</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="align-top" style={{ color: e.success ? 'var(--text-primary)' : 'var(--danger, #b42318)' }}>
              <td className="py-1 pr-3 whitespace-nowrap">{when(e.at)}</td>
              <td className="py-1 pr-3">{who(e)}</td>
              <td className="py-1 pr-3">
                {signingAuditActionLabel(e.action)}
                {e.detail && <span style={{ color: 'var(--text-tertiary)' }}> · {e.detail}</span>}
              </td>
              <td className="py-1 pr-3 whitespace-nowrap">{e.ipAddress ?? '--'}</td>
              <td className="py-1 max-w-[18rem] truncate" title={e.userAgent ?? undefined}>{e.userAgent ?? '--'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
