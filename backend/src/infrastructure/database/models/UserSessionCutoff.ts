import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";

/**
 * Durable session-revocation cutoff: every access/refresh token for this user
 * whose `iat` is at or before `cutoffAt` is dead.
 *
 * R-04 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md). This used to live only in Redis, which
 * made revocation both losable (a flush or eviction silently un-revoked
 * everyone) and non-transactional — the permission change that prompted the
 * revocation committed first, so three call sites had to swallow revocation
 * failures with `.catch(logger.warn)` rather than 500 on a change that had
 * already applied. That left deactivation failing closed while demotion
 * failed open.
 *
 * Postgres is now the record and Redis is a read-through cache, so the cutoff
 * commits in the same transaction as the change that caused it.
 *
 * One row per user, upserted — bounded by headcount, never grows with token
 * or session volume.
 */
export class UserSessionCutoff extends Model<
  InferAttributes<UserSessionCutoff>,
  InferCreationAttributes<UserSessionCutoff>
> {
  declare userId: string;
  declare cutoffAt: Date;
  declare reason: string | null;
  declare updatedAt: CreationOptional<Date>;
}

export function initUserSessionCutoff() {
  UserSessionCutoff.init(
    {
      userId: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      cutoffAt: { type: DataTypes.DATE, allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: true },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    { sequelize, tableName: "user_session_cutoffs", timestamps: false, underscored: true },
  );
}
