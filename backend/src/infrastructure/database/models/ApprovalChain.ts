import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export type ApprovalItemType = "DOCUMENT" | "FORM_TEMPLATE" | "FORM_INSTANCE";
export type ApprovalChainStatus = "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "DECLINED" | "CANCELLED";

/** One submission of an item through the unified approval engine
 *  (SYSTEM-DECISIONS.md D1–D4). A resubmit after DECLINE creates a fresh
 *  chain; REQUEST_CHANGES suspends this one (status CHANGES_REQUESTED) and
 *  resubmission resumes it with a fresh set of steps. */
export class ApprovalChain extends Model<InferAttributes<ApprovalChain>, InferCreationAttributes<ApprovalChain>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare itemType: ApprovalItemType;
  declare itemId: string;
  declare status: CreationOptional<ApprovalChainStatus>;
  declare submittedBy: string;
  declare submittedAt: CreationOptional<Date>;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initApprovalChain() {
  ApprovalChain.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(100), allowNull: false },
      itemType: { type: DataTypes.STRING(20), allowNull: false },
      itemId: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "IN_REVIEW" },
      submittedBy: { type: DataTypes.UUID, allowNull: false },
      submittedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      completedAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: "approval_chains", timestamps: true, underscored: true },
  );
}
