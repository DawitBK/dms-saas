// SPRINT-5 (S5-01): Added audit events for workflow operations
import { z } from "zod";
import {
  AclEntry,
  Document,
  DocumentType,
  OutboxEvent,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTask
} from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { config } from "../../config/env.js";
import moment from "moment-timezone";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { runInTransaction } from "../../shared/transaction.js";
import { validateTransition } from "../documents/DocumentStateMachine.js";

const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(255),
  documentTypeId: z.string().uuid().optional().nullable(),
  version: z.string().min(1).max(20),
  definition: z.string().min(1),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional()
});

export interface WorkflowStage {
  stageNumber: number;
  name: string;
  assignedRole: string;
  slaDurationHours: number;
  slaBusinessHoursOnly: boolean;
  escalationRole?: string;
  parallelApproval?: boolean;
}

export interface WorkflowDefinitionData {
  stages: WorkflowStage[];
}

export async function startWorkflow(documentId: string, initiatorId: string) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentType,
        as: "documentType",
        include: [{ model: WorkflowDefinition, as: "workflowDefinitions", where: { isActive: true, isDefault: true }, required: false }]
      }
    ]
  });

  if (!document) throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");

  // FIX: this force-wrote status: "IN_REVIEW" unconditionally regardless of
  // the document's current status — no frontend caller reaches this today
  // (the newer unified approvals/ engine superseded it), but it stays
  // mounted and reachable by anyone holding workflow:manage. Validate
  // against the real state machine instead of assuming any document can
  // start a workflow, same fix class as esigning/signing's create-time gaps.
  validateTransition(document.status, "IN_REVIEW");

  const definition = (document as any).documentType?.workflowDefinitions?.[0];
  if (!definition) {
    logger.warn({ docType: (document as any).documentType?.code }, "no default workflow definition found");
    return null;
  }

  const stagesData = JSON.parse(definition.definition) as WorkflowDefinitionData;
  const firstStage = stagesData.stages[0];
  const deadline = calculateDeadline(firstStage.slaDurationHours, firstStage.slaBusinessHoursOnly);

  return runInTransaction(async (transaction) => {
    const inst = await WorkflowInstance.create(
      {
        tenantId: document.tenantId,
        documentId,
        workflowDefinitionId: definition.id,
        initiatedById: initiatorId,
        status: "ACTIVE",
        currentStage: 1
      },
      { transaction }
    );

    const newTask = await WorkflowTask.create(
      {
        tenantId: document.tenantId,
        workflowInstanceId: inst.id,
        stageName: firstStage.name,
        stageNumber: firstStage.stageNumber,
        assignedToRole: firstStage.assignedRole,
        status: "PENDING",
        slaDeadlineAt: deadline.deadline,
        slaWarningAt: deadline.warning
      },
      { transaction }
    );

    await AclEntry.findOrCreate({
      where: {
        resourceType: "workflow_task",
        resourceId: newTask.id,
        principalType: "role",
        principalId: firstStage.assignedRole,
        permission: "WRITE",
      },
      defaults: {
        tenantId: document.tenantId,
        resourceType: "workflow_task",
        resourceId: newTask.id,
        principalType: "role",
        principalId: firstStage.assignedRole,
        effect: "ALLOW",
        permission: "WRITE",
        grantedById: initiatorId,
      },
    });

    await Document.update({ status: "IN_REVIEW", approvalStatus: "IN_PROGRESS" }, { where: { id: documentId }, transaction });

    await OutboxEvent.create(
      {
        documentId,
        type: "WORKFLOW.STARTED",
        channel: "WEBSOCKET",
        // payload.tenantId lets the webhook fan-out scope its subscriber
        // lookup without the RLS-latent documents fallback read.
        payload: JSON.stringify({ documentId, instanceId: inst.id, departmentId: document.departmentId, tenantId: document.tenantId })
      },
      { transaction }
    );

    // S5-01: Emit WORKFLOW_INSTANCE_STARTED audit event
    await writeAuditLog({
      eventType: AUDIT_EVENTS.WORKFLOW_INSTANCE_STARTED,
      userId: initiatorId,
      actionDetails: { documentId, instanceId: inst.id, workflowDefinitionId: definition.id }
    });

    return inst;
  });
}

