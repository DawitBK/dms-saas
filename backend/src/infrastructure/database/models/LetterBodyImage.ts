import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

/** An image inserted directly into a letter's rich-text Body — see
 *  migrations/20260922000001-letter-body-images.sql for why this is a
 *  separate, lighter-weight table from LetterAttachment rather than another
 *  Document row. Not tied to a specific letterId: an image can be uploaded
 *  while composing a letter that hasn't been saved yet (letters/new), so
 *  the association lives one level up, in the letter's own bodyHtml JSON
 *  (an image node's `src` names this row's id) rather than a FK here. */
export class LetterBodyImage extends Model<InferAttributes<LetterBodyImage>, InferCreationAttributes<LetterBodyImage>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare uploadedBy: string;
  declare mimeType: string;
  declare sizeBytes: string;
  declare storageKey: string;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterBodyImage() {
  LetterBodyImage.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      uploadedBy: { type: DataTypes.UUID, allowNull: false, field: "uploaded_by" },
      mimeType: { type: DataTypes.STRING(100), allowNull: false, field: "mime_type" },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: "size_bytes" },
      storageKey: { type: DataTypes.TEXT, allowNull: false, field: "storage_key" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_body_images", timestamps: false, underscored: true }
  );
}
