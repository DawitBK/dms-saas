import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentVersion extends Model<InferAttributes<DocumentVersion>, InferCreationAttributes<DocumentVersion>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare versionNumber: string;
  declare isMajorVersion: CreationOptional<boolean>;
  declare storageKey: string;
  declare storageBucket: string;
  declare fileSize: bigint;
  declare mimeType: string;
  declare originalFilename: string;
  declare sha256Hash: string; // Ciphertext hash (IV + authTag + ciphertext)
  declare plaintextSha256: string | null; // BUG 2 FIX: Plaintext content hash for duplicate detection
  declare extractedText: string | null;
  declare authorId: string;
  declare changeSummary: string;
  declare isMigrationImport: CreationOptional<boolean>;
  declare avScanStatus: CreationOptional<"clean" | "unscanned">;
  declare createdAt: CreationOptional<Date>;
}

export function initDocumentVersion() {
  DocumentVersion.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      versionNumber: { type: DataTypes.STRING(10), allowNull: false },
      isMajorVersion: { type: DataTypes.BOOLEAN, defaultValue: false },
      storageKey: { type: DataTypes.STRING(1000), allowNull: false },
      storageBucket: { type: DataTypes.STRING(255), allowNull: false },
      fileSize: { type: DataTypes.BIGINT, allowNull: false },
      mimeType: { type: DataTypes.STRING(100), allowNull: false },
      originalFilename: { type: DataTypes.STRING(255), allowNull: false },
      sha256Hash: { type: DataTypes.STRING(64), allowNull: false },
      plaintextSha256: { type: DataTypes.STRING(64), allowNull: true }, // BUG 2 FIX: Plaintext hash for duplicate detection
      extractedText: DataTypes.TEXT,
      authorId: { type: DataTypes.UUID, allowNull: false },
      changeSummary: { type: DataTypes.STRING(2000), allowNull: false },
      isMigrationImport: { type: DataTypes.BOOLEAN, defaultValue: false },
      avScanStatus: { type: DataTypes.STRING(20), defaultValue: "clean" },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    {
      sequelize,
      tableName: "document_versions",
      timestamps: false,
      updatedAt: false,
      underscored: true,
      indexes: [
        { fields: ["document_id"] },
        { fields: ["sha256_hash"] },
        { fields: ["plaintext_sha256"] }, // BUG 2 FIX: Index for duplicate detection
        { fields: ["document_id", "created_at"] }
      ]
    }
  );
}
