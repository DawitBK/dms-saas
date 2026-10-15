import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

// One row = "this role may perform this action while a document is in this
// status". Absence of any row for a (tenantId, status, action) tuple means
// unrestricted; see modules/documents/statusPermissions.service.ts.
export class DocumentStatusActionRole extends Model<
  InferAttributes<DocumentStatusActionRole>,
  InferCreationAttributes<DocumentStatusActionRole>
> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare status: string;
  declare action: string;
  declare roleName: string;
  declare createdById: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initDocumentStatusActionRole() {
  DocumentStatusActionRole.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.STRING(50), allowNull: false },
      status: { type: DataTypes.STRING(50), allowNull: false },
      action: { type: DataTypes.STRING(50), allowNull: false },
      roleName: { type: DataTypes.STRING(64), allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
      createdAt: DataTypes.DATE,
    },
    {
      sequelize,
      tableName: "document_status_action_roles",
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { unique: true, fields: ["tenant_id", "status", "action", "role_name"] },
        { name: "doc_status_action_roles_lookup_idx", fields: ["tenant_id", "status", "action"] },
      ],
    },
  );
}
