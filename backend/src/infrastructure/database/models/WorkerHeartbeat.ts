import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

/**
 * DATA-3: cross-process worker liveness signal. The API and the BullMQ
 * worker are separate OS processes in every real deployment
 * (the production start script runs them as two windows specifically so a native
 * crash inside worker code can't take the API down with it), so an
 * in-process flag is invisible to the API process that serves
 * /operations/health. Postgres is the right channel: it's required
 * infrastructure regardless of Redis state, unlike Redis itself, which is
 * exactly what can be down when this matters.
 *
 * Single row (id = 'worker'), upserted at worker boot and re-touched on an
 * interval while the process is alive, so a later silent crash of the whole
 * worker process is observable too, not just a failure to start.
 */
export class WorkerHeartbeat extends Model<
  InferAttributes<WorkerHeartbeat>,
  InferCreationAttributes<WorkerHeartbeat>
> {
  declare id: string;
  declare status: string;
  declare reason: string | null;
  declare updatedAt: CreationOptional<Date>;
}

export function initWorkerHeartbeat() {
  WorkerHeartbeat.init(
    {
      id: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: true },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { sequelize, tableName: "worker_heartbeats", timestamps: false, underscored: true },
  );
}
