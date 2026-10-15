// Which lifecycle actions the person who FILED a form may take on it, from the status of its backing document.
// Mirrors the backend (forms.service.ts, loadFilerInstance / assertEditableStatus) so the buttons agree with
// what the server will accept; the server remains the authority and re-checks everything.
//
//   DRAFT / CHANGES_REQUESTED / DECLINED -> edit it, or abandon it (cancel)
//   IN_REVIEW                            -> recall it (withdraw) — never edit a moving target
//   anything else (approved, active, cancelled, ...) -> nothing
//
// Only the filer, and only for a template that goes through approval: a form with no approval is final once filed.

export type FilerAction = 'edit' | 'cancel' | 'withdraw';

export const EDITABLE_FORM_STATUSES = ['DRAFT', 'CHANGES_REQUESTED', 'DECLINED'] as const;

export function filerActionsFor(input: {
  /** Backing document status. */
  status: string | null | undefined;
  /** The template's approval mode. `undefined` means "not reported" (the list endpoint omits it): the status decides,
   *  which is safe because a form with no approval is filed straight to ACTIVE and so matches no status below. */
  instanceApproval?: 'none' | 'chain' | null;
  /** The instance's filer. */
  createdBy: string | null | undefined;
  currentUserId: string | null | undefined;
}): FilerAction[] {
  if (!input.currentUserId || !input.createdBy || input.createdBy !== input.currentUserId) return [];
  if (input.instanceApproval === 'none') return [];
  const status = input.status ?? '';
  if (status === 'IN_REVIEW') return ['withdraw'];
  if ((EDITABLE_FORM_STATUSES as readonly string[]).includes(status)) return ['edit', 'cancel'];
  return [];
}
