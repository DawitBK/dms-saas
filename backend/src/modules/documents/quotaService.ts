// S4-10: Pre-flight quota check + atomic storage_used_bytes

import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { sequelize } from "../../infrastructure/database/index.js";
import { QueryTypes, Transaction } from "sequelize";

/**
 * S4-10: Check if tenant has enough storage quota before upload
 * Returns 413 STORAGE_QUOTA_EXCEEDED if over limit
 * @deprecated Use reserveStorageQuota instead for transactional safety
 */
export async function checkStorageQuota(tenantId: string, fileSizeBytes: number): Promise<void> {
  const [result] = await sequelize.query<{ storage_quota_bytes: string; storage_used_bytes: string }>(
    `SELECT "storageQuotaBytes" as storage_quota_bytes, "storageUsedBytes" as storage_used_bytes 
     FROM tenants 
     WHERE id = :tenantId`,
    {
      replacements: { tenantId },
      type: QueryTypes.SELECT
    }
  );

  if (!result) {
    logger.debug({ tenantId }, 'tenant row missing — skipping quota check');
    return;
  }

  const quotaBytes = BigInt(result.storage_quota_bytes || "0");
  const usedBytes = BigInt(result.storage_used_bytes || "0");
  const fileSizeBigInt = BigInt(fileSizeBytes);

  if (usedBytes + fileSizeBigInt > quotaBytes) {
    logger.warn(
      {
        tenantId,
        quotaBytes: quotaBytes.toString(),
        usedBytes: usedBytes.toString(),
        requestedBytes: fileSizeBigInt.toString()
      },
      "Storage quota exceeded"
    );

    throw new AppError(
      413,
      "STORAGE_QUOTA_EXCEEDED",
      `Storage quota exceeded. Used: ${usedBytes}, Quota: ${quotaBytes}, Requested: ${fileSizeBigInt}`
    );
  }

  logger.debug(
    {
      tenantId,
      quotaBytes: quotaBytes.toString(),
      usedBytes: usedBytes.toString(),
      fileSizeBytes: fileSizeBigInt.toString(),
      remainingBytes: (quotaBytes - usedBytes).toString()
    },
    "Storage quota check passed"
  );
}

/**
 * BUG 4 FIX: Atomically check quota and reserve storage within a transaction
 * This prevents concurrent uploads from exceeding quota
 * @param tenantId - The tenant ID
 * @param fileSizeBytes - The file size to reserve
 * @param transaction - The transaction to use (optional: the conditional
 *   UPDATE is a single statement and therefore atomic on its own — callers
 *   outside an explicit transaction, like trash-restore, may omit it)
 * @throws AppError with 413 STORAGE_QUOTA_EXCEEDED if quota would be exceeded
 */
export async function reserveStorageQuota(
  tenantId: string,
  fileSizeBytes: number,
  transaction?: Transaction
): Promise<void> {
  const fileSize = BigInt(fileSizeBytes);
  
  // Atomic conditional UPDATE with row lock - use RAW type for UPDATE with RETURNING
  const [results] = await sequelize.query(
    `UPDATE tenants 
     SET "storageUsedBytes" = "storageUsedBytes" + :fileSize,
         "updatedAt" = NOW()
     WHERE id = :tenantId 
       AND "storageUsedBytes" + :fileSize <= "storageQuotaBytes"
     RETURNING "storageUsedBytes", "storageQuotaBytes"`,
    {
      replacements: { tenantId, fileSize: fileSize.toString() },
      type: QueryTypes.RAW,
      transaction
    }
  ) as any;

  // For PostgreSQL UPDATE with RETURNING, results is an array of returned rows
  if (!results || (results as any[]).length === 0) {
    // Either tenant doesn't exist or quota would be exceeded
    // Fetch current values for better error message
    const [tenant] = await sequelize.query<{ storage_quota_bytes: string; storage_used_bytes: string }>(
      `SELECT "storageQuotaBytes" as storage_quota_bytes, "storageUsedBytes" as storage_used_bytes 
       FROM tenants 
       WHERE id = :tenantId`,
      {
        replacements: { tenantId },
        type: QueryTypes.SELECT,
        transaction
      }
    );

    if (!tenant) {
      logger.error({ tenantId }, 'Tenant not found during quota reservation');
      throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');
    }

    const quotaBytes = BigInt(tenant.storage_quota_bytes || "0");
    const usedBytes = BigInt(tenant.storage_used_bytes || "0");

    logger.warn(
      {
        tenantId,
        quotaBytes: quotaBytes.toString(),
        usedBytes: usedBytes.toString(),
        requestedBytes: fileSize.toString()
      },
      "Storage quota exceeded (atomic check)"
    );

    throw new AppError(
      413,
      "STORAGE_QUOTA_EXCEEDED",
      `Storage quota exceeded. Used: ${usedBytes}, Quota: ${quotaBytes}, Requested: ${fileSize}`
    );
  }

  logger.debug({ tenantId, fileSizeBytes }, "Storage quota reserved atomically");
}

// L11: incrementStorageUsed (the deprecated, non-atomic counterpart of
// reserveStorageQuota) lost its last caller when trash-restore switched to the
// atomic reservation — removed rather than left as a bug-shaped attractive
// nuisance.

/**
 * S4-10: Atomically decrement storage_used_bytes after delete/trash
 */
export async function decrementStorageUsed(tenantId: string, fileSizeBytes: number): Promise<void> {
  await sequelize.query(
    `UPDATE tenants 
     SET "storageUsedBytes" = GREATEST("storageUsedBytes" - :fileSize, 0),
         "updatedAt" = NOW()
     WHERE id = :tenantId`,
    {
      replacements: { tenantId, fileSize: fileSizeBytes.toString() },
      type: QueryTypes.UPDATE
    }
  );

  logger.debug({ tenantId, fileSizeBytes }, "Storage usage decremented");
}

/**
 * Get current storage usage for a tenant
 */
export async function getStorageUsage(tenantId: string) {
  const [result] = await sequelize.query<{ storage_quota_bytes: string; storage_used_bytes: string }>(
    `SELECT "storageQuotaBytes" as storage_quota_bytes, "storageUsedBytes" as storage_used_bytes 
     FROM tenants 
     WHERE id = :tenantId`,
    {
      replacements: { tenantId },
      type: QueryTypes.SELECT
    }
  );

  if (!result) {
    return { quotaBytes: '0', usedBytes: '0', remainingBytes: '0', percentUsed: 0 };
  }

  const quotaBytes = BigInt(result.storage_quota_bytes || "0");
  const usedBytes = BigInt(result.storage_used_bytes || "0");
  const percentUsed = quotaBytes > 0 ? Number((usedBytes * BigInt(100)) / quotaBytes) : 0;

  return {
    quotaBytes: quotaBytes.toString(),
    usedBytes: usedBytes.toString(),
    remainingBytes: (quotaBytes - usedBytes).toString(),
    percentUsed
  };
}

/**
 * Check if quota warning should be emitted (>80% used)
 */
export function shouldEmitQuotaWarning(percentUsed: number): boolean {
  return percentUsed >= 80;
}
