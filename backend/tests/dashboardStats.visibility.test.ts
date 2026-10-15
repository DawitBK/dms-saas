import { Op } from 'sequelize';

const mockDocument = { findAll: jest.fn() };

jest.mock('../src/infrastructure/database/index.js', () => ({
  Department: {},
  DocumentType: {},
  RetentionPolicy: {},
  FolderNode: {},
  DocumentVersion: {},
  DocumentSequence: {},
  Document: mockDocument,
  RetentionApplication: {},
  AclEntry: {},
  DocumentMetadata: {},
  DocumentDek: {},
  OutboxEvent: {},
  ApprovalChain: {},
  ApprovalStep: {},
  AuditStageReview: {},
  User: {},
  UserDepartment: {},
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock('../src/shared/resolveACL.js', () => ({
  resolveACL: jest.fn(),
  resolveACLBatch: jest.fn(),
  requireACL: jest.fn(),
  assertACLAllow: jest.fn(),
}));
jest.mock('../src/modules/documents/documentCrypto.js', () => ({ encryptAndStore: jest.fn() }));
jest.mock('../src/modules/documents/mimeValidation.js', () => ({ validateUploadedFile: jest.fn() }));
jest.mock('../src/modules/documents/quotaService.js', () => ({ reserveStorageQuota: jest.fn() }));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn() }));
jest.mock('../src/modules/documents/indexSidecar.js', () => ({ writeIndexSidecar: jest.fn() }));
jest.mock('../src/modules/documents/documentValidation.js', () => ({
  mandatoryMetadataFields: [], sha256: jest.fn(), validateUploadInput: jest.fn(),
}));
jest.mock('../src/config/env.js', () => ({ config: { MINIO_BUCKET_DOCUMENTS: 'documents' } }));
jest.mock('../src/core/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

let getDashboardStats: typeof import('../src/modules/documents/documents.service.js').getDashboardStats;

beforeAll(async () => {
  getDashboardStats = (await import('../src/modules/documents/documents.service.js')).getDashboardStats;
});

beforeEach(() => jest.clearAllMocks());

describe('dashboard statistics visibility contract', () => {
  it('uses the same signed-letter-draft exclusion as the repository list', async () => {
    const visible = {
      id: 'visible-document',
      status: 'ACTIVE',
      isOnLegalHold: false,
      updatedAt: new Date('2026-09-24T10:00:00.000Z'),
    };

    mockDocument.findAll.mockImplementation(async ({ where }: { where: Record<PropertyKey, unknown> }) => {
      const conditions = where[Op.and] as Array<{ val?: string }> | undefined;
      const excludesSignedDrafts = conditions?.some((condition) =>
        condition?.val?.includes('signed_draft_document_id = "Document"."id"'),
      );
      if (!excludesSignedDrafts) throw new Error('dashboard query omitted the repository signed-draft exclusion');
      return [visible];
    });

    const stats = await getDashboardStats({
      userId: 'admin-1', tenantId: 'tenant-1', role: 'SYSTEM_ADMIN', roles: ['SYSTEM_ADMIN'],
      permissions: ['document:read_all', 'acl:bypass_admin'],
    } as never);

    expect(stats.total).toBe(1);
    expect(stats.byStatus).toEqual({ ACTIVE: 1 });
    expect(stats.recent.map((doc: { id: string }) => doc.id)).toEqual(['visible-document']);
  });
});
