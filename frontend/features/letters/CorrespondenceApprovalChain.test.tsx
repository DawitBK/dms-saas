// Regression coverage for the feature the "lazy workflow" complaint was
// actually about: a letter's Workflow tab must show every approval/signing
// step and exactly who did each one — not the generic assigned role, and
// not a false "not submitted yet" for a letter that already went through a
// real, completed chain. See letters.byDocument.test.ts (backend) for the
// data-fetching half of this fix; this covers the rendering half.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CorrespondenceApprovalChain } from './CorrespondenceApprovalChain';
import type { LetterDetail } from './types';

function makeLetter(overrides: Partial<LetterDetail> = {}): LetterDetail {
  return {
    id: 'letter-1',
    direction: 'OUTGOING',
    status: 'ARCHIVED',
    referenceNumber: 'REF/HQ/FIN/OUT/2026/0042',
    subject: 'Quarterly budget approval',
    letterType: 'OUT',
    originType: 'COMPOSED',
    confidentiality: 'INTERNAL',
    priority: 'NORMAL',
    correspondent: null,
    correspondentOrganization: null,
    correspondentLocation: null,
    correspondentEmail: null,
    receivedDate: null,
    dueDate: null,
    approvedAt: '2026-08-20T10:00:00.000Z',
    year: 2026,
    createdBy: 'user-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    bodyHtml: null,
    language: 'en',
    signatoryName: null,
    signatoryTitle: null,
    documentId: 'doc-1',
    attachmentDocumentId: null,
    coverSheetDocumentId: null,
    qrPayload: null,
    approvalSteps: [],
    revisions: [],
    dispatches: [],
    attachments: [],
    ...overrides,
  };
}

describe('CorrespondenceApprovalChain', () => {
  it('shows the empty state when the letter has no approval steps', () => {
    render(<CorrespondenceApprovalChain letter={makeLetter()} />);
    expect(screen.getByText('No approval chain exists for this letter yet.')).toBeInTheDocument();
  });

  it('renders the specific person who decided a role-assigned step, not just the generic role', () => {
    // The exact bug reported: a role-assigned step ("any AUDIT_MANAGER may
    // decide this") showed the generic role even after a named, specific
    // person (not the role's typical holder) actually approved it.
    render(
      <CorrespondenceApprovalChain
        letter={makeLetter({
          approvalSteps: [
            {
              id: 'step-1',
              stepOrder: 1,
              stepType: 'APPROVE',
              assignedUserId: null,
              assignedUser: null,
              assignedRole: 'DEPT_MANAGER',
              status: 'APPROVED',
              comment: null,
              decidedBy: 'user-99',
              decidedByUser: { id: 'user-99', firstName: 'Amanuel', lastName: 'Tesfaye', email: 'amanuel@examplecorp.com' },
              decidedAt: '2026-08-15T09:00:00.000Z',
            },
          ],
        })}
      />,
    );

    // "to" line still names the role it was owed to...
    expect(screen.getByText(/to DEPT MANAGER/)).toBeInTheDocument();
    // ...but the actual decider is named explicitly, distinct from the role.
    expect(screen.getByText(/decided by Amanuel Tesfaye \(amanuel@examplecorp.com\)/)).toBeInTheDocument();
  });

  it('does not claim a decider for a step nobody has decided yet', () => {
    render(
      <CorrespondenceApprovalChain
        letter={makeLetter({
          approvalSteps: [
            {
              id: 'step-1',
              stepOrder: 1,
              stepType: 'REVIEW',
              assignedUserId: 'user-5',
              assignedUser: { id: 'user-5', firstName: 'Sara', lastName: 'Bekele', email: 'sara@examplecorp.com' },
              assignedRole: null,
              status: 'PENDING',
              comment: null,
              decidedBy: null,
              decidedByUser: null,
              decidedAt: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/to Sara Bekele/)).toBeInTheDocument();
    expect(screen.queryByText(/decided by/)).not.toBeInTheDocument();
  });

  it('renders the dispatch section with who sent it, only when dispatches exist', () => {
    const { rerender } = render(<CorrespondenceApprovalChain letter={makeLetter({ dispatches: [] })} />);
    expect(screen.queryByText('Dispatch')).not.toBeInTheDocument();

    rerender(
      <CorrespondenceApprovalChain
        letter={makeLetter({
          dispatches: [
            {
              id: 'dispatch-1',
              channel: 'EMAIL',
              recipientName: 'Finance Dept',
              recipientAddress: null,
              trackingReference: null,
              notes: null,
              dispatchedBy: 'user-7',
              dispatcher: { id: 'user-7', firstName: 'Meron', lastName: 'Alemu', email: 'meron@examplecorp.com' },
              dispatchedAt: '2026-08-21T08:00:00.000Z',
              acknowledgedAt: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Dispatch')).toBeInTheDocument();
    expect(screen.getByText(/by Meron Alemu/)).toBeInTheDocument();
    expect(screen.getByText(/to Finance Dept/)).toBeInTheDocument();
  });

  it('links to the full letter detail page', () => {
    render(<CorrespondenceApprovalChain letter={makeLetter({ id: 'letter-42' })} />);
    const link = screen.getByRole('link', { name: /View full letter/ });
    expect(link).toHaveAttribute('href', '/dashboard/letters/letter-42');
  });
});
