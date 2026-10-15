import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentSequence extends Model<InferAttributes<DocumentSequence>, InferCreationAttributes<DocumentSequence>> {
  declare id: CreationOptional<string>;
  declare deptCode: string;
  declare docTypeCode: string;
  declare dateKey: string;
  declare lastSeq: CreationOptional<number>;
}

export function initDocumentSequence() {
  DocumentSequence.init(
    {
      id: uuidPk,
      deptCode: DataTypes.STRING(10),
      docTypeCode: DataTypes.STRING(10),
      dateKey: DataTypes.STRING(8),
      lastSeq: { type: DataTypes.INTEGER, defaultValue: 0 }
    },
    {
      sequelize,
      tableName: "document_sequences",
      timestamps: false,
      underscored: true,
      indexes: [{ unique: true, fields: ["dept_code", "doc_type_code", "date_key"] }]
    }
  );
}
