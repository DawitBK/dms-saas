import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";

export class SavedSearch extends Model<InferAttributes<SavedSearch>, InferCreationAttributes<SavedSearch>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare name: string;
  declare query: string;
  declare filters: string | null;
  declare isShared: CreationOptional<boolean>;
  declare departmentId: string | null;
  declare createdAt: CreationOptional<Date>;
}

export function initSavedSearch() {
  SavedSearch.init(
    {
      id: uuidPk,
      userId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      query: { type: DataTypes.STRING(1000), allowNull: false },
      filters: DataTypes.STRING(2000),
      isShared: { type: DataTypes.BOOLEAN, defaultValue: false },
      departmentId: DataTypes.UUID,
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "saved_searches", timestamps: false, updatedAt: false , underscored: true}
  );
}
