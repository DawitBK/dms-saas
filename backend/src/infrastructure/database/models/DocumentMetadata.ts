import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class DocumentMetadata extends Model<InferAttributes<DocumentMetadata>, InferCreationAttributes<DocumentMetadata>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare keywords: string | null;
  declare description: string | null;
  declare tags: string | null;
  declare externalReference: string | null;
  declare originatingSystem: string | null;
  declare physicalRecordRef: string | null;
  declare language: string | null;
  declare geographicScope: string | null;
  declare confidentialityNotice: string | null;
  declare legalHoldFlag: CreationOptional<boolean>;
  declare legalHoldCaseRef: string | null;
  declare archiveDate: Date | null;
  declare disposalAuthorisedBy: string | null;
  declare disposalAuthorisedAt: Date | null;
  declare certificateOfDestructionRef: string | null;
  declare customFields: string | null;
}

export function initDocumentMetadata() {
  DocumentMetadata.init(
    {
      id: uuidPk,
      documentId: { type: DataTypes.UUID, unique: true, allowNull: false },
      keywords: DataTypes.STRING(2000),
      description: DataTypes.STRING(2000),
      tags: DataTypes.STRING(2000),
      externalReference: DataTypes.STRING(200),
      originatingSystem: DataTypes.STRING(100),
      physicalRecordRef: DataTypes.STRING(100),
      language: DataTypes.STRING(10),
      geographicScope: DataTypes.STRING(100),
      confidentialityNotice: DataTypes.STRING(500),
      legalHoldFlag: { type: DataTypes.BOOLEAN, defaultValue: false },
      legalHoldCaseRef: DataTypes.STRING(100),
      archiveDate: DataTypes.DATE,
      disposalAuthorisedBy: DataTypes.UUID,
      disposalAuthorisedAt: DataTypes.DATE,
      certificateOfDestructionRef: DataTypes.STRING(100),
      customFields: DataTypes.TEXT
    },
    { sequelize, tableName: "document_metadata", timestamps: false , underscored: true}
  );
}
