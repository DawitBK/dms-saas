import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

/** Which letters embed which body image (migration 20261004000030). Insert-only: it is what lets the
 *  image endpoint ask "may this user read a letter that uses this image?" instead of checking the
 *  tenant alone (letters audit L13). */
export class LetterBodyImageLink extends Model<InferAttributes<LetterBodyImageLink>, InferCreationAttributes<LetterBodyImageLink>> {
  declare imageId: string;
  declare letterId: string;
  declare tenantId: string;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterBodyImageLink() {
  LetterBodyImageLink.init(
    {
      imageId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: "image_id" },
      letterId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: "letter_id" },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_body_image_links", timestamps: false, underscored: true }
  );
}
