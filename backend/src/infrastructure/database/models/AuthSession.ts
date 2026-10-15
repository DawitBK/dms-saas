import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class AuthSession extends Model<InferAttributes<AuthSession>, InferCreationAttributes<AuthSession>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare refreshToken: string;
  declare csrfToken: string;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare ipAddress: string | null;
  declare userAgent: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initAuthSession() {
  AuthSession.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      refreshToken: { type: DataTypes.STRING(500), allowNull: false },
      csrfToken: { type: DataTypes.STRING(255), allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      revokedAt: DataTypes.DATE,
      ipAddress: DataTypes.STRING(45),
      userAgent: DataTypes.STRING(500),
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "auth_sessions", timestamps: false, updatedAt: false, underscored: true}
  );
}
