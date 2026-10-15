import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class SignatureRecord extends Model<InferAttributes<SignatureRecord>, InferCreationAttributes<SignatureRecord>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare documentVersionId: string | null;
  declare signatoryUserId: string;
  declare signingType: string;
  declare status: string;
  declare certificateSubject: string | null;
  declare certificateIssuer: string | null;
  declare certificateSerial: string | null;
  declare certificatePem: string | null;
  declare certNotBefore: Date | null;
  declare certNotAfter: Date | null;
  declare signatureAlgorithm: string | null;
  declare documentHashAtSign: string | null;
  declare signatureData: string | null;
  declare timestampToken: string | null;
  declare ltvEmbedded: CreationOptional<boolean>;
  declare sigStorageKey: string | null;
  declare ipAddress: string | null;
  declare userAgent: string | null;
  declare consentAcknowledged: CreationOptional<boolean>;
  declare signedAt: Date | null;
  declare declineReason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initSignatureRecord() {
  SignatureRecord.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      documentVersionId: DataTypes.UUID,
      signatoryUserId: { type: DataTypes.UUID, allowNull: false },
      signingType: { type: DataTypes.STRING(20), allowNull: false },
      status: { type: DataTypes.STRING(30), allowNull: false },
      certificateSubject: DataTypes.STRING(500),
      certificateIssuer: DataTypes.STRING(500),
      certificateSerial: DataTypes.STRING(100),
      // PEM is required to independently verify the public-key signature.
      // Subject/issuer/serial alone are descriptive metadata, not key material.
      certificatePem: DataTypes.TEXT,
      certNotBefore: DataTypes.DATE,
      certNotAfter: DataTypes.DATE,
      signatureAlgorithm: DataTypes.STRING(100),
      documentHashAtSign: DataTypes.STRING(64),
      signatureData: DataTypes.TEXT,
      timestampToken: DataTypes.TEXT,
      ltvEmbedded: { type: DataTypes.BOOLEAN, defaultValue: false },
      sigStorageKey: DataTypes.STRING(1000),
      ipAddress: DataTypes.STRING(45),
      userAgent: DataTypes.STRING(500),
      consentAcknowledged: { type: DataTypes.BOOLEAN, defaultValue: false },
      signedAt: DataTypes.DATE,
      declineReason: DataTypes.STRING(1000),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "signature_records", timestamps: true , underscored: true}
  );
}
