import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentComment extends Model<InferAttributes<DocumentComment>, InferCreationAttributes<DocumentComment>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare tenantId: string;
  declare authorId: string;
  declare parentId: string | null;
  declare body: string;
  declare isDeleted: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initDocumentComment() {
  DocumentComment.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.STRING(255), allowNull: false },
      authorId: { type: DataTypes.UUID, allowNull: false },
      parentId: { type: DataTypes.UUID, allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: false },
      isDeleted: { type: DataTypes.BOOLEAN, defaultValue: false },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "document_comments", timestamps: false, underscored: true }
  );
}
