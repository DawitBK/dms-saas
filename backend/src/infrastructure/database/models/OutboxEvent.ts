import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from "sequelize";
import { sequelize } from "../sequelize.js";
import { uuidPk } from "./_shared.js";
import { getCorrelationId } from "../../../shared/requestContext.js";

export class OutboxEvent extends Model<InferAttributes<OutboxEvent>, InferCreationAttributes<OutboxEvent>> {
  declare id: CreationOptional<string>;
  declare documentId: string | null;
  declare type: string;
  declare channel: string;
  declare payload: string;
  declare status: CreationOptional<string>;
  declare attempts: CreationOptional<number>;
  declare maxAttempts: CreationOptional<number>;
  declare errorMsg: string | null;
  // Self-reference to the source outbox row that spawned this one as a
  // WEBHOOK fan-out (see outbox.ts enqueueWebhookFanout). Null for
  // non-fan-out rows (and for WEBHOOK rows created before this column
  // existed). A partial unique index on this column (WHERE channel =
  // 'WEBHOOK') guarantees at most one fan-out row per source event.
  declare sourceEventId: string | null;
  declare processAfter: CreationOptional<Date>;
  // Stamped when a row transitions to PROCESSING — the stale-PROCESSING
  // reclaim in outbox.ts anchors off THIS, not processAfter, so a slow
  // in-flight dispatch isn't mistaken for an abandoned one.
  declare processingStartedAt: Date | null;
  declare processedAt: Date | null;
  // Owning tenant (nullable — platform sentinels have none). Auto-stamped by
  // the beforeCreate hook from payload.tenantId when the producer didn't set
  // it explicitly; backs the outbox_events RLS policy (20260718000001).
  declare tenantId: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
}

export function initOutboxEvent() {
  OutboxEvent.init(
    {
      id: uuidPk,
      documentId: DataTypes.UUID,
      type: { type: DataTypes.STRING(100), allowNull: false },
      channel: { type: DataTypes.STRING(50), allowNull: false },
      payload: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.STRING(20), defaultValue: "PENDING" },
      attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
      maxAttempts: { type: DataTypes.INTEGER, defaultValue: 3 },
      errorMsg: DataTypes.STRING(2000),
      sourceEventId: { type: DataTypes.UUID, allowNull: true },
      processAfter: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      processingStartedAt: DataTypes.DATE,
      processedAt: DataTypes.DATE,
      tenantId: { type: DataTypes.STRING(100), allowNull: true },
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    },
    { sequelize, tableName: "outbox_events", timestamps: false, updatedAt: false , underscored: true}
  );

  // Inject correlationId from the current request context into every outbox event payload
  // so distributed traces can be reconstructed from the queue worker logs.
  OutboxEvent.addHook("beforeCreate", (event: OutboxEvent) => {
    const correlationId = getCorrelationId();
    if (correlationId) {
      try {
        const parsed = JSON.parse(event.payload as string);
        event.payload = JSON.stringify({ ...parsed, correlationId });
      } catch {
        // payload was not valid JSON; leave it unchanged
      }
    }
    // Stamp the tenant column from the payload convention so every producer
    // that already carries payload.tenantId gets the RLS column for free.
    if (!event.tenantId) {
      try {
        const tenantId = JSON.parse(event.payload as string)?.tenantId;
        if (typeof tenantId === "string" && tenantId) event.tenantId = tenantId;
      } catch {
        /* non-JSON payload */
      }
    }
  });
}
