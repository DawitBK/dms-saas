import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class LetterLink extends Model<InferAttributes<LetterLink>, InferCreationAttributes<LetterLink>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare letterId: string;
  declare relatedLetterId: string;
  declare linkType: CreationOptional<'REPLY_TO' | 'RELATED' | 'FOLLOW_UP'>;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterLink() {
  LetterLink.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      letterId: { type: DataTypes.UUID, allowNull: false, field: "letter_id" },
      relatedLetterId: { type: DataTypes.UUID, allowNull: false, field: "related_letter_id" },
      linkType: { type: DataTypes.STRING(15), allowNull: false, defaultValue: "RELATED", field: "link_type" },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: "created_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_links", timestamps: false, underscored: true }
  );
}
