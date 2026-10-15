import { DataTypes } from "sequelize";

export const uuidPk = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
