import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class LetterApprovalStep extends Model<InferAttributes<LetterApprovalStep>, InferCreationAttributes<LetterApprovalStep>> {
  declare id: CreationOptional<string>;
  declare letterId: string;
  declare stepOrder: number;
  declare stepType: 'REVIEW' | 'APPROVE';
  declare assignedUserId: string | null;
  declare assignedRole: string | null;
  declare status: CreationOptional<'WAITING' | 'PENDING' | 'APPROVED' | 'RETURNED' | 'CANCELLED'>;
  declare comment: string | null;
  declare decidedBy: string | null;
  declare decidedAt: Date | null;
  declare slaHours: CreationOptional<number | null>;
  declare dueAt: CreationOptional<Date | null>;
  declare slaBreachedAt: CreationOptional<Date | null>;
  declare escalatedAt: CreationOptional<Date | null>;
  declare escalatedToUserIds: CreationOptional<string[]>;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterApprovalStep() {
  LetterApprovalStep.init(
    {
      id: { ...uuidPk },
      letterId: { type: DataTypes.UUID, allowNull: false, field: "letter_id" },
      stepOrder: { type: DataTypes.INTEGER, allowNull: false, field: "step_order" },
      stepType: { type: DataTypes.STRING(10), allowNull: false, field: "step_type" },
      assignedUserId: { type: DataTypes.UUID, allowNull: true, field: "assigned_user_id" },
      assignedRole: { type: DataTypes.TEXT, allowNull: true, field: "assigned_role" },
      status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: "WAITING" },
      comment: { type: DataTypes.TEXT, allowNull: true },
      decidedBy: { type: DataTypes.UUID, allowNull: true, field: "decided_by" },
      decidedAt: { type: DataTypes.DATE, allowNull: true, field: "decided_at" },
      slaHours: { type: DataTypes.INTEGER, allowNull: true, field: "sla_hours" },
      dueAt: { type: DataTypes.DATE, allowNull: true, field: "due_at" },
      slaBreachedAt: { type: DataTypes.DATE, allowNull: true, field: "sla_breached_at" },
      escalatedAt: { type: DataTypes.DATE, allowNull: true, field: "escalated_at" },
      escalatedToUserIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: "escalated_to_user_ids" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_approval_steps", timestamps: false, underscored: true }
  );
}
