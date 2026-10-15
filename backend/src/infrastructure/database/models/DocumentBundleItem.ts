import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentBundleItem extends Model<InferAttributes<DocumentBundleItem>, InferCreationAttributes<DocumentBundleItem>> {
  declare id: CreationOptional<string>;
  declare bundleId: string;
  declare documentId: string;
  declare position: number;
  declare addedBy: string | null;
  declare addedAt: CreationOptional<Date>;
}

export function initDocumentBundleItem() {
  DocumentBundleItem.init(
    {
      id: { ...uuidPk },
      bundleId: { type: DataTypes.UUID, allowNull: false, field: "bundle_id" },
      documentId: { type: DataTypes.UUID, allowNull: false, field: "document_id" },
      position: { type: DataTypes.INTEGER, allowNull: false },
      addedBy: { type: DataTypes.UUID, allowNull: true, field: "added_by" },
      addedAt: { type: DataTypes.DATE, field: "added_at" },
    },
    { sequelize, tableName: "document_bundle_items", timestamps: false, underscored: true }
  );
}
