import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class RetentionPolicy extends Model<InferAttributes<RetentionPolicy>, InferCreationAttributes<RetentionPolicy>> {
  declare id: CreationOptional<string>;
  declare code: string;
  declare name: string;
  declare retentionYears: number | null;
  declare isPermanent: CreationOptional<boolean>;
  declare triggerEvent: string;
  declare disposalAction: string;
  declare authority: string;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initRetentionPolicy() {
  RetentionPolicy.init(
    {
      id: uuidPk,
      code: { type: DataTypes.STRING(50), unique: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      retentionYears: DataTypes.INTEGER,
      isPermanent: { type: DataTypes.BOOLEAN, defaultValue: false },
      triggerEvent: { type: DataTypes.STRING(100), allowNull: false },
      disposalAction: { type: DataTypes.STRING(100), allowNull: false },
      authority: { type: DataTypes.STRING(500), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "retention_policies", timestamps: true , underscored: true}
  );
}
