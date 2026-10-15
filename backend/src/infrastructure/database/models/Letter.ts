import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class Letter extends Model<InferAttributes<Letter>, InferCreationAttributes<Letter>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare direction: 'OUTGOING' | 'INCOMING';
  declare status: CreationOptional<'DRAFT' | 'IN_REVIEW' | 'RETURNED' | 'PENDING_SIGNATURE' | 'APPROVED' | 'DISPATCHED' | 'RECEIVED' | 'RESPONDED' | 'CLOSED' | 'ARCHIVED' | 'CANCELLED'>;
  declare referenceNumber: string | null;
  declare orgUnitId: string;
  declare departmentId: string | null;
  declare letterType: CreationOptional<'OUT' | 'IN' | 'MEMO' | 'CIRC' | 'CONT'>;
  declare originType: 'COMPOSED' | 'SCANNED' | null;
  declare subject: string;
  declare bodyHtml: string | null;
  declare language: CreationOptional<string>;
  declare confidentiality: CreationOptional<'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'>;
  declare priority: CreationOptional<'NORMAL' | 'HIGH' | 'URGENT'>;
  declare correspondent: string | null;
  declare correspondentOrganization: string | null;
  declare correspondentLocation: string | null;
  declare correspondentEmail: string | null;
  declare receivedDate: string | null;
  declare dueDate: string | null;
  declare assignedToUserId: string | null;
  /** Explicit signatory choice captured at submit time (the "who signs this
   *  letter" picker) — exactly one set, or both null to keep the default
   *  behavior (the final approver becomes the signer). Resolved by
   *  enterPendingSignatureInTx once the chain reaches its last APPROVE step;
   *  distinct from signatoryUserId below, which only records who actually
   *  ended up signing, after the fact. */
  declare assignedSignatoryUserId: string | null;
  declare assignedSignatoryRole: string | null;
  declare signatoryUserId: string | null;
  declare signatoryName: string | null;
  declare signatoryTitle: string | null;
  declare approvedAt: Date | null;
  declare documentId: string | null;
  declare attachmentDocumentId: string | null;
  declare coverSheetDocumentId: string | null;
  /** Durable link to the unnumbered signable-draft document that actually
   *  received the e-signature — kept even after `documentId` is overwritten
   *  with the final numbered artifact once signing completes. Null for
   *  letters that never went through a signing ceremony. */
  declare signedDraftDocumentId: string | null;
  declare documentHash: string | null;
  declare qrPayload: string | null;
  declare year: number | null;
  declare createdBy: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initLetter() {
  Letter.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      direction: { type: DataTypes.STRING(10), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DRAFT" },
      referenceNumber: { type: DataTypes.TEXT, allowNull: true, field: "reference_number" },
      orgUnitId: { type: DataTypes.UUID, allowNull: false, field: "org_unit_id" },
      departmentId: { type: DataTypes.UUID, allowNull: true, field: "department_id" },
      letterType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "OUT", field: "letter_type" },
      originType: { type: DataTypes.STRING(10), allowNull: true, field: "origin_type" },
      subject: { type: DataTypes.TEXT, allowNull: false },
      bodyHtml: { type: DataTypes.TEXT, allowNull: true, field: "body_html" },
      language: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "en" },
      confidentiality: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "INTERNAL" },
      priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "NORMAL" },
      correspondent: { type: DataTypes.TEXT, allowNull: true },
      correspondentOrganization: { type: DataTypes.TEXT, allowNull: true, field: "correspondent_organization" },
      correspondentLocation: { type: DataTypes.TEXT, allowNull: true, field: "correspondent_location" },
      correspondentEmail: { type: DataTypes.TEXT, allowNull: true, field: "correspondent_email" },
      receivedDate: { type: DataTypes.DATEONLY, allowNull: true, field: "received_date" },
      dueDate: { type: DataTypes.DATEONLY, allowNull: true, field: "due_date" },
      assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: "assigned_to_user_id" },
      assignedSignatoryUserId: { type: DataTypes.UUID, allowNull: true, field: "assigned_signatory_user_id" },
      assignedSignatoryRole: { type: DataTypes.STRING(64), allowNull: true, field: "assigned_signatory_role" },
      signatoryUserId: { type: DataTypes.UUID, allowNull: true, field: "signatory_user_id" },
      signatoryName: { type: DataTypes.TEXT, allowNull: true, field: "signatory_name" },
      signatoryTitle: { type: DataTypes.TEXT, allowNull: true, field: "signatory_title" },
      approvedAt: { type: DataTypes.DATE, allowNull: true, field: "approved_at" },
      documentId: { type: DataTypes.UUID, allowNull: true, field: "document_id" },
      attachmentDocumentId: { type: DataTypes.UUID, allowNull: true, field: "attachment_document_id" },
      coverSheetDocumentId: { type: DataTypes.UUID, allowNull: true, field: "cover_sheet_document_id" },
      signedDraftDocumentId: { type: DataTypes.UUID, allowNull: true, field: "signed_draft_document_id" },
      documentHash: { type: DataTypes.TEXT, allowNull: true, field: "document_hash" },
      qrPayload: { type: DataTypes.TEXT, allowNull: true, field: "qr_payload" },
      year: { type: DataTypes.INTEGER, allowNull: true },
      createdBy: { type: DataTypes.UUID, allowNull: false, field: "created_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, field: "updated_at" },
    },
    { sequelize, tableName: "letters", timestamps: true, underscored: true }
  );
}
