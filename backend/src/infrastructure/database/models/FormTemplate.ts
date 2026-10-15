import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class FormTemplate extends Model<InferAttributes<FormTemplate>, InferCreationAttributes<FormTemplate>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare name: string;
  declare category: string | null;
  declare basePdfObjectKey: string | null;
  // Distinguishes a branding-only letterhead (header/footer banner, no field
  // captions) from a pre-printed form/scan (captions already on the page) —
  // see the is_letterhead migration for why generateFormPdf needs to tell
  // them apart. Meaningless when basePdfObjectKey is null.
  declare isLetterhead: CreationOptional<boolean>;
  declare schemaJson: object;
  declare sectionsJson: Array<{ id: string; label: string; order: number }> | null;
  declare layoutMode: 'static' | 'dynamic';
  declare version: CreationOptional<number>;
  declare status: 'draft' | 'pending_approval' | 'active' | 'deprecated';
  // Rec §7.2: 'chain' = filled instances flow through the approval engine
  // (leave-request pattern: fill → manager approves → …); 'none' = filing the
  // PDF is the end of the flow.
  declare instanceApproval: CreationOptional<'none' | 'chain'>;
  // Per-template governance policies (SYSTEM-DECISIONS.md D5/D8), mirroring
  // DocumentType's fields of the same name. FORM_INSTANCE items resolve
  // these from their OWN template, not the shared tenant-wide FORM document
  // type — otherwise every form template would be forced to share one
  // audit/signing setting regardless of what the form is for (see
  // approvals.service.ts's completeItemApproval).
  declare auditPolicy: CreationOptional<'required' | 'optional' | 'never'>;
  declare signingPolicy: CreationOptional<'none' | 'ceremony'>;
  // Scope (migration 20261004000020), same tri-level rule as DocumentType: departmentId = that
  // department only; else orgUnitId = every department under that org unit; both null = tenant-wide.
  declare departmentId: CreationOptional<string | null>;
  declare orgUnitId: CreationOptional<string | null>;
  declare createdBy: string | null;
  declare approvedBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initFormTemplate() {
  FormTemplate.init(
    {
      id: { ...uuidPk },
      tenantId: { type: DataTypes.STRING(100), allowNull: false, field: "tenant_id" },
      name: { type: DataTypes.STRING(255), allowNull: false },
      category: { type: DataTypes.STRING(100), allowNull: true },
      basePdfObjectKey: { type: DataTypes.TEXT, allowNull: true, field: "base_pdf_object_key" },
      isLetterhead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_letterhead" },
      schemaJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "schema_json" },
      sectionsJson: { type: DataTypes.JSONB, allowNull: true, field: "sections_json" },
      layoutMode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "static", field: "layout_mode" },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "draft" },
      instanceApproval: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "none", field: "instance_approval" },
      auditPolicy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "never", field: "audit_policy" },
      signingPolicy: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "none", field: "signing_policy" },
      departmentId: { type: DataTypes.UUID, allowNull: true, field: "department_id" },
      orgUnitId: { type: DataTypes.UUID, allowNull: true, field: "org_unit_id" },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: "created_by" },
      approvedBy: { type: DataTypes.UUID, allowNull: true, field: "approved_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, field: "updated_at" },
    },
    { sequelize, tableName: "form_templates", timestamps: true, underscored: true }
  );
}
