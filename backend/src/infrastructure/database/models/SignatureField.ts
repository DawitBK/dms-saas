import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class SignatureField extends Model<InferAttributes<SignatureField>, InferCreationAttributes<SignatureField>> {
  declare id: CreationOptional<string>;
  declare signatureRequestId: string;
  declare recipientId: string;
  declare pageNumber: CreationOptional<number>;
  declare x: number;
  declare y: number;
  declare width: number;
  declare height: number;
  declare fieldType: 'signature' | 'initial' | 'date' | 'text' | 'seal';
  declare value: string | null;
  declare signedAt: Date | null;
}

export function initSignatureField() {
  SignatureField.init(
    {
      id: { ...uuidPk },
      signatureRequestId: { type: DataTypes.UUID, allowNull: false, field: "signature_request_id" },
      recipientId: { type: DataTypes.UUID, allowNull: false, field: "recipient_id" },
      pageNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "page_number" },
      x: { type: DataTypes.FLOAT, allowNull: false },
      y: { type: DataTypes.FLOAT, allowNull: false },
      width: { type: DataTypes.FLOAT, allowNull: false },
      height: { type: DataTypes.FLOAT, allowNull: false },
      fieldType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "signature", field: "field_type" },
      value: { type: DataTypes.TEXT, allowNull: true },
      signedAt: { type: DataTypes.DATE, allowNull: true, field: "signed_at" },
    },
    { sequelize, tableName: "signature_fields", timestamps: false, underscored: true }
  );
}
