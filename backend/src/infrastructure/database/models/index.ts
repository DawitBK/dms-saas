import { sequelize } from "../sequelize.js";
import { associateModels } from "./associations.js";

import { User, initUser } from "./User.js";
import { Role, initRole } from "./Role.js";
import { UserRole, initUserRole } from "./UserRole.js";
import { AuthSession, initAuthSession } from "./AuthSession.js";
import { Department, initDepartment } from "./Department.js";
import { UserDepartment, initUserDepartment } from "./UserDepartment.js";
import { UserTenant, initUserTenant } from "./UserTenant.js";
import { UserSessionCutoff, initUserSessionCutoff } from "./UserSessionCutoff.js";
import { WorkerHeartbeat, initWorkerHeartbeat } from "./WorkerHeartbeat.js";
import { FolderNode, initFolderNode } from "./FolderNode.js";
import { DocumentType, initDocumentType } from "./DocumentType.js";
import { Document, initDocument } from "./Document.js";
import { DocumentSequence, initDocumentSequence } from "./DocumentSequence.js";
import { DocumentVersion, initDocumentVersion } from "./DocumentVersion.js";
import { DocumentMetadata, initDocumentMetadata } from "./DocumentMetadata.js";
import { DocumentCheckout, initDocumentCheckout } from "./DocumentCheckout.js";
import { DocLock, initDocLock } from "./DocLock.js";
import { RetentionPolicy, initRetentionPolicy } from "./RetentionPolicy.js";
import { WorkflowDefinition, initWorkflowDefinition } from "./WorkflowDefinition.js";
import { WorkflowInstance, initWorkflowInstance } from "./WorkflowInstance.js";
import { WorkflowTask, initWorkflowTask } from "./WorkflowTask.js";
import { WorkflowDelegation, initWorkflowDelegation } from "./WorkflowDelegation.js";
import { SignatureRecord, initSignatureRecord } from "./SignatureRecord.js";
import { LegalHold, initLegalHold } from "./LegalHold.js";
import { DocumentLegalHold, initDocumentLegalHold } from "./DocumentLegalHold.js";
import { ArchiveRecord, initArchiveRecord } from "./ArchiveRecord.js";
import { CertificateOfDestruction, initCertificateOfDestruction } from "./CertificateOfDestruction.js";
import { AuditLog, initAuditLog } from "./AuditLog.js";
import { OutboxEvent, initOutboxEvent } from "./OutboxEvent.js";
import { Notification, initNotification } from "./Notification.js";
import { DocumentComment, initDocumentComment } from "./DocumentComment.js";
import { SavedSearch, initSavedSearch } from "./SavedSearch.js";
import { IdempotencyKey, initIdempotencyKey } from "./IdempotencyKey.js";
import {
  AclEntry,
  initAclEntry,
  ACL_RESOURCE_TYPES,
  ACL_PRINCIPAL_TYPES,
  ACL_EFFECTS,
  type AclResourceType,
  type AclPrincipalType,
  type AclEffect
} from "./AclEntry.js";
import { AccessRule, initAccessRule } from "./AccessRule.js";
import { RolePermission, initRolePermission } from "./RolePermission.js";
import { DocumentStatusActionRole, initDocumentStatusActionRole } from "./DocumentStatusActionRole.js";
import { UserPermissionOverride, initUserPermissionOverride } from "./UserPermissionOverride.js";
import { DocumentDek, initDocumentDek } from "./DocumentDek.js";
import { DeptKey, initDeptKey } from "./DeptKey.js";
import { PurgePending, initPurgePending } from "./PurgePending.js";
import { RetentionApplication, initRetentionApplication } from "./RetentionApplication.js";
import { WebhookSubscription, initWebhookSubscription } from "./WebhookSubscription.js";
import { Tenant, initTenant } from "./Tenant.js";
import { SignatureRequest, initSignatureRequest } from "./SignatureRequest.js";
import { SignatureRecipient, initSignatureRecipient } from "./SignatureRecipient.js";
import { SignatureField, initSignatureField } from "./SignatureField.js";
import { FormTemplate, initFormTemplate } from "./FormTemplate.js";
import { FormInstance, initFormInstance } from "./FormInstance.js";
import { DocumentBundle, initDocumentBundle } from "./DocumentBundle.js";
import { DocumentBundleItem, initDocumentBundleItem } from "./DocumentBundleItem.js";
import { OrgUnit, initOrgUnit } from "./OrgUnit.js";
import { Letter, initLetter } from "./Letter.js";
import { LetterSequence, initLetterSequence } from "./LetterSequence.js";
import { FormSequence, initFormSequence } from "./FormSequence.js";
import { LetterRevision, initLetterRevision } from "./LetterRevision.js";
import { LetterApprovalStep, initLetterApprovalStep } from "./LetterApprovalStep.js";
import { LetterLink, initLetterLink } from "./LetterLink.js";
import { LetterDispatch, initLetterDispatch } from "./LetterDispatch.js";
import { LetterAttachment, initLetterAttachment } from "./LetterAttachment.js";
import { LetterBodyImage, initLetterBodyImage } from "./LetterBodyImage.js";
import { LetterBodyImageLink, initLetterBodyImageLink } from "./LetterBodyImageLink.js";
import { ApprovalChainTemplate, initApprovalChainTemplate, type ApprovalTemplateStep } from "./ApprovalChainTemplate.js";
import { ApprovalChain, initApprovalChain, type ApprovalItemType, type ApprovalChainStatus } from "./ApprovalChain.js";
import { ApprovalStep, initApprovalStep, type ApprovalStepStatus } from "./ApprovalStep.js";
import { AuditStageReview, initAuditStageReview } from "./AuditStageReview.js";

