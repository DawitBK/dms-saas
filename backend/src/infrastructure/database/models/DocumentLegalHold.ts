import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentLegalHold extends Model<InferAttributes<DocumentLegalHold>, InferCreationAttributes<DocumentLegalHold>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare legalHoldId: string;
  declare addedAt: CreationOptional<Date>;
  declare removedAt: Date | null;
}

export function initDocumentLegalHold() {
  DocumentLegalHold.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      legalHoldId: { type: DataTypes.UUID, allowNull: false },
      addedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      removedAt: DataTypes.DATE
    },
    { sequelize, tableName: "document_legal_holds", timestamps: false , underscored: true}
  );
}
