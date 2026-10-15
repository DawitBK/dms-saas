export type DocumentSummary = {
  id: string;
  documentName: string;
  title: string;
  status: string;
  securityClassification: string;
  departmentId: string;
  documentDate?: string;
  updatedAt: string;
  documentType: {
    name: string;
    code: string;
  };
  department: {
    name: string;
    code: string;
  };
  organisationUnit: string;
  owner: {
    firstName: string;
    lastName: string;
  };
};

export type DocumentVersion = {
  id: string;
  versionNumber: string;
  isMajorVersion: boolean;
  mimeType: string;
  fileSize: string;
  originalFilename: string;
  sha256Hash: string;
  authorId: string;
  changeSummary: string;
  /** Antivirus outcome for THIS version: "clean" | "unscanned". See ScanStatusBadge. */
  avScanStatus?: "clean" | "unscanned" | string | null;
  createdAt: string;
};

export type DocumentMetadata = {
  keywords?: string;
  description?: string;
  language?: string;
  geographicScope?: string;
  confidentialityNotice?: string;
  externalReference?: string;
};

export type DocumentDetail = DocumentSummary & {
  metadata?: DocumentMetadata;
  versions: DocumentVersion[];
  ocrStatus?: string;
  ocrConfidenceScore?: number;
  retentionClass: string;
  currentVersion: string;
  isOnLegalHold: boolean;
  archivedAt?: string;
  createdAt: string;
  checkout?: {
    id: string;
    checkedOutBy: string;
    checkedOutAt: string;
    notes?: string;
  };
  signatures?: {
    id: string;
    signatoryUserId: string;
    status: string;
    signedAt?: string;
  }[];
  workflowInstances: any[];
};

// Response from POST /documents (documents.service.ts createDocument). The
// route returns this object directly (no `{ data: ... }` envelope).
export type CreateDocumentResponse = DocumentDetail & {
  warnings: string[];
  // Set when the upload's plaintext hash matched an existing, non-deleted,
  // non-disposed/cancelled document in the same tenant — upload still
  // proceeds (never blocked), this is purely informational.
  duplicateOf: string | null;
  duplicateOfTitle: string | null;
  duplicateOfDocumentName: string | null;
};

export type CreateDocumentInput = {
  title: string;
  // departmentId is the precise, collision-free field the backend prefers
  // (departments.service.ts / documents.service.ts's createDocumentSchema) —
  // department codes are only unique per (tenant, org unit), so two
  // departments can share a code and departmentCode alone can resolve to the
  // WRONG one. Always send departmentId when it's known; departmentCode is
  // kept only for any caller not yet updated to send an id.
  departmentId?: string;
  departmentCode?: string;
  documentTypeCode: string;
  ownerId?: string;
  organisationUnit: string;
  securityClassification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  retentionClass: string;
  source: "MANUAL_UPLOAD" | "SCANNER" | "EMAIL" | "API" | "CREATED_IN_SYSTEM" | "MIGRATION";
  documentDate?: string;
  retentionTriggerDate?: string;
  keywords?: string;
  description?: string;
  language?: string;
  originatingSystem?: string;
  confidentialityNotice?: string;
  geographicScope?: string;
  externalReference?: string;
  folderPath?: string;
  changeSummary?: string;
};
