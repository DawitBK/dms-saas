import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export const ACL_RESOURCE_TYPES = ["document", "folder", "department", "workflow", "workflow_task", "retention", "legal_hold"] as const;
export const ACL_PRINCIPAL_TYPES = ["user", "role"] as const;
export const ACL_EFFECTS = ["ALLOW", "DENY"] as const;

export type AclResourceType = (typeof ACL_RESOURCE_TYPES)[number];
export type AclPrincipalType = (typeof ACL_PRINCIPAL_TYPES)[number];
export type AclEffect = (typeof ACL_EFFECTS)[number];

export class AclEntry extends Model<InferAttributes<AclEntry>, InferCreationAttributes<AclEntry>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare resourceType: AclResourceType;
  declare resourceId: string;
  declare principalType: AclPrincipalType;
  declare principalId: string;
  declare effect: AclEffect;
  declare permission: string;
  declare expiresAt: Date | null;
  declare grantedById: string;
  /** 'DEPT_SNAPSHOT' marks the per-member read rows grantDefaultDocumentAcl writes at creation (bound by the
   *  live department check); NULL is a deliberate grant. See migration 20261004000010. */
  declare origin: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initAclEntry() {
  AclEntry.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      resourceType: { type: DataTypes.STRING(50), allowNull: false },
      resourceId: { type: DataTypes.UUID, allowNull: false },
      principalType: { type: DataTypes.STRING(20), allowNull: false },
      principalId: { type: DataTypes.STRING(100), allowNull: false },
      effect: { type: DataTypes.STRING(10), allowNull: false },
      permission: { type: DataTypes.STRING(50), allowNull: false },
      expiresAt: DataTypes.DATE,
      grantedById: { type: DataTypes.UUID, allowNull: false },
      origin: { type: DataTypes.STRING(20), allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "acl_entries",
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          name: "acl_entries_unique_grant",
          fields: ["tenant_id", "resource_type", "resource_id", "principal_type", "principal_id", "permission", "effect"]
        },
        { name: "acl_entries_resource_idx", fields: ["resource_type", "resource_id"] },
        { name: "acl_entries_principal_idx", fields: ["principal_type", "principal_id"] },
        { name: "acl_entries_tenant_idx", fields: ["tenant_id"] },
        { name: "acl_entries_expires_idx", fields: ["expires_at"] }
      ]
    }
  );
}
