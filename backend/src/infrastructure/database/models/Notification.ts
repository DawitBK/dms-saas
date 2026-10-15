import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare tenantId: string | null;
  declare documentId: string | null;
  declare letterId: string | null;
  declare type: string;
  declare title: string;
  declare body: string;
  declare isRead: CreationOptional<boolean>;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export function initNotification() {
  Notification.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      tenantId: { type: DataTypes.STRING(100), allowNull: true },
      documentId: DataTypes.UUID,
      letterId: DataTypes.UUID,
      type: { type: DataTypes.STRING(100), allowNull: false },
      title: { type: DataTypes.STRING(255), allowNull: false },
      body: { type: DataTypes.STRING(2000), allowNull: false },
      isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
      readAt: DataTypes.DATE,
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "notifications", timestamps: false, updatedAt: false , underscored: true}
  );
}
