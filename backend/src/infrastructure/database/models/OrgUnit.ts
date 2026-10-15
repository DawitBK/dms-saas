import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class OrgUnit extends Model<InferAttributes<OrgUnit>, InferCreationAttributes<OrgUnit>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare code: string;
  declare name: string;
  declare unitType: 'HQ' | 'BRANCH' | 'OUTLET' | 'SISTER_COMPANY';
  // CAMS letterhead masthead override (sister companies issue letters under
  // their own name); NULL = the group-level default.
  declare letterheadTitle: CreationOptional<string | null>;
  declare parentUnitId: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initOrgUnit() {
  OrgUnit.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      code: { type: DataTypes.STRING(30), allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      unitType: { type: DataTypes.STRING(20), allowNull: false, field: "unit_type" },
      letterheadTitle: { type: DataTypes.STRING(120), allowNull: true, field: "letterhead_title" },
      parentUnitId: { type: DataTypes.UUID, allowNull: true, field: "parent_unit_id" },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: "is_active" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, field: "updated_at" },
    },
    { sequelize, tableName: "org_units", timestamps: true, underscored: true, indexes: [{ unique: true, fields: ["tenant_id", "code"] }] }
  );
}
