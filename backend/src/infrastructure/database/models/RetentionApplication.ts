import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class RetentionApplication extends Model<InferAttributes<RetentionApplication>, InferCreationAttributes<RetentionApplication>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare policyId: string;
  declare triggeredAt: CreationOptional<Date>;
  declare eligibleAt: Date;
  declare notified90Days: CreationOptional<boolean>;
  declare notified30Days: CreationOptional<boolean>;
  declare disposalAuthorisedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initRetentionApplication() {
  RetentionApplication.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, allowNull: false },
      policyId: { type: DataTypes.UUID, allowNull: false },
      triggeredAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      eligibleAt: { type: DataTypes.DATE, allowNull: false },
      // Explicit field mappings: `underscored: true` would generate
      // "notified90_days" (no underscore before the digits), but the real
      // columns are notified_90_days / notified_30_days.
      notified90Days: { type: DataTypes.BOOLEAN, defaultValue: false, field: "notified_90_days" },
      notified30Days: { type: DataTypes.BOOLEAN, defaultValue: false, field: "notified_30_days" },
      disposalAuthorisedAt: DataTypes.DATE,
      createdAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "retention_applications",
      timestamps: false,
      updatedAt: false,
      underscored: true,
      indexes: [{ fields: ["document_id"] }, { fields: ["eligible_at"] }]
    }
  );
}
