import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class UserRole extends Model<InferAttributes<UserRole>, InferCreationAttributes<UserRole>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare roleId: string;
  declare assignedAt: CreationOptional<Date>;
  declare assignedBy: string | null;
}

export function initUserRole() {
  UserRole.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      roleId: { type: DataTypes.UUID, allowNull: false },
      assignedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      assignedBy: DataTypes.UUID
    },
    { sequelize, tableName: "user_roles", timestamps: false, underscored: true, indexes: [{ unique: true, fields: ["user_id", "role_id"]}] }
  );
}
