import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class UserTenant extends Model<InferAttributes<UserTenant>, InferCreationAttributes<UserTenant>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare tenantId: string;
  declare assignedAt: CreationOptional<Date>;
  declare assignedBy: string | null;
}

export function initUserTenant() {
  UserTenant.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      assignedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      assignedBy: DataTypes.UUID
    },
    { sequelize, tableName: "user_tenants", timestamps: false, underscored: true, indexes: [{ unique: true, fields: ["user_id", "tenant_id"]}] }
  );
}
