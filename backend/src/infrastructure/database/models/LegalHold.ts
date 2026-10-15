import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class LegalHold extends Model<InferAttributes<LegalHold>, InferCreationAttributes<LegalHold>> {
  declare id: CreationOptional<string>;
  // Platform audit finding (2026-08-14): added so legal holds can be tenant-
  // scoped like every other tenant-owned table — see migration
  // 20260814000001-legal-holds-tenant-id.sql for why this was missing.
  declare tenantId: string;
  declare caseReference: string;
  declare description: string;
  declare custodianName: string;
  declare legalBasis: string;
  declare expectedDuration: string | null;
  declare status: string;
  declare appliedById: string;
  declare appliedAt: CreationOptional<Date>;
  declare releasedAt: Date | null;
  declare releasedById: string | null;
  declare releaseClosureRef: string | null;
  declare releaseReason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initLegalHold() {
  LegalHold.init(
    {
      id: uuidPk,
      // Tenant ids are slug strings (e.g. "examplecorp"), not UUIDs — matches
      // documents.tenant_id's actual type.
      tenantId: { type: DataTypes.STRING(100), allowNull: false },
      caseReference: { type: DataTypes.STRING(100), allowNull: false },
      description: { type: DataTypes.STRING(2000), allowNull: false },
      custodianName: { type: DataTypes.STRING(255), allowNull: false },
      legalBasis: { type: DataTypes.STRING(1000), allowNull: false },
      expectedDuration: DataTypes.STRING(255),
      status: { type: DataTypes.STRING(20), allowNull: false },
      appliedById: { type: DataTypes.UUID, allowNull: false },
      appliedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      releasedAt: DataTypes.DATE,
      releasedById: DataTypes.UUID,
      releaseClosureRef: DataTypes.STRING(100),
      releaseReason: DataTypes.STRING(1000),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    { sequelize, tableName: "legal_holds", timestamps: true , underscored: true}
  );
}
