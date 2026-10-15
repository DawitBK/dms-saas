import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class ArchiveRecord extends Model<InferAttributes<ArchiveRecord>, InferCreationAttributes<ArchiveRecord>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare archivePackageRef: string | null;
  declare archiveStoragePath: string | null;
  declare archiveStorageTier: string;
  declare archivedAt: CreationOptional<Date>;
  declare archivedById: string | null;
  declare status: string;
  declare disposalEligibleAt: Date | null;
  declare disposalAuthorisedAt: Date | null;
  declare disposedAt: Date | null;
  declare codReference: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initArchiveRecord() {
  ArchiveRecord.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, unique: true, allowNull: false },
      archivePackageRef: DataTypes.STRING(255),
      archiveStoragePath: DataTypes.STRING(1000),
      archiveStorageTier: { type: DataTypes.STRING(50), allowNull: false },
      archivedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      archivedById: DataTypes.UUID,
      status: { type: DataTypes.STRING(30), allowNull: false },
      disposalEligibleAt: DataTypes.DATE,
      disposalAuthorisedAt: DataTypes.DATE,
      disposedAt: DataTypes.DATE,
      codReference: DataTypes.STRING(100),
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "archive_records", timestamps: false, updatedAt: false , underscored: true}
  );
}
