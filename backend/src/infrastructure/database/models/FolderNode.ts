import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class FolderNode extends Model<InferAttributes<FolderNode>, InferCreationAttributes<FolderNode>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare name: string;
  declare path: string;
  declare level: number;
  declare parentId: string | null;
  declare departmentId: string | null;
  declare orgUnitId: string | null;
  declare isSystemManaged: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
}

export function initFolderNode() {
  FolderNode.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      path: { type: DataTypes.STRING(2000), allowNull: false },
      level: { type: DataTypes.INTEGER, allowNull: false },
      parentId: DataTypes.UUID,
      departmentId: DataTypes.UUID,
      orgUnitId: DataTypes.UUID,
      isSystemManaged: { type: DataTypes.BOOLEAN, defaultValue: true },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    // BUG 1 FIX: Removed unique index from model - now using partial unique index via migration
    // The partial index (WHERE is_active = true) allows path reuse for deactivated folders
    { sequelize, tableName: "folder_nodes", timestamps: false, updatedAt: false, underscored: true, indexes: [] }
  );
}
