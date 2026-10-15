import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class WorkflowTask extends Model<InferAttributes<WorkflowTask>, InferCreationAttributes<WorkflowTask>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare workflowInstanceId: string;
  declare stageName: string;
  declare stageNumber: number;
  declare assignedToUserId: string | null;
  declare assignedToRole: string | null;
  declare delegatedToUserId: string | null;
  declare slaDeadlineAt: Date;
  declare slaWarningAt: Date;
  declare status: string;
  declare decision: string | null;
  declare decisionReason: string | null;
  declare decidedAt: Date | null;
  declare slaBreachedAt: Date | null;
  declare escalatedAt: Date | null;
  declare isSlaBreach: CreationOptional<boolean>;
  declare isCritical: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initWorkflowTask() {
  WorkflowTask.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      workflowInstanceId: { type: DataTypes.UUID, allowNull: false },
      stageName: { type: DataTypes.STRING(100), allowNull: false },
      stageNumber: { type: DataTypes.INTEGER, allowNull: false },
      assignedToUserId: DataTypes.UUID,
      assignedToRole: DataTypes.STRING(50),
      delegatedToUserId: DataTypes.UUID,
      slaDeadlineAt: { type: DataTypes.DATE, allowNull: false },
      slaWarningAt: { type: DataTypes.DATE, allowNull: false },
      status: { type: DataTypes.STRING(50), allowNull: false },
      decision: DataTypes.STRING(20),
      decisionReason: DataTypes.STRING(2000),
      decidedAt: DataTypes.DATE,
      slaBreachedAt: DataTypes.DATE,
      escalatedAt: DataTypes.DATE,
      isSlaBreach: { type: DataTypes.BOOLEAN, defaultValue: false },
      isCritical: { type: DataTypes.BOOLEAN, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "workflow_tasks", timestamps: true , underscored: true}
  );
}
