import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class PurgePending extends Model<InferAttributes<PurgePending>, InferCreationAttributes<PurgePending>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare stagedAt: CreationOptional<Date>;
  declare stagedById: CreationOptional<string | null>;
  declare purgeAfter: Date;
  declare approvedById: string | null;
  declare approvedAt: Date | null;
  declare status: string; // PENDING | APPROVED | CANCELLED
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initPurgePending() {
  PurgePending.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, unique: true, allowNull: false },
      stagedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      stagedById: DataTypes.UUID,
      purgeAfter: { type: DataTypes.DATE, allowNull: false },
      approvedById: DataTypes.UUID,
      approvedAt: DataTypes.DATE,
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "PENDING" },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "purge_pending",
      timestamps: true,
      underscored: true,
      indexes: [{ fields: ["status"] }, { fields: ["purge_after"] }]
    }
  );
}
