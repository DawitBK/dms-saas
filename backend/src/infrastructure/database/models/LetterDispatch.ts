import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class LetterDispatch extends Model<InferAttributes<LetterDispatch>, InferCreationAttributes<LetterDispatch>> {
  declare id: CreationOptional<string>;
  declare letterId: string;
  declare channel: 'EMAIL' | 'PORTAL' | 'PRINT' | 'COURIER' | 'HAND_DELIVERY' | 'REGISTERED_MAIL';
  declare recipientName: string | null;
  declare recipientAddress: string | null;
  declare trackingReference: string | null;
  declare notes: string | null;
  declare dispatchedBy: string | null;
  declare dispatchedAt: CreationOptional<Date>;
  declare acknowledgedAt: Date | null;
  declare acknowledgmentNote: string | null;
}

export function initLetterDispatch() {
  LetterDispatch.init(
    {
      id: { ...uuidPk },
      letterId: { type: DataTypes.UUID, allowNull: false, field: "letter_id" },
      channel: { type: DataTypes.STRING(20), allowNull: false },
      recipientName: { type: DataTypes.TEXT, allowNull: true, field: "recipient_name" },
      recipientAddress: { type: DataTypes.TEXT, allowNull: true, field: "recipient_address" },
      trackingReference: { type: DataTypes.TEXT, allowNull: true, field: "tracking_reference" },
      notes: { type: DataTypes.TEXT, allowNull: true },
      dispatchedBy: { type: DataTypes.UUID, allowNull: true, field: "dispatched_by" },
      dispatchedAt: { type: DataTypes.DATE, field: "dispatched_at" },
      acknowledgedAt: { type: DataTypes.DATE, allowNull: true, field: "acknowledged_at" },
      acknowledgmentNote: { type: DataTypes.TEXT, allowNull: true, field: "acknowledgment_note" },
    },
    { sequelize, tableName: "letter_dispatches", timestamps: false, underscored: true }
  );
}
