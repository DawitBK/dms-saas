import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

/** A supplementary file attached to a letter alongside its composed body or
 *  scanned original — e.g. "please find attached the invoice" on a composed
 *  outgoing letter. Distinct from Letter.attachmentDocumentId (the SCANNED
 *  origin's single staged/final content document): a letter can carry any
 *  number of these, like email attachments. */
export class LetterAttachment extends Model<InferAttributes<LetterAttachment>, InferCreationAttributes<LetterAttachment>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare letterId: string;
  declare documentId: string;
  declare originalFilename: string;
  declare uploadedBy: string;
  declare createdAt: CreationOptional<Date>;
}

export function initLetterAttachment() {
  LetterAttachment.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      letterId: { type: DataTypes.UUID, allowNull: false, field: "letter_id" },
      documentId: { type: DataTypes.UUID, allowNull: false, field: "document_id" },
      originalFilename: { type: DataTypes.TEXT, allowNull: false, field: "original_filename" },
      uploadedBy: { type: DataTypes.UUID, allowNull: false, field: "uploaded_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "letter_attachments", timestamps: false, underscored: true }
  );
}
