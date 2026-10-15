/**
 * The four document classes, in one place.
 *
 * They are the values of `documents.securityClassification` (the server's `z.enum` in documents.service.ts and, since migration
 * 20261011000010, a database CHECK). The upload form, the classification control, the search filter and the AI-controls panel each used to
 * declare their own copy, and the search filter's copy drifted (it offered OPEN, SECRET and TOP_SECRET, which no document can hold, and left out
 * PUBLIC and RESTRICTED). Import from here; do not retype the list.
 */
export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  PUBLIC: 'Public',
  INTERNAL: 'Internal',
  CONFIDENTIAL: 'Confidential',
  RESTRICTED: 'Restricted',
};

/** Badge colours for a class (search results). */
export const CLASSIFICATION_BADGE: Record<Classification, string> = {
  PUBLIC: 'bg-emerald-500/15 text-emerald-500',
  INTERNAL: 'bg-blue-500/15 text-blue-500',
  CONFIDENTIAL: 'bg-orange-500/15 text-orange-500',
  RESTRICTED: 'bg-red-500/15 text-red-500',
};
