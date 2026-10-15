import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentCheckout extends Model<InferAttributes<DocumentCheckout>, InferCreationAttributes<DocumentCheckout>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare checkedOutBy: string;
  declare checkedOutAt: CreationOptional<Date>;
  declare lastActivity: CreationOptional<Date>;
  declare notes: string | null;
}

export function initDocumentCheckout() {
  DocumentCheckout.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, unique: true, allowNull: false },
      checkedOutBy: { type: DataTypes.UUID, allowNull: false },
      checkedOutAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      lastActivity: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      notes: DataTypes.STRING(500)
    },
    { sequelize, tableName: "document_checkouts", timestamps: false , underscored: true}
  );
}
