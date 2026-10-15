import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<string>;
  declare sequenceNumber: CreationOptional<bigint>;
  declare timestamp: CreationOptional<Date>;
  declare tenantId: string | null;
  declare eventType: string;
  declare userId: string | null;
  declare userRole: string | null;
  declare sourceIp: string | null;
  declare sessionId: string | null;
  declare documentId: string | null;
  declare documentVersion: string | null;
  declare actionDetails: string;
  declare previousState: string | null;
  declare newState: string | null;
  declare isSuccess: CreationOptional<boolean>;
  declare errorCode: string | null;
  /** Which of this tenant's parallel hash chains this row belongs to (R-02).
   *  Fixed at insert; never updated. Legacy rows are 0. */
  declare chainShard: CreationOptional<number>;
  declare previousHash: string | null;
  declare entryHash: string | null;
}

export function initAuditLog() {
  AuditLog.init(
    {
      id: uuidPk,
      sequenceNumber: { type: DataTypes.BIGINT, allowNull: false, unique: true, autoIncrement: true },
      timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      tenantId: { type: DataTypes.STRING(100), allowNull: true, field: "tenant_id" },
      eventType: { type: DataTypes.STRING(100), allowNull: false },
      userId: DataTypes.UUID,
      userRole: DataTypes.STRING(50),
      sourceIp: DataTypes.STRING(45),
      sessionId: DataTypes.STRING(100),
      documentId: DataTypes.UUID,
      documentVersion: DataTypes.STRING(10),
      actionDetails: { type: DataTypes.TEXT, allowNull: false },
      previousState: DataTypes.STRING(50),
      newState: DataTypes.STRING(50),
      isSuccess: { type: DataTypes.BOOLEAN, defaultValue: true },
      errorCode: DataTypes.STRING(100),
      previousHash: DataTypes.STRING(64),
      chainShard: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      entryHash: DataTypes.STRING(64)
    },
    {
      sequelize,
      tableName: "audit_logs",
      timestamps: false,
      updatedAt: false,
      underscored: true,
      hooks: {
        beforeUpdate: () => {
          throw new Error("Audit log entries are immutable and cannot be updated");
        },
        beforeDestroy: () => {
          throw new Error("Audit log entries are immutable and cannot be deleted");
        },
        beforeBulkUpdate: () => {
          throw new Error("Audit log entries are immutable and cannot be updated");
        },
        beforeBulkDestroy: () => {
          throw new Error("Audit log entries are immutable and cannot be deleted");
        }
      }
    }
  );
}
