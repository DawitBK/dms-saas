import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class SignatureRecipient extends Model<InferAttributes<SignatureRecipient>, InferCreationAttributes<SignatureRecipient>> {
  declare id: CreationOptional<string>;
  declare signatureRequestId: string;
  declare orderIndex: CreationOptional<number>;
  declare name: string;
  declare email: string;
  declare dmsUserId: string | null;
  /** Alternative to dmsUserId for an internal recipient with no specific
   *  person picked yet — department-scoped to the target document, claimed
   *  (dmsUserId stamped in) by whichever qualified holder signs first. Kept
   *  set after claiming as a historical record of how the slot was
   *  originally assigned — not cleared, so both fields can be non-null. */
  declare assignedRole: string | null;
  declare status: 'pending' | 'viewed' | 'signed' | 'declined';
  declare signedAt: Date | null;
  declare declinedAt: Date | null;
  declare declineReason: string | null;
  declare ipAddress: string | null;
  /** The external signer's bearer secret. Its public getter (see init below)
   *  always reads as undefined, so `toJSON()` / `get({ plain: true })` — every
   *  API response that serialises a recipient, including GET /documents/:id's
   *  `signatureRequests[].recipients` — can never carry it. A bearer token in a
   *  response lets any reader of the request sign as the external party.
   *  Server code that really needs the secret (send/remind emails, token
   *  checks) reads `getDataValue('accessToken')` — see esigning.service.ts's
   *  `recipientToken()`. */
  declare accessToken: string | null;
  /** SHA-256 hex of the external signer's token (E24). The raw token is never stored; hidden from
   *  serialisation exactly like accessToken. `accessToken` itself is now a legacy column, always NULL. */
  declare accessTokenHash: string | null;
  declare accessTokenExpires: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initSignatureRecipient() {
  SignatureRecipient.init(
    {
      id: { ...uuidPk },
      signatureRequestId: { type: DataTypes.UUID, allowNull: false, field: "signature_request_id" },
      orderIndex: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "order_index" },
      name: { type: DataTypes.TEXT, allowNull: false },
      email: { type: DataTypes.TEXT, allowNull: false },
      dmsUserId: { type: DataTypes.UUID, allowNull: true, field: "edams_user_id" },
      assignedRole: { type: DataTypes.TEXT, allowNull: true, field: "assigned_role" },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
      signedAt: { type: DataTypes.DATE, allowNull: true, field: "signed_at" },
      declinedAt: { type: DataTypes.DATE, allowNull: true, field: "declined_at" },
      declineReason: { type: DataTypes.TEXT, allowNull: true, field: "decline_reason" },
      ipAddress: { type: DataTypes.TEXT, allowNull: true, field: "ip_address" },
      accessToken: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: "access_token",
        get() {
          return undefined;
        },
      },
      accessTokenHash: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: "access_token_hash",
        get() {
          return undefined;
        },
      },
      accessTokenExpires: { type: DataTypes.DATE, allowNull: true, field: "access_token_expires" },
      createdAt: { type: DataTypes.DATE, field: "created_at" },
    },
    { sequelize, tableName: "signature_recipients", timestamps: false, underscored: true }
  );
}
