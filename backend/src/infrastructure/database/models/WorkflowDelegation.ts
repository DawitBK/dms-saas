import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class WorkflowDelegation extends Model<InferAttributes<WorkflowDelegation>, InferCreationAttributes<WorkflowDelegation>> {
  declare id: CreationOptional<string>;
  declare delegatingUserId: string;
  declare delegateUserId: string;
  declare startDate: Date;
  declare endDate: Date;
  declare reason: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
}

export function initWorkflowDelegation() {
  WorkflowDelegation.init(
    {
      id: uuidPk,
      delegatingUserId: { type: DataTypes.UUID, allowNull: false },
      delegateUserId: { type: DataTypes.UUID, allowNull: false },
      startDate: { type: DataTypes.DATE, allowNull: false },
      endDate: { type: DataTypes.DATE, allowNull: false },
      reason: DataTypes.STRING(500),
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "workflow_delegations", timestamps: false, updatedAt: false , underscored: true}
  );
}
