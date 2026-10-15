// Readable wording for the error codes the letters API can answer with.
//
// The backend sends a technical message ("Invalid letter transition: ...") together with a stable
// code; most of these codes describe a situation the person can act on, so the UI says what happened
// and what to do next instead of echoing the raw message. Unknown codes fall back to the server's own
// message (getErrorMessage), exactly as before.

import { getErrorCode, getErrorMessage } from '@/shared/lib/errorMessage';

export const LETTER_ERROR_WORDING: Record<string, string> = {
  'ERR-DEPT-ORG-UNIT-MISMATCH':
    'That department does not belong to the organisation unit you picked. Choose the unit the department sits under (the unit is part of the reference number).',
  'ERR-SELF-APPROVAL':
    'You drafted this letter, so you cannot approve it yourself. You can return it, or ask your department head to assign another approver.',
  'ERR-STEP-SELF-APPROVAL':
    'An approval step cannot be given to the person who drafted the letter. Pick someone else.',
  'ERR-DEPT-SCOPE':
    'That department is outside the ones you belong to or manage, so you cannot do this for it.',
  'ERR-STEP-DEPT-SCOPE':
    'This letter belongs to a department you are not a member of, so you cannot decide this step.',
  'ERR-LETTER-NOT-FINALIZED':
    'This letter has no reference number yet. It is approved but still waiting to be signed, so it cannot be dispatched or archived.',
  'ERR-LETTER-NOT-CANCELLABLE':
    'A signed, numbered letter is a letter of record and cannot be cancelled.',
  'ERR-REASON-REQUIRED':
    'Please give a reason of at least 10 characters. It is kept in the audit trail.',
  'ERR-BODY-IMAGE-FORBIDDEN':
    'The letter body contains an image that you did not upload. Delete it from the body and insert the image again.',
  'ERR-STEP-ROLE-UNSTAFFED':
    'Nobody holding that role is a member of this letter’s department right now. Pick a named person or another role.',
  'ERR-STEP-NOT-ASSIGNED': 'This step is not assigned to you.',
  'ERR-STEP-NOT-PENDING': 'This step has already been decided. Refresh the page to see its current state.',
  'ERR-LETTER-STATE-INVALID':
    'The letter is no longer in the state this action needs (someone else may have just changed it). Refresh and try again.',
  'ERR-LETTER-NOT-OWNER': 'Only the person who drafted this letter can do that.',
  'ERR-LETTER-APPROVAL-INCOMPLETE': 'Approval is not finished yet. A step is still waiting for a decision.',
  'ERR-LETTER-ALREADY-FINALIZED': 'This letter has already been signed and numbered.',
  'ERR-LETTER-NOT-FOUND': 'This letter does not exist or is outside what you may read.',
  'ERR-IMAGE-NOT-FOUND': 'That image does not exist or is not available to you.',
};

/** The sentence to show for a failed letters call. */
export function letterErrorMessage(err: unknown, fallback: string): string {
  const code = getErrorCode(err);
  if (code && LETTER_ERROR_WORDING[code]) return LETTER_ERROR_WORDING[code]!;
  return getErrorMessage(err, fallback);
}
