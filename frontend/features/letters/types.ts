// CAMS correspondence types (mirror backend letters module)

export interface OrgUnitSummary {
  id: string;
  code: string;
  name: string;
  unitType: 'HQ' | 'BRANCH' | 'OUTLET' | 'SISTER_COMPANY';
  parentUnitId?: string | null;
  isActive: boolean;
}

export interface LetterApprovalStep {
  id: string;
  stepOrder: number;
  stepType: 'REVIEW' | 'APPROVE';
  assignedUserId: string | null;
  assignedUser?: { id: string; firstName: string; lastName: string; email: string } | null;
  assignedRole: string | null;
  status: 'WAITING' | 'PENDING' | 'APPROVED' | 'RETURNED' | 'CANCELLED';
  comment: string | null;
  decidedBy: string | null;
  /** The specific person who actually made the decision — distinct from
   *  assignedUser, which is null for a role-assigned step ("any
   *  DEPT_MANAGER may decide this"). Always set once decidedBy is, however
   *  the step was assigned. */
  decidedByUser?: { id: string; firstName: string; lastName: string; email: string } | null;
  decidedAt: string | null;
  /** Deadline of the current step, the hours it was set from, and what the sweep did about it. */
  slaHours?: number | null;
  dueAt?: string | null;
  slaBreachedAt?: string | null;
  escalatedAt?: string | null;
  /** Department heads an overdue step escalated to; they may decide it beside the assignee. */
  escalatedToUserIds?: string[];
}

export interface LetterAttachmentRecord {
  id: string;
  letterId: string;
  documentId: string;
  originalFilename: string;
  uploadedBy: string;
  createdAt: string;
}

export interface LetterDispatchRecord {
  id: string;
  channel: 'EMAIL' | 'PORTAL' | 'PRINT' | 'COURIER' | 'HAND_DELIVERY' | 'REGISTERED_MAIL';
  recipientName: string | null;
  recipientAddress: string | null;
  trackingReference: string | null;
  notes: string | null;
  dispatchedBy?: string | null;
  dispatcher?: { id: string; firstName: string; lastName: string; email: string } | null;
  dispatchedAt: string;
  acknowledgedAt: string | null;
}

export interface LetterRevisionRecord {
  id: string;
  revisionNo: number;
  subject: string;
  savedBy?: string | null;
  author?: { id: string; firstName: string; lastName: string; email: string } | null;
  createdAt: string;
}

/** Full revision including body — fetched on demand via GET /letters/:id/revisions/:revisionNo. */
export interface LetterRevisionBody extends LetterRevisionRecord {
  letterId: string;
  bodyHtml: string | null;
}

export interface LetterSummary {
  id: string;
  direction: 'OUTGOING' | 'INCOMING';
  status:
    | 'DRAFT'
    | 'IN_REVIEW'
    | 'RETURNED'
    | 'PENDING_SIGNATURE'
    | 'APPROVED'
    | 'DISPATCHED'
    | 'RECEIVED'
    | 'RESPONDED'
    | 'CLOSED'
    | 'ARCHIVED'
    | 'CANCELLED'
    | 'OVERDUE';
  referenceNumber: string | null;
  subject: string;
  letterType: 'OUT' | 'IN' | 'MEMO' | 'CIRC' | 'CONT';
  /** COMPOSED = written in-system (rendered to PDF at approval). SCANNED =
   *  content is an uploaded file (PDF/Word/image); null for legacy
   *  logged-only incoming registrations with no scan attached. */
  originType: 'COMPOSED' | 'SCANNED' | null;
  confidentiality: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  priority: 'NORMAL' | 'HIGH' | 'URGENT';
  correspondent: string | null;
  correspondentOrganization: string | null;
  /** City/country line rendered under the "To:"/"From:" addressee on the
   *  letter PDF (e.g. "Example City, Exampleland"). */
  correspondentLocation: string | null;
  correspondentEmail: string | null;
  receivedDate: string | null;
  dueDate: string | null;
  approvedAt: string | null;
  year: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  orgUnit?: { id: string; code: string; name: string; unitType: string };
  department?: { id: string; code: string; name: string };
  creator?: { id: string; firstName: string; lastName: string; email: string };
  assignedToUserId?: string | null;
  assignee?: { id: string; firstName: string; lastName: string; email: string } | null;
  signatory?: { id: string; firstName: string; lastName: string; email: string } | null;
  isOverdue?: boolean;
}

export interface LetterDetail extends LetterSummary {
  bodyHtml: string | null;
  language: string;
  signatoryName: string | null;
  signatoryTitle: string | null;
  documentId: string | null;
  attachmentDocumentId: string | null;
  coverSheetDocumentId: string | null;
  qrPayload: string | null;
  approvalSteps?: LetterApprovalStep[];
  revisions?: LetterRevisionRecord[];
  dispatches?: LetterDispatchRecord[];
  attachments?: LetterAttachmentRecord[];
  /** Present on createScannedLetter/addLetterAttachment/registerIncoming
   *  responses — mirrors documents.service.ts's WARN-UNSCANNED (fail-open:
   *  the antivirus scan didn't complete, upload still went through).
   *  Undefined on plain reads (getLetter, updateLetter, etc.), which never
   *  compute it. */
  warnings?: string[];
}

export interface LetterLinkRecord {
  id: string;
  linkType: 'REPLY_TO' | 'RELATED' | 'FOLLOW_UP';
  letter?: Partial<LetterSummary>;
  relatedLetter?: Partial<LetterSummary>;
}

export interface CreateLetterInput {
  orgUnitId: string;
  departmentId: string;
  subject: string;
  bodyHtml?: string;
  letterType?: 'OUT' | 'MEMO' | 'CIRC' | 'CONT';
  confidentiality?: string;
  priority?: string;
  language?: string;
  correspondent?: string;
  correspondentOrganization?: string;
  correspondentLocation?: string;
  correspondentEmail?: string;
}

export interface LetterVolumeRow {
  month: string;
  outgoing_count: number;
  incoming_count: number;
  total_count: number;
}

export interface LetterVolumeReport {
  key: string;
  name: string;
  columns: { key: string; label: string }[];
  rows: LetterVolumeRow[];
  summary: { totalLetters: number; monthsCovered: number; avgPerMonth: number };
}

export interface VerifyResult {
  authentic: boolean;
  referenceNumber: string | null;
  issuingUnit?: { code: string; name: string } | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  approvedAt?: string | null;
  status?: string;
}
