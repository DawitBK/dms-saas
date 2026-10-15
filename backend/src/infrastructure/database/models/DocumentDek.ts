import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentDek extends Model<InferAttributes<DocumentDek>, InferCreationAttributes<DocumentDek>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  // FIX: one DEK per DocumentVersion, not one per Document. Each version's
  // ciphertext is encrypted under its own key; keying by documentId alone
  // meant every new version's DEK overwrote the previous one, permanently
  // destroying the ability to decrypt every earlier version.
  declare versionId: string;
  declare encryptedDek: string; // base64 AES-256-KW wrapped key
  declare kekId: string;
  declare algorithm: CreationOptional<string>;
  // 1 = IV||AuthTag||ciphertext (legacy/buffered, documentCrypto.encryptAndStore).
  // 2 = IV||ciphertext||AuthTag (streaming, documentCrypto.encryptStreamAndStore).
  // See migration 20260813000002 for why the tag position differs.
  declare formatVersion: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initDocumentDek() {
  DocumentDek.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      versionId: { type: DataTypes.UUID, unique: true, allowNull: false },
      encryptedDek: { type: DataTypes.TEXT, allowNull: false },
      kekId: { type: DataTypes.STRING(255), allowNull: false },
      algorithm: { type: DataTypes.STRING(50), defaultValue: "AES-256-GCM" },
      formatVersion: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "document_deks", timestamps: true , underscored: true}
  );
}