export {
  User,
  Role,
  UserRole,
  AuthSession,
  Department,
  UserDepartment,
  UserTenant,
  UserSessionCutoff,
  WorkerHeartbeat,
  FolderNode,
  DocumentType,
  Document,
  DocumentSequence,
  DocumentVersion,
  DocumentMetadata,
  DocumentCheckout,
  DocLock,
  RetentionPolicy,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTask,
  WorkflowDelegation,
  SignatureRecord,
  LegalHold,
  DocumentLegalHold,
  ArchiveRecord,
  CertificateOfDestruction,
  AuditLog,
  OutboxEvent,
  Notification,
  DocumentComment,
  SavedSearch,
  IdempotencyKey,
  AclEntry,
  ACL_RESOURCE_TYPES,
  ACL_PRINCIPAL_TYPES,
  ACL_EFFECTS,
  type AclResourceType,
  type AclPrincipalType,
  type AclEffect,
  AccessRule,
  RolePermission,
  DocumentStatusActionRole,
  UserPermissionOverride,
  DocumentDek,
  DeptKey,
  PurgePending,
  RetentionApplication,
  WebhookSubscription,
  Tenant,
  SignatureRequest,
  SignatureRecipient,
  SignatureField,
  FormTemplate,
  FormInstance,
  DocumentBundle,
  DocumentBundleItem,
  OrgUnit,
  Letter,
  LetterSequence,
  FormSequence,
  LetterRevision,
  LetterApprovalStep,
  LetterLink,
  LetterDispatch,
  LetterAttachment,
  LetterBodyImage,
  LetterBodyImageLink,
  ApprovalChainTemplate,
  ApprovalChain,
  ApprovalStep,
  AuditStageReview,
  type ApprovalTemplateStep,
  type ApprovalItemType,
  type ApprovalChainStatus,
  type ApprovalStepStatus
};

let modelsInitialized = false;

export function initModels() {
  if (modelsInitialized) return;
  modelsInitialized = true;

  initUser();
  initRole();
  initUserRole();
  initAuthSession();
  initDepartment();
  initUserDepartment();
  initUserTenant();
  initUserSessionCutoff();
  initWorkerHeartbeat();
  initFolderNode();
  initDocumentType();
  initDocument();
  initDocumentSequence();
  initDocumentVersion();
  initDocumentMetadata();
  initDocumentCheckout();
  initDocLock();
  initRetentionPolicy();
  initWorkflowDefinition();
  initWorkflowInstance();
  initWorkflowTask();
  initWorkflowDelegation();
  initSignatureRecord();
  initLegalHold();
  initDocumentLegalHold();
  initArchiveRecord();
  initCertificateOfDestruction();
  initAuditLog();
  initOutboxEvent();
  initNotification();
  initDocumentComment();
  initSavedSearch();
  initIdempotencyKey();
  initAclEntry();
  initAccessRule();
  initRolePermission();
  initDocumentStatusActionRole();
  initUserPermissionOverride();
  initDocumentDek();
  initDeptKey();
  initPurgePending();
  initRetentionApplication();
  initWebhookSubscription();
  initTenant();
  initFormTemplate();
  initFormInstance();
  initSignatureRequest();
  initSignatureRecipient();
  initSignatureField();
  initDocumentBundle();
  initDocumentBundleItem();
  initOrgUnit();
  initLetter();
  initLetterSequence();
  initFormSequence();
  initLetterRevision();
  initLetterApprovalStep();
  initLetterLink();
  initLetterDispatch();
  initLetterAttachment();
  initLetterBodyImage();
  initLetterBodyImageLink();
  initApprovalChainTemplate();
  initApprovalChain();
  initApprovalStep();
  initAuditStageReview();

  associateModels();
}

export const db = {
  sequelize,
  User,
  Role,
  UserRole,
  AuthSession,
  Department,
  UserDepartment,
  FolderNode,
  DocumentType,
  Document,
  DocumentSequence,
  DocumentVersion,
  DocumentMetadata,
  DocumentCheckout,
  DocLock,
  RetentionPolicy,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTask,
  WorkflowDelegation,
  SignatureRecord,
  LegalHold,
  DocumentLegalHold,
  ArchiveRecord,
  CertificateOfDestruction,
  AuditLog,
  OutboxEvent,
  Notification,
  DocumentComment,
  SavedSearch,
  IdempotencyKey,
  AclEntry,
  DocumentDek,
  DeptKey,
  PurgePending,
  RetentionApplication,
  WebhookSubscription,
  Tenant,
  FormTemplate,
  FormInstance,
  DocumentBundle,
  DocumentBundleItem,
  SignatureRequest,
  SignatureRecipient,
  SignatureField,
  OrgUnit,
  Letter,
  LetterSequence,
  LetterRevision,
  LetterApprovalStep,
  LetterLink,
  LetterDispatch,
  LetterAttachment,
  LetterBodyImage,
  LetterBodyImageLink,
  ApprovalChainTemplate,
  ApprovalChain,
  ApprovalStep,
  AuditStageReview,
};
