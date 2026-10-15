import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class IdempotencyKey extends Model<InferAttributes<IdempotencyKey>, InferCreationAttributes<IdempotencyKey>> {
  declare id: CreationOptional<string>;
  declare key: string;
  declare userId: string;
  declare endpoint: string;
  declare responseBody: string;
  declare bodyHash: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare expiresAt: Date;
}

export function initIdempotencyKey() {
  IdempotencyKey.init(
    {
      id: uuidPk,
      key: { type: DataTypes.STRING(255), unique: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      endpoint: { type: DataTypes.STRING(255), allowNull: false },
      responseBody: { type: DataTypes.TEXT, allowNull: false },
      bodyHash: { type: DataTypes.STRING(64), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "idempotency_keys", timestamps: false, updatedAt: false , underscored: true}
  );
}
