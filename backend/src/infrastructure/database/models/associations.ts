import { User } from "./User.js";
import { Role } from "./Role.js";
import { UserRole } from "./UserRole.js";
import { AuthSession } from "./AuthSession.js";
import { Department } from "./Department.js";
import { UserDepartment } from "./UserDepartment.js";
import { UserTenant } from "./UserTenant.js";
import { FolderNode } from "./FolderNode.js";
import { DocumentType } from "./DocumentType.js";
import { Document } from "./Document.js";
import { DocumentVersion } from "./DocumentVersion.js";
import { DocumentMetadata } from "./DocumentMetadata.js";
import { DocumentCheckout } from "./DocumentCheckout.js";
import { DocLock } from "./DocLock.js";
import { RetentionPolicy } from "./RetentionPolicy.js";
import { WorkflowDefinition } from "./WorkflowDefinition.js";
import { WorkflowInstance } from "./WorkflowInstance.js";
import { WorkflowTask } from "./WorkflowTask.js";
import { LegalHold } from "./LegalHold.js";
import { DocumentLegalHold } from "./DocumentLegalHold.js";
import { AuditLog } from "./AuditLog.js";
import { OutboxEvent } from "./OutboxEvent.js";
import { Notification } from "./Notification.js";
import { DocumentComment } from "./DocumentComment.js";
import { DocumentDek } from "./DocumentDek.js";
import { DeptKey } from "./DeptKey.js";
import { PurgePending } from "./PurgePending.js";
import { RetentionApplication } from "./RetentionApplication.js";
import { Tenant } from "./Tenant.js";
import { FormTemplate } from "./FormTemplate.js";
import { FormInstance } from "./FormInstance.js";
import { DocumentBundle } from "./DocumentBundle.js";
import { DocumentBundleItem } from "./DocumentBundleItem.js";
import { SignatureRecord } from "./SignatureRecord.js";
import { SignatureRequest } from "./SignatureRequest.js";
import { SignatureRecipient } from "./SignatureRecipient.js";
import { SignatureField } from "./SignatureField.js";
import { OrgUnit } from "./OrgUnit.js";
import { Letter } from "./Letter.js";
import { LetterRevision } from "./LetterRevision.js";
import { LetterApprovalStep } from "./LetterApprovalStep.js";
import { LetterLink } from "./LetterLink.js";
import { LetterDispatch } from "./LetterDispatch.js";
import { LetterAttachment } from "./LetterAttachment.js";
import { ApprovalChainTemplate } from "./ApprovalChainTemplate.js";
import { ApprovalChain } from "./ApprovalChain.js";
import { ApprovalStep } from "./ApprovalStep.js";
import { AuditStageReview } from "./AuditStageReview.js";
import { AccessRule } from "./AccessRule.js";
import { AclEntry } from "./AclEntry.js";
import { CertificateOfDestruction } from "./CertificateOfDestruction.js";

