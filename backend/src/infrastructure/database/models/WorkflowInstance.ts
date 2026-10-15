import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class WorkflowInstance extends Model<InferAttributes<WorkflowInstance>, InferCreationAttributes<WorkflowInstance>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare documentId: string;
  declare workflowDefinitionId: string;
  declare currentStage: CreationOptional<number>;
  declare status: string;
  declare initiatedById: string;
  declare completedAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initWorkflowInstance() {
  WorkflowInstance.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      documentId: { type: DataTypes.UUID, allowNull: false },
      workflowDefinitionId: { type: DataTypes.UUID, allowNull: false },
      currentStage: { type: DataTypes.INTEGER, defaultValue: 1 },
      status: { type: DataTypes.STRING(50), allowNull: false },
      initiatedById: { type: DataTypes.UUID, allowNull: false },
      completedAt: DataTypes.DATE,
      cancelledAt: DataTypes.DATE,
      cancelReason: DataTypes.STRING(1000),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "workflow_instances", timestamps: true , underscored: true}
  );
}
