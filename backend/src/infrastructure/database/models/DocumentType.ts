import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentType extends Model<InferAttributes<DocumentType>, InferCreationAttributes<DocumentType>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare code: string;
  declare name: string;
  // Tri-level scope, in order of precedence: departmentId set = DEPARTMENT
  // (this one department only); else orgUnitId set = ORG_UNIT (every
  // department under that org unit); both null = TENANT (global). A row is
  // never both department- and org-unit-scoped at once (DB CHECK
  // document_types_not_both_dept_and_org_unit) -- a department-scoped type's
  // org unit is already reachable via department.orgUnitId.
  declare departmentId: string | null; // Phase 3: NULL = global, non-NULL = department-scoped
  declare orgUnitId: string | null;
  declare defaultRetentionClass: string;
  declare requiresSignature: CreationOptional<boolean>;
  declare signatoryRole: string | null;
  // Per-type governance policies (SYSTEM-DECISIONS.md D2/D5/D8)
  declare auditPolicy: CreationOptional<"required" | "optional" | "never">;
  declare signingPolicy: CreationOptional<"none" | "ceremony">;
  declare reapprovalPolicy: CreationOptional<"none" | "major_versions" | "all_changes">;
  // When false, a document of this type may be published/discarded directly
  // from DRAFT by its owner (see documents.service.ts's publishDraft),
  // bypassing the approval chain entirely instead of falling back to a
  // hardcoded single-step DEPT_MANAGER chain. Defaults to true so every
  // existing document type keeps requiring approval unless an admin opts it
  // out.
  declare requiresApproval: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
}

export function initDocumentType() {
  DocumentType.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      code: { type: DataTypes.STRING(10), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      departmentId: DataTypes.UUID, // Phase 3: NULL = global, non-NULL = department-scoped
      orgUnitId: DataTypes.UUID,
      defaultRetentionClass: { type: DataTypes.STRING(50), allowNull: false },
      requiresSignature: { type: DataTypes.BOOLEAN, defaultValue: false },
      signatoryRole: DataTypes.STRING(100),
      auditPolicy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "never" },
      signingPolicy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "none" },
      reapprovalPolicy: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "none" },
      requiresApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "document_types", timestamps: false, updatedAt: false, underscored: true, indexes: [{ unique: true, fields: ["tenant_id", "code"] }] }
  );
}
