import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export type ApprovalStepStatus = "WAITING" | "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "DECLINED" | "CANCELLED";

/** Generalized letter_approval_steps: sequential, exactly one PENDING at a
 *  time, assigned to exactly one of a named user or a role (DB CHECK).
 *  `locked` marks template-mandated steps the author could not edit. */
export class ApprovalStep extends Model<InferAttributes<ApprovalStep>, InferCreationAttributes<ApprovalStep>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare chainId: string;
  declare stepOrder: number;
  declare stepType: "REVIEW" | "APPROVE";
  declare assignedUserId: string | null;
  declare assignedRole: string | null;
  declare locked: CreationOptional<boolean>;
  declare slaHours: number | null;
  declare dueAt: Date | null;
  declare slaBreachedAt: CreationOptional<Date | null>;
  // Delegation (migration 20261004000020): the assignee handed the step to someone else.
  declare delegatedBy: CreationOptional<string | null>;
  declare delegatedFromRole: CreationOptional<string | null>;
  declare delegatedAt: CreationOptional<Date | null>;
  declare delegationReason: CreationOptional<string | null>;
  // Escalation: the overdue step escalated; these users may decide it alongside the assignee.
  declare escalatedAt: CreationOptional<Date | null>;
  declare escalatedToUserIds: CreationOptional<string[]>;
  declare status: CreationOptional<ApprovalStepStatus>;
  declare comment: string | null;
  declare decidedBy: string | null;
  declare decidedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initApprovalStep() {
  ApprovalStep.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(100), allowNull: false },
      chainId: { type: DataTypes.UUID, allowNull: false },
      stepOrder: { type: DataTypes.INTEGER, allowNull: false },
      stepType: { type: DataTypes.STRING(10), allowNull: false },
      assignedUserId: DataTypes.UUID,
      assignedRole: DataTypes.STRING(100),
      locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      slaHours: DataTypes.INTEGER,
      dueAt: DataTypes.DATE,
      slaBreachedAt: { type: DataTypes.DATE, allowNull: true },
      delegatedBy: { type: DataTypes.UUID, allowNull: true },
      delegatedFromRole: { type: DataTypes.STRING(100), allowNull: true },
      delegatedAt: { type: DataTypes.DATE, allowNull: true },
      delegationReason: { type: DataTypes.TEXT, allowNull: true },
      escalatedAt: { type: DataTypes.DATE, allowNull: true },
      escalatedToUserIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "WAITING" },
      comment: DataTypes.TEXT,
      decidedBy: DataTypes.UUID,
      decidedAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
    },
    { sequelize, tableName: "approval_steps", timestamps: false, underscored: true },
  );
}
