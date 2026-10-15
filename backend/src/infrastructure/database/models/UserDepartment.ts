import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class UserDepartment extends Model<InferAttributes<UserDepartment>, InferCreationAttributes<UserDepartment>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare departmentId: string;
  declare assignedAt: CreationOptional<Date>;
}

export function initUserDepartment() {
  UserDepartment.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      departmentId: { type: DataTypes.UUID, allowNull: false },
      assignedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "user_departments", timestamps: false, underscored: true, indexes: [{ unique: true, fields: ["user_id", "department_id"]}] }
  );
}
