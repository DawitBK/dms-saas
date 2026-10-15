import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class Document extends Model<InferAttributes<Document>, InferCreationAttributes<Document>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare documentName: string;
  declare title: string;
  declare departmentId: string;
  declare documentTypeId: string;
  declare folderId: string | null;
  declare ownerId: string;
  declare organisationUnit: string;
  declare status: string;
  declare approvalStatus: CreationOptional<string>;
  declare securityClassification: string;
  declare sensitivityLabel: CreationOptional<string>; // S4-11: Public | Internal | Confidential | Restricted
  declare retentionClass: string;
  declare documentDate: Date | null;
  declare retentionTriggerDate: Date | null;
  declare disposalEligibleDate: Date | null;
  declare currentVersion: CreationOptional<string>;
  declare latestVersionId: string | null;
  declare source: string;
  declare isOnLegalHold: CreationOptional<boolean>;
  declare archivedAt: Date | null;
  declare ocrStatus: string | null;
  declare ocrConfidenceScore: number | null;
  declare aiSummary: string | null;
  declare aiSuggestedMetadata: Record<string, unknown> | null;
  declare preTrashStatus: string | null;
  declare fullySignedAt: Date | null; // B5 fix: set when an e-signing request on this document completes
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

export function initDocument() {
  Document.init(
    {
      id: uuidPk,
      // documentName's real DB constraint is a composite UNIQUE(tenant_id,
      // document_name) (migration 20260701000001-fix-document-name-tenant-scoped.sql)
      // — different tenants may share a document_name. Sequelize composes a
      // composite unique index from fields that share the same string value
      // here; this was previously a bare `unique: true` on documentName
      // alone, which mismatched the real constraint (inert today since
      // syncDatabase() runs with alter: false, but misleading to anything
      // that introspects the model).
      tenantId: { type: DataTypes.STRING(50), allowNull: false, unique: 'documents_tenant_id_document_name_key' },
      documentName: { type: DataTypes.STRING(255), allowNull: false, unique: 'documents_tenant_id_document_name_key' },
      title: { type: DataTypes.STRING(255), allowNull: false },
      departmentId: { type: DataTypes.UUID, allowNull: false },
      documentTypeId: { type: DataTypes.UUID, allowNull: false },
      folderId: DataTypes.UUID,
      ownerId: { type: DataTypes.UUID, allowNull: false },
      organisationUnit: { type: DataTypes.STRING(100), allowNull: false },
      status: { type: DataTypes.STRING(50), allowNull: false },
      approvalStatus: { type: DataTypes.STRING(50), defaultValue: "NOT_REQUIRED" },
      securityClassification: { type: DataTypes.STRING(20), allowNull: false },
      sensitivityLabel: { type: DataTypes.STRING(20), defaultValue: "Internal" }, // S4-11
      retentionClass: { type: DataTypes.STRING(50), allowNull: false },
      documentDate: DataTypes.DATE,
      retentionTriggerDate: DataTypes.DATE,
      disposalEligibleDate: DataTypes.DATE,
      currentVersion: { type: DataTypes.STRING(10), defaultValue: "1.0" },
      latestVersionId: DataTypes.UUID,
      source: { type: DataTypes.STRING(50), allowNull: false },
      isOnLegalHold: { type: DataTypes.BOOLEAN, defaultValue: false },
      archivedAt: DataTypes.DATE,
      ocrStatus: DataTypes.STRING(50),
      ocrConfidenceScore: DataTypes.FLOAT,
      aiSummary: DataTypes.TEXT,
      aiSuggestedMetadata: DataTypes.JSONB,
      preTrashStatus: { type: DataTypes.STRING(50), field: "pre_trash_status" },
      fullySignedAt: { type: DataTypes.DATE, allowNull: true, field: "fully_signed_at" },
      deletedAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "documents",
      timestamps: true,
      paranoid: false,
      underscored: true,
      indexes: [
        { fields: ["department_id"] },
        { fields: ["document_type_id"] },
        { fields: ["status"] },
        { fields: ["owner_id"] },
        { fields: ["deleted_at"] },
        { fields: ["updated_at"] },
        { fields: ["department_id", "status"] },
        { fields: ["title"], name: "documents_title_idx" }
      ]
    }
  );
}
