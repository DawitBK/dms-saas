import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class Department extends Model<InferAttributes<Department>, InferCreationAttributes<Department>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare orgUnitId: string;
  declare code: string;
  declare name: string;
  declare description: string | null;
  declare parentId: string | null;
  declare path: string | null;
  declare level: number | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initDepartment() {
  Department.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      orgUnitId: { type: DataTypes.UUID, allowNull: false, field: "org_unit_id" },
      code: { type: DataTypes.STRING(10), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: DataTypes.STRING(1000),
      parentId: { type: DataTypes.UUID, field: "parent_id" },
      path: { type: DataTypes.STRING, field: "path" },
      level: { type: DataTypes.INTEGER, field: "level" },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "departments",
      timestamps: true,
      underscored: true,
      indexes: [
        // Scoped to org_unit_id (not just tenant_id) since migration
        // 20260912000001 -- see that migration for why codes only need to be
        // unique within their own org unit, not tenant-wide.
        { unique: true, fields: ["tenant_id", "org_unit_id", "code"] },
        { fields: ["parent_id"] },
        { fields: ["org_unit_id"] },
        { fields: ["path"], using: "gist" }
      ]
    }
  );
}
