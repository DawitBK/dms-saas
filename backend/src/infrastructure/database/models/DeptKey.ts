import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DeptKey extends Model<InferAttributes<DeptKey>, InferCreationAttributes<DeptKey>> {
  declare id: CreationOptional<string>;
  declare departmentId: string;
  declare tenantId: string;
  declare kekReference: string;
  declare createdAt: CreationOptional<Date>;
  declare rotatedAt: Date | null;
  declare updatedAt: CreationOptional<Date>;
}

export function initDeptKey() {
  DeptKey.init(
    {
      id: uuidPk,
      departmentId: { type: DataTypes.UUID, unique: true, allowNull: false },
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      kekReference: { type: DataTypes.STRING(500), allowNull: false },
      createdAt: DataTypes.DATE,
      rotatedAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "dept_keys", timestamps: true , underscored: true}
  );
}
