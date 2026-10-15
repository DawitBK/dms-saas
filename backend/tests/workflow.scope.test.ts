// Legacy workflow engine (modules/workflow): separation of duties and tenant
// ownership of the document type a definition is keyed to.

const mockWorkflowTask = { findByPk: jest.fn(), create: jest.fn() };
const mockWorkflowDocumentType = { findOne: jest.fn(), findByPk: jest.fn() };
const mockWorkflowDefinition = { create: jest.fn(), findOne: jest.fn() };

jest.mock('../src/infrastructure/database/index.js', () => ({
  AclEntry: { findOrCreate: jest.fn() },
  Document: { findByPk: jest.fn(), update: jest.fn() },
  DocumentType: mockWorkflowDocumentType,
  OutboxEvent: { create: jest.fn() },
  WorkflowDefinition: mockWorkflowDefinition,
  WorkflowInstance: { create: jest.fn(), update: jest.fn() },
  WorkflowTask: mockWorkflowTask,
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/shared/transaction.js', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
jest.mock('../src/modules/documents/DocumentStateMachine.js', () => ({ validateTransition: jest.fn() }));
jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

let processTaskDecision: typeof import('../src/modules/workflow/workflow.service.js').processTaskDecision;
let createWorkflowDefinition: typeof import('../src/modules/workflow/workflow.service.js').createWorkflowDefinition;
let updateWorkflowDefinition: typeof import('../src/modules/workflow/workflow.service.js').updateWorkflowDefinition;
beforeAll(async () => {
  ({ processTaskDecision, createWorkflowDefinition, updateWorkflowDefinition } = await import('../src/modules/workflow/workflow.service.js'));
});

const TASK_ID = '00000000-0000-4000-8000-0000000000a1';
const DOC_TYPE = '00000000-0000-4000-8000-0000000000d1';

function taskFor(opts: { initiatedById: string; ownerId: string }) {
  return {
    id: TASK_ID, status: 'PENDING', assignedToUserId: null, assignedToRole: 'DEPT_MANAGER', stageNumber: 1,
    workflowInstanceId: 'inst-1',
    update: jest.fn().mockResolvedValue(undefined),
    workflowInstance: {
      initiatedById: opts.initiatedById, documentId: 'doc-1',
      document: { ownerId: opts.ownerId, status: 'IN_REVIEW', tenantId: 't1', documentTypeId: DOC_TYPE },
      workflowDefinition: { definition: JSON.stringify({ stages: [{ stageNumber: 1, name: 'A', assignedRole: 'DEPT_MANAGER', slaDurationHours: 8, slaBusinessHoursOnly: false }] }) },
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('processTaskDecision — no self-approval', () => {
  it('refuses the person who started the workflow', async () => {
    mockWorkflowTask.findByPk.mockResolvedValue(taskFor({ initiatedById: 'me', ownerId: 'someone' }));
    await expect(processTaskDecision(TASK_ID, 'me', 'APPROVED', undefined, 't1', ['DEPT_MANAGER']))
      .rejects.toMatchObject({ statusCode: 403, code: 'ERR-SELF-APPROVAL' });
  });

  it('refuses the document owner', async () => {
    mockWorkflowTask.findByPk.mockResolvedValue(taskFor({ initiatedById: 'someone', ownerId: 'me' }));
    await expect(processTaskDecision(TASK_ID, 'me', 'APPROVED', undefined, 't1', ['DEPT_MANAGER']))
      .rejects.toMatchObject({ code: 'ERR-SELF-APPROVAL' });
  });

  it('lets an independent assignee decide', async () => {
    const task = taskFor({ initiatedById: 'someone', ownerId: 'owner' });
    mockWorkflowTask.findByPk.mockResolvedValue(task);
    mockWorkflowDocumentType.findByPk.mockResolvedValue({ requiresSignature: false });
    await expect(processTaskDecision(TASK_ID, 'approver', 'REJECTED', 'no', 't1', ['DEPT_MANAGER'])).resolves.toEqual({ success: true });
    expect(task.update).toHaveBeenCalled();
  });
});

describe('workflow definitions — the document type must belong to the tenant', () => {
  const body = { name: 'Flow', version: '1', definition: '{}', documentTypeId: DOC_TYPE };

  it('refuses to create a definition keyed to another tenant\'s document type', async () => {
    mockWorkflowDocumentType.findOne.mockResolvedValue(null);
    await expect(createWorkflowDefinition(body, 'u', 't1')).rejects.toMatchObject({ statusCode: 422, code: 'ERR-DOCTYPE-NOT-FOUND' });
    expect(mockWorkflowDefinition.create).not.toHaveBeenCalled();
    expect(mockWorkflowDocumentType.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DOC_TYPE, tenantId: 't1' } }));
  });

  it('creates one for a type in the tenant, and for a tenant-wide definition (no type)', async () => {
    mockWorkflowDocumentType.findOne.mockResolvedValue({ id: DOC_TYPE });
    mockWorkflowDefinition.create.mockResolvedValue({ id: 'def-1', name: 'Flow', version: '1' });
    await expect(createWorkflowDefinition(body, 'u', 't1')).resolves.toMatchObject({ id: 'def-1' });
    await expect(createWorkflowDefinition({ ...body, documentTypeId: null }, 'u', 't1')).resolves.toMatchObject({ id: 'def-1' });
  });

  it('refuses to re-key an existing definition onto another tenant\'s type', async () => {
    mockWorkflowDefinition.findOne.mockResolvedValue({ id: 'def-1', name: 'Flow', version: '1', update: jest.fn() });
    mockWorkflowDocumentType.findOne.mockResolvedValue(null);
    await expect(updateWorkflowDefinition('def-1', { documentTypeId: DOC_TYPE }, 'u', 't1'))
      .rejects.toMatchObject({ code: 'ERR-DOCTYPE-NOT-FOUND' });
  });
});
