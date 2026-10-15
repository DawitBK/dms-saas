import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class LetterRevision extends Model<InferAttributes<LetterRevision>, InferCreationAttributes<LetterRevision>> {
  declare id: CreationOptional<string>;
  declare letterId: string;
  declare revisionNo: number;
  declare subject: string;
  declare bodyHtml: string | null;
  declare savedBy: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterRevision() {
  LetterRevision.init(
    {
      id: { ...uuidPk },
      letterId: { type: DataTypes.UUID, allowNull: false, field: "letter_id" },
      revisionNo: { type: DataTypes.INTEGER, allowNull: false, field: "revision_no" },
      subject: { type: DataTypes.TEXT, allowNull: false },
      bodyHtml: { type: DataTypes.TEXT, allowNull: true, field: "body_html" },
      savedBy: { type: DataTypes.UUID, allowNull: true, field: "saved_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_revisions", timestamps: false, underscored: true }
  );
}
