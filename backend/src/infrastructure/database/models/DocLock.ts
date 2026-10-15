import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

// S4-12: Document lock model
export class DocLock extends Model<InferAttributes<DocLock>, InferCreationAttributes<DocLock>> {
  declare id: CreationOptional<string>;
  declare documentId: string;
  declare lockedBy: string;
  declare lockedAt: CreationOptional<Date>;
  declare expiresAt: Date;
  declare reason: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initDocLock() {
  // S4-12: Document lock
  DocLock.init(
    {
      id: uuidPk,
      // FIX: only one active lock per document was ever intended (locks are
      // destroy()ed on unlock/expiry, never kept as history) — but nothing
      // enforced that at the DB level, so a check-then-create race in
      // lockDocument() could create two lock rows for one document.
      documentId: { type: DataTypes.UUID, allowNull: false, unique: true },
      lockedBy: { type: DataTypes.UUID, allowNull: false },
      lockedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      reason: DataTypes.STRING(500),
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "doc_locks",
      timestamps: true,
      underscored: true,
      indexes: [{ fields: ["expires_at"] }]
    }
  );
}
