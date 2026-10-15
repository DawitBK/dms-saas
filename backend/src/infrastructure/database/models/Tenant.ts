import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

// §2: Tenant model for multi-tenant quota management
export class Tenant extends Model<InferAttributes<Tenant>, InferCreationAttributes<Tenant>> {
  declare id: string;
  declare name: string;
  declare storageQuotaBytes: CreationOptional<number>;
  declare storageUsedBytes: CreationOptional<number>;
  declare maxUsers: CreationOptional<number>;
  declare maxDocuments: CreationOptional<number>;
  declare isActive: CreationOptional<boolean>;
  /** Per-tenant on/off switches for features that are deployed but not yet
   *  turned on for everyone (Documentations/rollout.md §4.2) — e.g. { "cams_v2_dispatch": true }.
   *  Read/write it through modules/feature-flags/featureFlags.service.ts,
   *  never directly, so the cache (featureFlagCache.ts) stays correct. */
  declare featureFlags: CreationOptional<Record<string, boolean>>;
  /** D10: executive-notice policy — { letterTypes?: string[],
   *  maxConfidentiality?: "PUBLIC"|"INTERNAL" }. Empty = all letter types,
   *  PUBLIC+INTERNAL only (CONFIDENTIAL/RESTRICTED are never auto-emailed). */
  declare execNoticeConfig: CreationOptional<Record<string, unknown>>;
  /** AI usage rules (modules/ai/aiPolicy.service.ts owns the shape and the
   *  defaults; {} = defaults). Read/write through that service, never directly. */
  declare aiPolicy: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initTenant() {
  Tenant.init(
    {
      id: { type: DataTypes.STRING(100), primaryKey: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      storageQuotaBytes: { type: DataTypes.BIGINT, defaultValue: 10737418240, allowNull: false, field: "storageQuotaBytes" },
      storageUsedBytes: { type: DataTypes.BIGINT, defaultValue: 0, allowNull: false, field: "storageUsedBytes" },
      maxUsers: { type: DataTypes.INTEGER, defaultValue: 50, allowNull: false, field: "maxUsers" },
      maxDocuments: { type: DataTypes.INTEGER, defaultValue: 100000, allowNull: false, field: "maxDocuments" },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false, field: "isActive" },
      featureFlags: { type: DataTypes.JSONB, defaultValue: {}, allowNull: false, field: "feature_flags" },
      execNoticeConfig: { type: DataTypes.JSONB, defaultValue: {}, allowNull: false, field: "exec_notice_config" },
      aiPolicy: { type: DataTypes.JSONB, defaultValue: {}, allowNull: false, field: "ai_policy" },
      createdAt: { type: DataTypes.DATE, field: "createdAt" },
      updatedAt: { type: DataTypes.DATE, field: "updatedAt" }
    },
    {
      sequelize,
      tableName: "tenants",
      timestamps: true,
      underscored: true
    }
  );
}
