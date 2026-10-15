import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class SignatureRequest extends Model<InferAttributes<SignatureRequest>, InferCreationAttributes<SignatureRequest>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare source: 'freeform' | 'form_instance';
  declare orderingMode: 'parallel' | 'serial';
  declare status: 'draft' | 'sent' | 'partially_signed' | 'completed' | 'voided' | 'expired';
  declare completionAction: 'none' | 'move_folder' | 'notify_only';
  declare completionTargetFolderId: string | null;
  declare voidedReason: string | null;
  /** The document version the fields were placed on and that is signed (E23). NULL on historical requests: they use the latest version, as before. */
  declare documentVersionId: string | null;
  /** The version holding the filed signed copy, once filed. */
  declare signedVersionId: string | null;
  declare expiresAt: Date | null;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare completedAt: Date | null;
}

export function initSignatureRequest() {
  SignatureRequest.init(
    {
      id: { ...uuidPk },
      documentId: { type: DataTypes.UUID, allowNull: false, field: "document_id" },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "freeform" },
      orderingMode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "parallel", field: "ordering_mode" },
      status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "draft" },
      completionAction: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "none", field: "completion_action" },
      completionTargetFolderId: { type: DataTypes.UUID, allowNull: true, field: "completion_target_folder_id" },
      voidedReason: { type: DataTypes.TEXT, allowNull: true, field: "voided_reason" },
      documentVersionId: { type: DataTypes.UUID, allowNull: true, field: "document_version_id" },
      signedVersionId: { type: DataTypes.UUID, allowNull: true, field: "signed_version_id" },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: "expires_at" },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: "created_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: "completed_at" },
    },
    { sequelize, tableName: "signature_requests", timestamps: false, underscored: true }
  );
}
