import { DataTypes, Model, Op, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class AccessRule extends Model<InferAttributes<AccessRule>, InferCreationAttributes<AccessRule>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare principalType: "user" | "role";
  declare principalId: string;
  declare permission: string;
  declare effect: "ALLOW" | "DENY";
  declare documentTypeId: string | null;
  declare expiresAt: Date | null;
  declare grantedById: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initAccessRule() {
  AccessRule.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      principalType: { type: DataTypes.STRING(10), allowNull: false },
      principalId: { type: DataTypes.STRING(255), allowNull: false },
      permission: { type: DataTypes.STRING(100), allowNull: false },
      effect: { type: DataTypes.STRING(10), allowNull: false },
      documentTypeId: { type: DataTypes.UUID, field: "document_type_id", allowNull: true },
      expiresAt: { type: DataTypes.DATE, field: "expires_at", allowNull: true },
      grantedById: { type: DataTypes.UUID, allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "access_rules",
      timestamps: true,
      underscored: true,
      indexes: [
        { name: "access_rules_tenant_idx", fields: ["tenant_id"] },
        { name: "access_rules_principal_idx", fields: ["tenant_id", "principal_type", "principal_id"] },
        { name: "access_rules_document_type_idx", fields: ["document_type_id"] },
        // Finding 3: enforce "one grant per tuple" -- see migration
        // 20260830000004-access-rules-tuple-unique.sql for the full
        // reasoning. Two partial unique indexes (not one plain unique index)
        // because document_type_id is nullable and a plain unique index
        // would treat every NULL (tenant-wide grant) as distinct from every
        // other NULL, letting duplicate/contradictory tenant-wide rows in.
        {
          name: "access_rules_tuple_unique_scoped_idx",
          unique: true,
          fields: ["tenant_id", "principal_type", "principal_id", "permission", "document_type_id"],
          where: { documentTypeId: { [Op.ne]: null } }
        },
        {
          name: "access_rules_tuple_unique_global_idx",
          unique: true,
          fields: ["tenant_id", "principal_type", "principal_id", "permission"],
          where: { documentTypeId: { [Op.eq]: null } }
        }
      ]
    }
  );
}
