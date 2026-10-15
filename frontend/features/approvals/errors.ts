// Readable wording for the error codes the approval engine and the filer's form lifecycle can answer with.
//
// The backend sends a technical message together with a stable code; most of these codes describe a
// situation the person can act on, so the UI says what happened and what to do next instead of echoing
// the raw message. Unknown codes fall back to the server's own message (getErrorMessage), exactly as before.
//
// The wording is deliberately about "this item" / "this form" rather than "this document": the same
// engine serves documents, form templates and filed forms.

import { getErrorCode, getErrorMessage } from '@/shared/lib/errorMessage';

export const APPROVAL_ERROR_WORDING: Record<string, string> = {
  // ── Delegating a step ──────────────────────────────────────────────────────
  'ERR-DELEGATE-OUT-OF-SCOPE':
    'That person cannot take this step. They must be allowed to approve, belong to this item’s department, hold the same role when the step is a role step, and not be the person who submitted it. Pick someone else.',
  'ERR-DELEGATE-SELF': 'You cannot delegate a step to yourself. Pick another person.',
  'ERR-STEP-LOCKED':
    'This step is mandatory for this kind of item, so it cannot be handed to someone else. Decide it yourself, or ask an approval administrator to reassign it.',
  'ERR-STEP-ALREADY-DELEGATED':
    'This step was already delegated once and cannot be delegated again. The person who holds it now must decide it.',
  'ERR-DELEGATION-DISABLED': 'Delegation is switched off for this organisation. Decide the step yourself, or ask an approval administrator to reassign it.',
  // ── Deciding a step ────────────────────────────────────────────────────────
  'ERR-STEP-NOT-ASSIGNED': 'This step is not assigned to you, so you cannot act on it. Refresh the page to see who it is waiting on.',
  'ERR-STEP-NOT-PENDING': 'This step has already been decided or is not active yet. Refresh the page to see its current state.',
  'ERR-STEP-SELF-APPROVAL':
    'An approval step cannot be given to the person who submitted the item. Pick someone else.',
  'ERR-SELF-APPROVAL':
    'You submitted this item, so you cannot approve it yourself. Ask your department head to assign another approver.',
  'ERR-STEP-DEPT-SCOPE':
    'This item belongs to a department you are not a member of, so you cannot act on this step.',
  'ERR-CHAIN-STATE-INVALID':
    'The approval is no longer in the state this action needs (someone else may have just changed it). Refresh the page and try again.',
  'ERR-NOT-ITEM-OWNER': 'Only the person who owns this item can do that.',
  'ERR-USER-NOT-FOUND': 'That person could not be found or is no longer active. Refresh the list and pick someone else.',
  // ── Form templates: who may use them, who may approve them ─────────────────
  'ERR-FORM-TEMPLATE-ORG-SCOPE':
    'This form is available to the whole organisation (or an organisation unit), so only a person with organisation-level authority can reassign or cancel its approval.',
  'ERR-FORM-TEMPLATE-SCOPE':
    'This form template is outside the departments you administer, or it is not available for the department you selected. Choose a department the template is open to, or pick another template.',
  'ERR-FORM-SCOPE-REQUIRED':
    'Choose who can use this form. Without organisation-level authority you must pick a department you belong to.',
  'ERR-FORM-SCOPE':
    'You can only make a form available to a department you belong to. Choose one of your own departments.',
  'ERR-FORM-SCOPE-INVALID':
    'The department or organisation unit you chose does not exist any more. Reload the page and pick the scope again.',
  'ERR-TEMPLATE-SCOPE':
    'That approval recipe’s scope is not allowed. Choose either a department or an organisation unit (not both) that exists. Without organisation-level authority you can only set a recipe for a department you manage.',
  'ERR-TEMPLATE-TARGET':
    'A recipe must target exactly one thing: a document type, a form template, or the approval of form templates. Choose one and try again.',
  // ── A filed form's own lifecycle ───────────────────────────────────────────
  'ERR-NOT-FORM-FILER': 'Only the person who filed this form can edit, withdraw or cancel it.',
  'ERR-FORM-IN-REVIEW':
    'This form is under review, so it cannot be changed. Withdraw it from review first, then edit it and submit it again.',
  'ERR-FORM-NOT-EDITABLE':
    'This form can no longer be edited. A form can only be changed before it is approved, and only when it goes through approval.',
  'ERR-FORM-DRAFT-NOT-USED':
    'Saving as a draft is only available for forms that go through approval. File this form normally instead.',
  'ERR-TEMPLATE-INACTIVE':
    'The form template this was filed on is no longer active. File the form again using the current template.',
  'ERR-TEMPLATE-SUPERSEDED':
    'A newer version of this form template has been published. File the form again on the current version; your answers here are not carried over.',
};

/** The sentence to show for a failed approval or form-lifecycle call. */
export function approvalErrorMessage(err: unknown, fallback: string): string {
  const code = getErrorCode(err);
  if (code && APPROVAL_ERROR_WORDING[code]) return APPROVAL_ERROR_WORDING[code]!;
  return getErrorMessage(err, fallback);
}
