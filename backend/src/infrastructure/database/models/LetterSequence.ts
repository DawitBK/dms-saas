import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

export class LetterSequence extends Model<InferAttributes<LetterSequence>, InferCreationAttributes<LetterSequence>> {
  declare tenantId: string;
  declare orgUnitId: string;
  declare letterType: string;
  declare year: number;
  declare lastValue: CreationOptional<number>;
}

export function initLetterSequence() {
  LetterSequence.init(
    {
      tenantId: { type: DataTypes.STRING(100), allowNull: false, primaryKey: true, field: "tenant_id" },
      orgUnitId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: "org_unit_id" },
      letterType: { type: DataTypes.TEXT, allowNull: false, primaryKey: true, field: "letter_type" },
      year: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
      lastValue: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "last_value" },
    },
    { sequelize, tableName: "letter_sequences", timestamps: false, underscored: true }
  );
}
