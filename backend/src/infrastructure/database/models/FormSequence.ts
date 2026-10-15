import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

/** Gap-free reference counter for approved form instances.
 *
 *  Mirrors LetterSequence exactly, minus the type segment: forms have one
 *  series per org unit per year, where letters have one per type as well.
 *  Deliberately a SEPARATE table — sharing letter_sequences would let a form
 *  consume a number in the correspondence series (see the migration note). */
export class FormSequence extends Model<InferAttributes<FormSequence>, InferCreationAttributes<FormSequence>> {
  declare tenantId: string;
  declare orgUnitId: string;
  declare year: number;
  declare lastValue: CreationOptional<number>;
}

export function initFormSequence() {
  FormSequence.init(
    {
      tenantId: { type: DataTypes.STRING(100), allowNull: false, primaryKey: true, field: "tenant_id" },
      orgUnitId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: "org_unit_id" },
      year: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
      lastValue: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "last_value" },
    },
    { sequelize, tableName: "form_sequences", timestamps: false, underscored: true }
  );
}
