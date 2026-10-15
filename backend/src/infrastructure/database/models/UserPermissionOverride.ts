import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export type PermissionOverrideEffect = "GRANT" | "REVOKE";

export class UserPermissionOverride extends Model<InferAttributes<UserPermissionOverride>, InferCreationAttributes<UserPermissionOverride>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare userId: string;
  declare permission: string;
  declare effect: PermissionOverrideEffect;
  declare createdAt: CreationOptional<Date>;
}

export function initUserPermissionOverride() {
  UserPermissionOverride.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      permission: { type: DataTypes.STRING(100), allowNull: false },
      effect: { type: DataTypes.STRING(10), allowNull: false },
      createdAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "user_permission_overrides",
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { unique: true, fields: ["tenant_id", "user_id", "permission"] },
        { name: "user_permission_overrides_user_idx", fields: ["tenant_id", "user_id"] }
      ]
    }
  );
}