export async function processTaskDecision(
  taskId: string,
  userId: string,
  decision: "APPROVED" | "REJECTED",
  reason?: string,
  tenantId?: string,
  userRoles?: string[]
) {
  const task = await WorkflowTask.findByPk(taskId, {
    include: [
      {
        model: WorkflowInstance,
        as: "workflowInstance",
        include: [{ model: Document, as: "document" }, { model: WorkflowDefinition, as: "workflowDefinition" }]
      }
    ]
  });

  if (!task || task.status !== "PENDING") {
    throw new AppError(404, "ERR-TASK-NOT-FOUND", "Task not found or already processed");
  }

  if (userRoles) {
    const assignedToUser = task.assignedToUserId;
    const assignedToRole = task.assignedToRole;
    if (assignedToUser && assignedToUser !== userId) {
      throw new AppError(403, "AUTHZ_NOT_ASSIGNED", "This task is assigned to a specific user and you are not that user");
    }
    if (!assignedToUser && assignedToRole && !userRoles.includes(assignedToRole)) {
      throw new AppError(403, "AUTHZ_NOT_ASSIGNED", "This task is not assigned to your role");
    }
  }

  const instance = (task as any).workflowInstance;

  // Separation of duties, same rule as the unified engine (approvals.service.ts
  // decideStep): whoever started the workflow or owns the document cannot
  // decide its tasks.
  if (instance.initiatedById === userId || instance.document?.ownerId === userId) {
    throw new AppError(403, "ERR-SELF-APPROVAL", "You started or own this document and cannot decide its approval tasks yourself");
  }
  const definitionData = JSON.parse(instance.workflowDefinition.definition) as WorkflowDefinitionData;

  // FIX: this used to force-write REJECTED/APPROVED/PENDING_SIGNATURE onto
  // the document with zero regard for its actual current status — a task
  // left PENDING while the document was separately archived, disposed, put
  // on legal hold, or routed into a signing ceremony by other means could
  // still be "decided" here, silently clobbering whatever state it had
  // moved to. All three targets below require the document to currently be
  // IN_REVIEW (REJECTED/APPROVED both validate cleanly against
  // DocumentStateMachine.ts; the requiresSignature shortcut straight to
  // PENDING_SIGNATURE is a pre-existing inconsistency with that graph — not
  // redesigned here, just no longer reachable from a document that has
  // already moved on).
  if (instance.document.status !== "IN_REVIEW") {
    throw new AppError(
      409,
      "ERR-DOCUMENT-STATE-INVALID",
      `Cannot record a workflow decision — the document is ${instance.document.status}, not In Review (it may have changed since this task was created).`,
    );
  }

  return runInTransaction(async (transaction) => {
    await task.update(
      {
        status: decision === "APPROVED" ? "APPROVED" : "REJECTED",
        decision,
        decisionReason: reason ?? null,
        decidedAt: new Date(),
        assignedToUserId: userId
      },
      { transaction }
    );

    // S5-01: Emit WORKFLOW_TASK_DECIDED audit event
    await writeAuditLog({
      eventType: AUDIT_EVENTS.WORKFLOW_TASK_DECIDED,
      userId,
      actionDetails: { 
        taskId, 
        instanceId: task.workflowInstanceId, 
        decision, 
        reason,
        documentId: instance.documentId
      }
    });

    if (decision === "REJECTED") {
      await WorkflowInstance.update(
        { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason ?? null },
        { where: { id: task.workflowInstanceId }, transaction }
      );
      await Document.update({ status: "REJECTED", approvalStatus: "REJECTED" }, { where: { id: instance.documentId }, transaction });
    } else {
      const nextStage = definitionData.stages.find((s) => s.stageNumber === task.stageNumber + 1);
      if (nextStage) {
        const deadline = calculateDeadline(nextStage.slaDurationHours, nextStage.slaBusinessHoursOnly);
        const nextTask = await WorkflowTask.create(
          {
            tenantId: instance.document.tenantId,
            workflowInstanceId: task.workflowInstanceId,
            stageName: nextStage.name,
            stageNumber: nextStage.stageNumber,
            assignedToRole: nextStage.assignedRole,
            status: "PENDING",
            slaDeadlineAt: deadline.deadline,
            slaWarningAt: deadline.warning
          },
          { transaction }
        );
        await AclEntry.findOrCreate({
          where: {
            resourceType: "workflow_task",
            resourceId: nextTask.id,
            principalType: "role",
            principalId: nextStage.assignedRole,
            permission: "WRITE",
          },
          defaults: {
            tenantId: instance.document.tenantId,
            resourceType: "workflow_task",
            resourceId: nextTask.id,
            principalType: "role",
            principalId: nextStage.assignedRole,
            effect: "ALLOW",
            permission: "WRITE",
            grantedById: userId,
          },
        });
        await WorkflowInstance.update({ currentStage: nextStage.stageNumber }, { where: { id: task.workflowInstanceId }, transaction });
      } else {
        await WorkflowInstance.update(
          { status: "COMPLETED", completedAt: new Date() },
          { where: { id: task.workflowInstanceId }, transaction }
        );
        const docType = await DocumentType.findByPk(instance.document.documentTypeId, { transaction });
        const docStatus = docType?.requiresSignature ? "PENDING_SIGNATURE" : "APPROVED";
        await Document.update(
          { status: docStatus, approvalStatus: "APPROVED" },
          { where: { id: instance.documentId }, transaction }
        );

        // S5-01: Emit WORKFLOW_INSTANCE_COMPLETED audit event
          await writeAuditLog({
            eventType: AUDIT_EVENTS.WORKFLOW_INSTANCE_COMPLETED,
            userId,
            actionDetails: { 
              instanceId: task.workflowInstanceId,
              documentId: instance.documentId,
              finalStatus: docStatus
            }
          });
      }
    }

    return { success: true };
  });
}

