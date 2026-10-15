import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class WorkflowDefinition extends Model<InferAttributes<WorkflowDefinition>, InferCreationAttributes<WorkflowDefinition>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare name: string;
  declare documentTypeId: string | null;
  declare version: string;
  declare definition: string;
  declare isActive: CreationOptional<boolean>;
  declare isDefault: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initWorkflowDefinition() {
  WorkflowDefinition.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      documentTypeId: DataTypes.UUID,
      version: { type: DataTypes.STRING(20), allowNull: false },
      definition: { type: DataTypes.TEXT, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      isDefault: { type: DataTypes.BOOLEAN, defaultValue: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "workflow_definitions", timestamps: true , underscored: true}
  );
}
