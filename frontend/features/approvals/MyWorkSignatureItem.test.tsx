// Regression coverage for a real reported bug: clicking a pending Signatures
// item on My Work used to route to `/dashboard/signing?documentId=...` (the
// signing hub's create/manage flow, gated behind SIGNING_MANAGE) instead of
// the self-service "sign now" list — a plain signer landed on a page they
// had no permission to use. Fixed to always link to
// `/dashboard/signing/pending` regardless of whether the item carries a
// document id.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MyWorkSignatureItem } from './MyWorkSignatureItem';
import type { MyWork } from './api';

function makeSignature(overrides: Partial<MyWork['signatures'][number]> = {}): MyWork['signatures'][number] {
  return {
    recipientId: 'recipient-1',
    requestId: 'request-1',
    status: 'pending',
    createdAt: '2026-08-20T00:00:00.000Z',
    document: { id: 'doc-1', title: 'Q3 Budget Letter', documentName: 'FIN-OUT-20260820-0001' },
    ...overrides,
  };
}

describe('MyWorkSignatureItem', () => {
  it('always links to the self-service pending-signature page when the item carries a document', () => {
    render(<MyWorkSignatureItem signature={makeSignature()} />);
    const link = screen.getByRole('link', { name: 'Q3 Budget Letter' });
    expect(link).toHaveAttribute('href', '/dashboard/signing/pending');
  });

  it('never links to the signing hub (create/manage flow), even with a documentId available', () => {
    // This is the exact shape of the original bug: a document id WAS present,
    // and the old code used it to build a `/dashboard/signing?documentId=...`
    // link straight into the gated hub.
    render(<MyWorkSignatureItem signature={makeSignature({ document: { id: 'doc-99', title: 'Contract', documentName: 'LEGAL-1' } })} />);
    const link = screen.getByRole('link', { name: 'Contract' });
    expect(link).not.toHaveAttribute('href', expect.stringContaining('/dashboard/signing?'));
    expect(link).toHaveAttribute('href', '/dashboard/signing/pending');
  });

  it('still links to the pending-signature page when the item has no document (edge case that motivated the original fallback)', () => {
    render(<MyWorkSignatureItem signature={makeSignature({ document: null })} />);
    const link = screen.getByRole('link', { name: '(document)' });
    expect(link).toHaveAttribute('href', '/dashboard/signing/pending');
  });

  it('renders the signature status and age', () => {
    render(<MyWorkSignatureItem signature={makeSignature({ status: 'pending' })} />);
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});