function calculateDeadline(hours: number, businessHoursOnly: boolean) {
  const now = moment().tz(config.BUSINESS_TIMEZONE);
  const deadline = businessHoursOnly ? addBusinessHours(now, hours) : now.clone().add(hours, "hours");
  return {
    deadline: deadline.toDate(),
    warning: deadline.clone().subtract(hours * 0.25, "hours").toDate()
  };
}

function addBusinessHours(start: moment.Moment, hours: number): moment.Moment {
  let remaining = hours;
  const current = start.clone();
  while (remaining > 0) {
    current.add(1, "hour");
    const day = current.day();
    const hour = current.hour();
    if (day >= 1 && day <= 5 && hour >= config.BUSINESS_HOURS_START && hour < config.BUSINESS_HOURS_END) {
      remaining--;
    }
  }
  return current;
}

// S5-01: List workflow definitions for tenant
export async function listWorkflowDefinitions(tenantId?: string) {
  const where = tenantId ? { tenantId } : {};
  return WorkflowDefinition.findAll({ where, order: [["name", "ASC"]] });
}

// S5-01: Create workflow definition with audit
// A definition keyed to a document type is picked up through the type's own
// association (startWorkflow), which is NOT tenant-filtered — so a definition
// created in tenant A against tenant B's document type would be run for tenant
// B's documents. The type must belong to the caller's tenant.
async function assertDocumentTypeInTenant(documentTypeId: string | null | undefined, tenantId: string) {
  if (!documentTypeId) return;
  const docType = await DocumentType.findOne({ where: { id: documentTypeId, tenantId }, attributes: ["id"] });
  if (!docType) throw new AppError(422, "ERR-DOCTYPE-NOT-FOUND", "Document type not found in this tenant");
}

export async function createWorkflowDefinition(data: any, userId: string, tenantId: string) {
  const parsed = workflowDefinitionSchema.parse(data);
  await assertDocumentTypeInTenant(parsed.documentTypeId, tenantId);
  const def = await WorkflowDefinition.create({
    name: parsed.name,
    documentTypeId: parsed.documentTypeId ?? null,
    version: parsed.version,
    definition: parsed.definition,
    isDefault: parsed.isDefault ?? false,
    isActive: parsed.isActive ?? true,
    tenantId
  });

  // S5-01: Emit WORKFLOW_DEFINITION_CREATED audit event
    await writeAuditLog({
      eventType: AUDIT_EVENTS.WORKFLOW_DEFINITION_CREATED,
      userId,
      actionDetails: { 
        workflowDefinitionId: def.id,
        name: def.name, 
        version: def.version,
        tenantId
      }
    });

  return def;
}

