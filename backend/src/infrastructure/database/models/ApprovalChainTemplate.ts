import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

/** One step of an admin-defined chain template (stored as JSONB).
 *  `locked: true` steps cannot be removed/changed by the author at submit
 *  (SYSTEM-DECISIONS.md D1). */
export type ApprovalTemplateStep = {
  stepOrder: number;
  stepType: "REVIEW" | "APPROVE";
  assignedRole?: string | null;
  assignedUserId?: string | null;
  locked?: boolean;
  slaHours?: number | null;
};

export class ApprovalChainTemplate extends Model<InferAttributes<ApprovalChainTemplate>, InferCreationAttributes<ApprovalChainTemplate>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare documentTypeId: string | null;
  declare formTemplateId: string | null;
  // Scope of the recipe (migration 20261004000020): department / org unit it applies to; both null = tenant-wide.
  declare departmentId: CreationOptional<string | null>;
  declare orgUnitId: CreationOptional<string | null>;
  // True = the recipe used to approve FORM TEMPLATES themselves (no document type / form template target).
  declare forFormTemplates: CreationOptional<boolean>;
  declare name: string;
  declare steps: ApprovalTemplateStep[];
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initApprovalChainTemplate() {
  ApprovalChainTemplate.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(100), allowNull: false },
      documentTypeId: DataTypes.UUID,
      formTemplateId: DataTypes.UUID,
      departmentId: DataTypes.UUID,
      orgUnitId: DataTypes.UUID,
      forFormTemplates: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      steps: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: "approval_chain_templates", timestamps: true, underscored: true },
  );
}
