import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

/** Post-approval audit stage (SYSTEM-DECISIONS.md D5–D7): the final approver
 *  assigns a named auditor; the auditor PASSes (→ archivable) or FLAGs with
 *  mandatory findings (→ back to the final approver, who owns remediation). */
export class AuditStageReview extends Model<InferAttributes<AuditStageReview>, InferCreationAttributes<AuditStageReview>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare itemType: CreationOptional<string>;
  declare itemId: string;
  declare auditorUserId: string;
  declare assignedBy: string;
  declare status: CreationOptional<"PENDING" | "PASSED" | "FLAGGED">;
  declare findings: string | null;
  declare decidedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initAuditStageReview() {
  AuditStageReview.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(100), allowNull: false },
      itemType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "DOCUMENT" },
      itemId: { type: DataTypes.UUID, allowNull: false },
      auditorUserId: { type: DataTypes.UUID, allowNull: false },
      assignedBy: { type: DataTypes.UUID, allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "PENDING" },
      findings: DataTypes.TEXT,
      decidedAt: DataTypes.DATE,
      createdAt: DataTypes.DATE,
    },
    { sequelize, tableName: "audit_stage_reviews", timestamps: false, underscored: true },
  );
}
