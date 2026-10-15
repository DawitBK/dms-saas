import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class CertificateOfDestruction extends Model<InferAttributes<CertificateOfDestruction>, InferCreationAttributes<CertificateOfDestruction>> {
  declare id: CreationOptional<string>;
  declare reference: string;
  declare documentIds: string;
  declare disposalMethod: string;
  declare authorisedById: string;
  declare authorisedAt: Date;
  declare issuedAt: CreationOptional<Date>;
  declare pdfStorageKey: string | null;
}

export function initCertificateOfDestruction() {
  CertificateOfDestruction.init(
    {
      id: uuidPk,
      reference: { type: DataTypes.STRING(100), unique: true },
      documentIds: { type: DataTypes.TEXT, allowNull: false },
      disposalMethod: { type: DataTypes.STRING(100), allowNull: false },
      authorisedById: { type: DataTypes.UUID, allowNull: false },
      authorisedAt: { type: DataTypes.DATE, allowNull: false },
      issuedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      pdfStorageKey: DataTypes.STRING(1000)
    },
    { sequelize, tableName: "certificates_of_destruction", timestamps: false , underscored: true}
  );
}
