import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class WebhookSubscription extends Model<InferAttributes<WebhookSubscription>, InferCreationAttributes<WebhookSubscription>> {
  declare id: CreationOptional<string>;
  declare tenantId: string;
  declare url: string;
  declare secret: string;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initWebhookSubscription() {
  WebhookSubscription.init(
    {
      id: uuidPk,
      tenantId: { type: DataTypes.UUID, allowNull: false },
      url: { type: DataTypes.STRING(255), allowNull: false },
      secret: { type: DataTypes.STRING(255), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE
    },
    {
      sequelize,
      tableName: "webhook_subscriptions",
      timestamps: true,
      underscored: true
    }
  );
}