export function associateModels() {
  User.hasMany(UserRole, { foreignKey: "userId", as: "userRoles" });
  UserRole.belongsTo(User, { foreignKey: "userId" });
  Role.hasMany(UserRole, { foreignKey: "roleId" });
  UserRole.belongsTo(Role, { foreignKey: "roleId", as: "role" });

  // Many-to-many: User <-> Role
  User.belongsToMany(Role, { through: UserRole, foreignKey: "userId", otherKey: "roleId", as: "roles" });
  Role.belongsToMany(User, { through: UserRole, foreignKey: "roleId", otherKey: "userId", as: "users" });

  User.hasMany(UserDepartment, { foreignKey: "userId", as: "userDepartments" });
  UserDepartment.belongsTo(User, { foreignKey: "userId" });
  UserDepartment.belongsTo(Department, { foreignKey: "departmentId", as: "department" });

  // Many-to-many: User <-> Department
  User.belongsToMany(Department, { through: UserDepartment, foreignKey: "userId", otherKey: "departmentId", as: "departments" });
  Department.belongsToMany(User, { through: UserDepartment, foreignKey: "departmentId", otherKey: "userId", as: "users" });

  User.hasMany(UserTenant, { foreignKey: "userId", as: "userTenants" });
  UserTenant.belongsTo(User, { foreignKey: "userId", as: "user" });
  UserTenant.belongsTo(Tenant, { foreignKey: "tenantId", as: "tenant" });

  // Many-to-many: User <-> Tenant
  User.belongsToMany(Tenant, { through: UserTenant, foreignKey: "userId", otherKey: "tenantId", as: "tenants" });
  Tenant.belongsToMany(User, { through: UserTenant, foreignKey: "tenantId", otherKey: "userId", as: "members" });

  User.hasMany(AuthSession, { foreignKey: "userId", as: "sessions" });
  AuthSession.belongsTo(User, { foreignKey: "userId", as: "user" });

  Department.hasMany(Document, { foreignKey: "departmentId" });
  Document.belongsTo(Department, { foreignKey: "departmentId", as: "department" });
  DocumentType.hasMany(Document, { foreignKey: "documentTypeId" });
  DocumentType.hasMany(WorkflowDefinition, { foreignKey: "documentTypeId", as: "workflowDefinitions" });
  Document.belongsTo(DocumentType, { foreignKey: "documentTypeId", as: "documentType" });
  User.hasMany(Document, { foreignKey: "ownerId", as: "ownedDocuments" });
  Document.belongsTo(User, { foreignKey: "ownerId", as: "owner" });
  FolderNode.hasMany(Document, { foreignKey: "folderId" });
  Document.belongsTo(FolderNode, { foreignKey: "folderId", as: "folder" });

  Document.hasMany(DocumentVersion, { foreignKey: "documentId", as: "versions" });
  DocumentVersion.belongsTo(Document, { foreignKey: "documentId" });
  Document.hasOne(DocumentMetadata, { foreignKey: "documentId", as: "metadata" });
  DocumentMetadata.belongsTo(Document, { foreignKey: "documentId" });
  Document.hasOne(DocumentCheckout, { foreignKey: "documentId", as: "checkout" });
  DocumentCheckout.belongsTo(Document, { foreignKey: "documentId" });
  Document.hasOne(DocLock, { foreignKey: "documentId", as: "lock" });
  DocLock.belongsTo(Document, { foreignKey: "documentId", as: "document" });

  Document.hasMany(WorkflowInstance, { foreignKey: "documentId", as: "workflowInstances" });
  WorkflowInstance.belongsTo(Document, { foreignKey: "documentId" });
  WorkflowDefinition.hasMany(WorkflowInstance, { foreignKey: "workflowDefinitionId" });
  WorkflowInstance.belongsTo(WorkflowDefinition, { foreignKey: "workflowDefinitionId", as: "workflowDefinition" });
  WorkflowInstance.hasMany(WorkflowTask, { foreignKey: "workflowInstanceId", as: "tasks" });
  WorkflowTask.belongsTo(WorkflowInstance, { foreignKey: "workflowInstanceId", as: "workflowInstance" });
  WorkflowInstance.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  WorkflowTask.belongsTo(User, { foreignKey: "assignedToUserId", as: "assignedTo" });

  Document.hasMany(OutboxEvent, { foreignKey: "documentId", as: "outboxEvents" });
  Document.hasMany(Notification, { foreignKey: "documentId" });
  Document.hasMany(AuditLog, { foreignKey: "documentId" });

  Document.hasMany(DocumentComment, { foreignKey: "documentId", as: "comments" });
  DocumentComment.belongsTo(Document, { foreignKey: "documentId" });
  DocumentComment.belongsTo(User, { foreignKey: "authorId", as: "author" });
  DocumentComment.belongsTo(DocumentComment, { foreignKey: "parentId", as: "parent" });
  User.hasMany(AuditLog, { foreignKey: "userId" });
  // UI gap: the Audit Trail tab fetched userId/userRole per event but had no
  // way to render WHO acted — this association lets the document audit-log
  // endpoint include the actor's name/email in one query.
  AuditLog.belongsTo(User, { foreignKey: "userId", as: "actor" });
  User.hasMany(Notification, { foreignKey: "userId" });
  LegalHold.belongsTo(User, { foreignKey: "appliedById", as: "appliedBy" });
  LegalHold.hasMany(DocumentLegalHold, { foreignKey: "legalHoldId", as: "affectedDocuments" });
  DocumentLegalHold.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  DocumentLegalHold.belongsTo(LegalHold, { foreignKey: "legalHoldId", as: "legalHold" });
  // Governance tab reads doc.legalHolds / doc.signatures — reverse associations
  // so getDocument can include them (gap register #6).
  Document.hasMany(DocumentLegalHold, { foreignKey: "documentId", as: "legalHolds" });
  Document.hasMany(SignatureRecord, { foreignKey: "documentId", as: "signatures" });
  SignatureRecord.belongsTo(Document, { foreignKey: "documentId" });
  SignatureRecord.belongsTo(User, { foreignKey: "signatoryUserId", as: "signatoryUser" });

  // S4-03 associations
  // FIX: one DocumentDek row per VERSION, not per document — a document with
  // several versions has several DEK rows, so this is hasMany, not hasOne.
  Document.hasMany(DocumentDek, { foreignKey: "documentId", as: "deks" });
  DocumentDek.belongsTo(Document, { foreignKey: "documentId" });
  DocumentVersion.hasOne(DocumentDek, { foreignKey: "versionId", as: "dek" });
  DocumentDek.belongsTo(DocumentVersion, { foreignKey: "versionId" });
  Department.hasOne(DeptKey, { foreignKey: "departmentId", as: "deptKey" });
  DeptKey.belongsTo(Department, { foreignKey: "departmentId" });
  Document.hasOne(PurgePending, { foreignKey: "documentId", as: "purgePending" });
  PurgePending.belongsTo(Document, { foreignKey: "documentId" });
  Document.hasMany(RetentionApplication, { foreignKey: "documentId", as: "retentionApplications" });
  // The disposal-warning worker includes this as { as: 'document' } — without
  // the explicit alias its eager load throws once retention rows exist.
  RetentionApplication.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  RetentionApplication.belongsTo(RetentionPolicy, { foreignKey: "policyId", as: "policy" });

  FormTemplate.hasMany(FormInstance, { foreignKey: "templateId", as: "instances" });
  FormInstance.belongsTo(FormTemplate, { foreignKey: "templateId", as: "template" });
  FormInstance.belongsTo(Document, { foreignKey: "documentId", as: "document" });

  DocumentBundle.belongsTo(Document, { foreignKey: "compiledDocumentId", as: "compiledDocument" });
  DocumentBundle.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
  DocumentBundle.hasMany(DocumentBundleItem, { foreignKey: "bundleId", as: "items" });
  DocumentBundleItem.belongsTo(DocumentBundle, { foreignKey: "bundleId", as: "bundle" });
  DocumentBundleItem.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  Document.hasMany(DocumentBundleItem, { foreignKey: "documentId", as: "bundleItems" });

  Document.hasMany(SignatureRequest, { foreignKey: "documentId", as: "signatureRequests" });
  SignatureRequest.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  SignatureRequest.hasMany(SignatureRecipient, { foreignKey: "signatureRequestId", as: "recipients" });
  SignatureRecipient.belongsTo(SignatureRequest, { foreignKey: "signatureRequestId", as: "request" });
  SignatureRequest.hasMany(SignatureField, { foreignKey: "signatureRequestId", as: "fields" });
  // Inverse of the above. Every other pair here declares both directions;
  // this one did not, so a query that starts FROM a field could not join back
  // to its request — which is what resolving a letter's captured signature
  // needs (letters.service.ts, resolveCapturedSignature).
  SignatureField.belongsTo(SignatureRequest, { foreignKey: "signatureRequestId", as: "request" });
  SignatureField.belongsTo(SignatureRecipient, { foreignKey: "recipientId", as: "recipient" });

  // CAMS associations
  OrgUnit.belongsTo(OrgUnit, { foreignKey: "parentUnitId", as: "parentUnit" });
  OrgUnit.hasMany(OrgUnit, { foreignKey: "parentUnitId", as: "childUnits" });
  OrgUnit.hasMany(Department, { foreignKey: "orgUnitId", as: "departments" });
  Department.belongsTo(OrgUnit, { foreignKey: "orgUnitId", as: "orgUnit" });
  OrgUnit.hasMany(Letter, { foreignKey: "orgUnitId", as: "letters" });
  Letter.belongsTo(OrgUnit, { foreignKey: "orgUnitId", as: "orgUnit" });
  Letter.belongsTo(Department, { foreignKey: "departmentId", as: "department" });
  Letter.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  Letter.belongsTo(User, { foreignKey: "createdBy", as: "creator" });
  Letter.belongsTo(User, { foreignKey: "signatoryUserId", as: "signatory" });
  Letter.belongsTo(User, { foreignKey: "assignedToUserId", as: "assignee" });
  Letter.hasMany(LetterRevision, { foreignKey: "letterId", as: "revisions" });
  LetterRevision.belongsTo(Letter, { foreignKey: "letterId" });
  Letter.hasMany(LetterApprovalStep, { foreignKey: "letterId", as: "approvalSteps" });
  LetterApprovalStep.belongsTo(Letter, { foreignKey: "letterId" });
  LetterApprovalStep.belongsTo(User, { foreignKey: "assignedUserId", as: "assignedUser" });
  // Distinct from assignedUser: a role-assigned step (assignedUserId null,
  // assignedRole set — "any DEPT_MANAGER may decide this") only ever showed
  // the generic role afterward, even once a specific, named person actually
  // decided it — decidedBy had no association to resolve to a display name.
  LetterApprovalStep.belongsTo(User, { foreignKey: "decidedBy", as: "decidedByUser" });
  Letter.hasMany(LetterLink, { foreignKey: "letterId", as: "links" });
  LetterLink.belongsTo(Letter, { foreignKey: "letterId", as: "letter" });
  LetterLink.belongsTo(Letter, { foreignKey: "relatedLetterId", as: "relatedLetter" });
  Letter.hasMany(LetterDispatch, { foreignKey: "letterId", as: "dispatches" });
  LetterDispatch.belongsTo(Letter, { foreignKey: "letterId" });
  Letter.hasMany(LetterAttachment, { foreignKey: "letterId", as: "attachments" });
  LetterAttachment.belongsTo(Letter, { foreignKey: "letterId" });
  LetterAttachment.belongsTo(Document, { foreignKey: "documentId", as: "document" });
  LetterAttachment.belongsTo(User, { foreignKey: "uploadedBy", as: "uploader" });

  // ── Unified approval engine (SYSTEM-DECISIONS.md D1–D7) ──────────────────
  ApprovalChainTemplate.belongsTo(DocumentType, { foreignKey: "documentTypeId", as: "documentType" });
  ApprovalChainTemplate.belongsTo(FormTemplate, { foreignKey: "formTemplateId", as: "formTemplate" });
  ApprovalChain.hasMany(ApprovalStep, { foreignKey: "chainId", as: "steps" });
  ApprovalStep.belongsTo(ApprovalChain, { foreignKey: "chainId", as: "chain" });
  ApprovalChain.belongsTo(User, { foreignKey: "submittedBy", as: "submitter" });
  ApprovalStep.belongsTo(User, { foreignKey: "assignedUserId", as: "assignedUser" });
  ApprovalStep.belongsTo(User, { foreignKey: "decidedBy", as: "decider" });
  AuditStageReview.belongsTo(User, { foreignKey: "auditorUserId", as: "auditor" });
  AuditStageReview.belongsTo(User, { foreignKey: "assignedBy", as: "assigner" });

  // "Who did this" associations that were never wired up — each of these
  // *By/*ById columns held a real user id all along, but with no belongsTo
  // to resolve it, every API response could only ever return the bare UUID.
  // Same root cause and fix shape as LetterApprovalStep.decidedByUser above.
  DocumentCheckout.belongsTo(User, { foreignKey: "checkedOutBy", as: "checkedOutByUser" });
  DocLock.belongsTo(User, { foreignKey: "lockedBy", as: "lockedByUser" });
  AccessRule.belongsTo(User, { foreignKey: "grantedById", as: "granter" });
  AclEntry.belongsTo(User, { foreignKey: "grantedById", as: "granter" });
  CertificateOfDestruction.belongsTo(User, { foreignKey: "authorisedById", as: "authorisedBy" });
  DocumentBundleItem.belongsTo(User, { foreignKey: "addedBy", as: "adder" });
  FormTemplate.belongsTo(User, { foreignKey: "approvedBy", as: "approver" });
  LetterDispatch.belongsTo(User, { foreignKey: "dispatchedBy", as: "dispatcher" });
  LetterRevision.belongsTo(User, { foreignKey: "savedBy", as: "author" });
  WorkflowInstance.belongsTo(User, { foreignKey: "initiatedById", as: "initiator" });
}
