import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class RolePermission extends Model<InferAttributes<RolePermission>, InferCreationAttributes<RolePermission>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare roleId: string;
  declare permission: string;
  declare createdAt: CreationOptional<Date>;
}

export function initRolePermission() {
  RolePermission.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      roleId: { type: DataTypes.UUID, allowNull: false },
      permission: { type: DataTypes.STRING(100), allowNull: false },
      createdAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "role_permissions",
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { unique: true, fields: ["tenant_id", "role_id", "permission"] },
        { name: "role_permissions_role_idx", fields: ["tenant_id", "role_id"] }
      ]
    }
  );
}
