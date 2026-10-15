import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentBundle extends Model<InferAttributes<DocumentBundle>, InferCreationAttributes<DocumentBundle>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare name: string;
  declare description: string | null;
  declare status: CreationOptional<'DRAFT' | 'COMPILED'>;
  declare compiledDocumentId: string | null;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initDocumentBundle() {
  DocumentBundle.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DRAFT" },
      compiledDocumentId: { type: DataTypes.UUID, allowNull: true, field: "compiled_document_id" },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: "created_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, field: "updated_at" },
    },
    { sequelize, tableName: "document_bundles", timestamps: true, underscored: true }
  );
}
