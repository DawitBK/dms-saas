import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class FormInstance extends Model<InferAttributes<FormInstance>, InferCreationAttributes<FormInstance>> {
  declare id: CreationOptional<string>;
  declare templateId: string;
  declare templateVersion: number;
  declare documentId: string | null;
  declare dataJson: object;
  declare generatedPdfObjectKey: string | null;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
  /** Set when the filer edits the form before approval (migration 20261004000020). */
  declare updatedAt: CreationOptional<Date | null>;
  /** Allocated from FormSequence at FINAL APPROVAL, never at submit — a number
   *  handed out at submit is consumed by every declined or abandoned form, so
   *  the series develops gaps in normal use and a genuine gap stops being
   *  noticeable. Null for the many instances that are never approved (a
   *  template with instanceApproval 'none' never gets a chain at all). */
  declare referenceNumber: CreationOptional<string | null>;
  declare referenceAllocatedAt: CreationOptional<Date | null>;
  /** The tenant the number was allocated for. A number is unique per tenant (index form_instances_tenant_ref_uniq), and this table has no tenant column of its own. */
  declare referenceTenantId: CreationOptional<string | null>;
}

export function initFormInstance() {
  FormInstance.init(
    {
      id: { ...uuidPk },
      templateId: { type: DataTypes.UUID, allowNull: false, field: "template_id" },
      templateVersion: { type: DataTypes.INTEGER, allowNull: false, field: "template_version" },
      documentId: { type: DataTypes.UUID, allowNull: true, field: "document_id" },
      dataJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: "data_json" },
      generatedPdfObjectKey: { type: DataTypes.TEXT, allowNull: true, field: "generated_pdf_object_key" },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: "created_by" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, allowNull: true, field: "updated_at" },
      referenceNumber: { type: DataTypes.TEXT, allowNull: true, field: "reference_number" },
      referenceAllocatedAt: { type: DataTypes.DATE, allowNull: true, field: "reference_allocated_at" },
      referenceTenantId: { type: DataTypes.TEXT, allowNull: true, field: "reference_tenant_id" },
    },
    { sequelize, tableName: "form_instances", timestamps: false, underscored: true }
  );
}
