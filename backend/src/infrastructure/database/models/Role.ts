import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare description: string | null;
}

export function initRole() {
  Role.init(
    { id: uuidPk, name: { type: DataTypes.STRING(50), unique: true }, description: DataTypes.STRING(500) },
    { sequelize, tableName: "roles", timestamps: false, underscored: true}
  );
}