// Platform audit finding (2026-08-14, HIGH app-layer, follow-up): this had
// no tenantId anywhere — unlike every other function in this file
// (createWorkflowDefinition, listWorkflowDefinitions, listWorkflowInstances,
// etc.), which all thread and filter by it. WORKFLOW_MANAGE is a plain
// per-tenant permission (held by RECORDS_OFFICER, an ordinary role), so
// without this a Tenant A user could update Tenant B's workflow definition
// purely by knowing/guessing its id. workflow_definitions does carry a
// row-level-security policy (migrations/20260703000009-rls-drop-postgres-
// bypass.sql) that would catch this in production specifically (DB_USER is
// the non-superuser edams_app role there) — but the app layer shouldn't rely
// on RLS as the only guard for a check this cheap, especially when every
// sibling function in this same file already enforces it explicitly.
export async function updateWorkflowDefinition(id: string, data: any, userId: string, tenantId: string) {
  const def = await WorkflowDefinition.findOne({ where: { id, tenantId } });
  if (!def) throw new AppError(404, "ERR-WORKFLOW-NOT-FOUND", "Workflow definition not found");

  const parsed = workflowDefinitionSchema.partial().parse(data);
  await assertDocumentTypeInTenant(parsed.documentTypeId, tenantId);
  await def.update(parsed);

  await writeAuditLog({
    eventType: AUDIT_EVENTS.WORKFLOW_UPDATE,
    userId,
    actionDetails: { name: def.name, version: def.version }
  });

  return def;
}

// Platform audit finding (2026-08-14, HIGH app-layer, follow-up): same gap
// as updateWorkflowDefinition above — no tenantId check at all, so a Tenant
// A user could permanently delete Tenant B's workflow definition purely by
// knowing/guessing its id.
export async function deleteWorkflowDefinition(id: string, userId: string, tenantId: string) {
  const def = await WorkflowDefinition.findOne({ where: { id, tenantId } });
  if (!def) throw new AppError(404, "ERR-WORKFLOW-NOT-FOUND", "Workflow definition not found");

  await def.destroy();

  await writeAuditLog({
    eventType: AUDIT_EVENTS.WORKFLOW_DELETE,
    userId,
    actionDetails: { name: def.name, version: def.version }
  });

  return { success: true };
}

// S5-01-3: List workflow instances with filtering
export async function listWorkflowInstances(params: {
  tenantId: string;
  status?: string;
  documentId?: string;
  page: number;
  limit: number;
}) {
  const { tenantId, status, documentId, page, limit } = params;
  const where: any = {};
  
  if (status) where.status = status;
  if (documentId) where.documentId = documentId;

  const { rows, count } = await WorkflowInstance.findAndCountAll({
    where,
    include: [
      {
        model: Document,
        as: "document",
        where: { tenantId },
        attributes: ["id", "filename", "status"]
      },
      {
        model: WorkflowDefinition,
        as: "workflowDefinition",
        attributes: ["id", "name", "version"]
      }
    ],
    limit,
    offset: (page - 1) * limit,
    order: [["createdAt", "DESC"]]
  });

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit)
    }
  };
}

// S5-01-4: Get single workflow instance
export async function getWorkflowInstance(instanceId: string, tenantId: string) {
  const instance = await WorkflowInstance.findByPk(instanceId, {
    include: [
      {
        model: Document,
        as: "document",
        where: { tenantId },
        attributes: ["id", "filename", "status", "approvalStatus"]
      },
      {
        model: WorkflowDefinition,
        as: "workflowDefinition",
        attributes: ["id", "name", "version", "definition"]
      }
    ]
  });

  if (!instance) {
    throw new AppError(404, "ERR-INSTANCE-NOT-FOUND", "Workflow instance not found");
  }

  return instance;
}

// S5-01-5: List tasks for workflow instance
export async function listWorkflowInstanceTasks(instanceId: string, tenantId: string) {
  // First verify the instance belongs to the tenant
  const instance = await WorkflowInstance.findByPk(instanceId, {
    include: [
      {
        model: Document,
        as: "document",
        where: { tenantId },
        attributes: ["id"]
      }
    ]
  });

  if (!instance) {
    throw new AppError(404, "ERR-INSTANCE-NOT-FOUND", "Workflow instance not found");
  }

  const tasks = await WorkflowTask.findAll({
    where: { workflowInstanceId: instanceId },
    order: [["stageNumber", "ASC"], ["createdAt", "ASC"]],
    attributes: [
      "id",
      "stageName",
      "stageNumber",
      "assignedToRole",
      "assignedToUserId",
      "delegatedToUserId",
      "status",
      "decision",
      "decisionReason",
      "decidedAt",
      "slaDeadlineAt",
      "slaWarningAt",
      "isSlaBreach",
      "createdAt"
    ]
  });

  return tasks;
}