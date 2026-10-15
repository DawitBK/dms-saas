// SPRINT-5 (S5-01): Full CRUD + ACL wiring for workflow endpoints
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { requireACL } from "../../shared/resolveACL.js";
import { PERMISSIONS } from "../../config/permissions.js";
import {
  startWorkflow,
  processTaskDecision,
  listWorkflowDefinitions,
  createWorkflowDefinition,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  listWorkflowInstances,
  getWorkflowInstance,
  listWorkflowInstanceTasks
} from "./workflow.service.js";
import { Op } from "sequelize";
import { Document, WorkflowInstance, WorkflowTask } from "../../infrastructure/database/index.js";

export const workflowRoutes = Router();

// S5-01-1: GET /workflow/definitions — list all workflow definitions for tenant
workflowRoutes.get("/definitions", requirePermission(PERMISSIONS.WORKFLOW_READ), asyncHandler(async (req, res) => {
  const definitions = await listWorkflowDefinitions(req.user!.tenantId);
  res.json({ data: definitions });
}));

// S5-01-2: POST /workflow/definitions — create workflow definition
workflowRoutes.post("/definitions", requirePermission(PERMISSIONS.WORKFLOW_MANAGE), asyncHandler(async (req, res) => {
  const definition = await createWorkflowDefinition(req.body, req.user!.userId, req.user!.tenantId);
  res.status(201).json({ data: definition });
}));

workflowRoutes.patch("/definitions/:id", requirePermission(PERMISSIONS.WORKFLOW_MANAGE), asyncHandler(async (req, res) => {
  res.json(await updateWorkflowDefinition(String(req.params.id), req.body, req.user!.userId, req.user!.tenantId));
}));

workflowRoutes.delete("/definitions/:id", requirePermission(PERMISSIONS.WORKFLOW_MANAGE), asyncHandler(async (req, res) => {
  res.json(await deleteWorkflowDefinition(String(req.params.id), req.user!.userId, req.user!.tenantId));
}));

// S5-01-3: GET /workflow/instances — list running instances for tenant
workflowRoutes.get("/instances", requirePermission(PERMISSIONS.WORKFLOW_READ), asyncHandler(async (req, res) => {
  const { status, documentId, page = "1", limit = "50" } = req.query;
  const instances = await listWorkflowInstances({
    tenantId: req.user!.tenantId,
    status: status as string | undefined,
    documentId: documentId as string | undefined,
    page: parseInt(page as string, 10),
    limit: parseInt(limit as string, 10)
  });
  res.json(instances);
}));

// S5-01-4: GET /workflow/instances/:instanceId — get single instance
workflowRoutes.get("/instances/:instanceId", requirePermission(PERMISSIONS.WORKFLOW_READ), asyncHandler(async (req, res) => {
  const instance = await getWorkflowInstance(String(req.params.instanceId), req.user!.tenantId);
  res.json({ data: instance });
}));

// S5-01-5: GET /workflow/instances/:instanceId/tasks — list tasks for instance
workflowRoutes.get("/instances/:instanceId/tasks", requirePermission(PERMISSIONS.WORKFLOW_READ), asyncHandler(async (req, res) => {
  const tasks = await listWorkflowInstanceTasks(String(req.params.instanceId), req.user!.tenantId);
  res.json({ data: tasks });
}));

// S5-01-6: POST /workflow/instances/:instanceId/tasks/:taskId/decide — approve/reject with ACL
workflowRoutes.post(
  "/instances/:instanceId/tasks/:taskId/decide",
  requirePermission(PERMISSIONS.WORKFLOW_APPROVE),
  requireACL({ resourceType: "workflow_task", permission: "WRITE", paramName: "taskId" }),
  asyncHandler(async (req, res) => {
    const { decision, comment } = req.body as { decision: "APPROVED" | "REJECTED"; comment?: string };
    const result = await processTaskDecision(
      String(req.params.taskId),
      req.user!.userId,
      decision,
      comment,
      req.user!.tenantId,
      req.user!.roles
    );
    res.json({ data: result });
  })
);

// GET /workflow/tasks — flat list of pending tasks for current user/role
workflowRoutes.get(
  "/tasks",
  requirePermission(PERMISSIONS.WORKFLOW_READ),
  asyncHandler(async (req, res) => {
    const { page = "1", limit = "50", status } = req.query;
    const { userId, roles, tenantId } = req.user!;

    const taskStatus = (status as string) || "PENDING";
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10)));

    const tasks = await WorkflowTask.findAndCountAll({
      where: {
        tenantId,
        status: taskStatus,
        [Op.or]: [
          { assignedToUserId: userId },
          { assignedToRole: { [Op.in]: roles } },
        ],
      },
      include: [
        {
          model: WorkflowInstance,
          as: "workflowInstance",
          include: [
            {
              model: Document,
              as: "document",
              attributes: ["id", "title", "documentName", "status", "approvalStatus"],
            },
          ],
        },
      ],
      order: [["slaDeadlineAt", "ASC NULLS LAST"]],
      limit: pageSize,
      offset: (pageNum - 1) * pageSize,
    });

    res.json({
      data: tasks.rows,
      total: tasks.count,
      page: pageNum,
      limit: pageSize,
    });
  })
);

// S3-W: POST /workflow/tasks/:taskId/decide — requires workflow:approve permission + ACL (legacy endpoint)
workflowRoutes.post(
  "/tasks/:taskId/decide",
  requirePermission(PERMISSIONS.WORKFLOW_APPROVE),
  requireACL({ resourceType: "workflow_task", permission: "WRITE", paramName: "taskId" }),
  asyncHandler(async (req, res) => {
    const { decision, reason } = req.body as { decision: "APPROVE" | "REJECT"; reason?: string };
    const mappedDecision = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const result = await processTaskDecision(String(req.params.taskId), req.user!.userId, mappedDecision, reason, req.user!.tenantId, req.user!.roles);
    res.json({ data: result });
  })
);

// S3-W: POST /documents/:id/workflow/start — requires workflow:manage permission + ACL on document
workflowRoutes.post(
  "/documents/:id/workflow/start",
  requirePermission(PERMISSIONS.WORKFLOW_MANAGE),
  requireACL({ resourceType: "document", permission: "document:upload" }),
  asyncHandler(async (req, res) => {
    const instance = await startWorkflow(String(req.params.id), req.user!.userId);
    res.status(201).json({ data: instance });
  })
);
