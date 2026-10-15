import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { Notification } from "../../infrastructure/database/index.js";
import { serializeBigInt } from "../../shared/bigintJson.js";
import { AppError } from "../../core/AppError.js";

export const notificationRoutes = Router();

notificationRoutes.get("/unread-count", requirePermission(PERMISSIONS.NOTIFICATION_READ), asyncHandler(async (req, res) => {
  const user = req.user!;
  const count = await Notification.count({
    where: { userId: user.userId, isRead: false },
  });
  res.json({ count });
}));

notificationRoutes.get("/", requirePermission(PERMISSIONS.NOTIFICATION_READ), asyncHandler(async (req, res) => {
  const user = req.user!;
  const notifications = await Notification.findAll({
    where: { userId: user.userId },
    order: [["createdAt", "DESC"]],
    limit: 50
  });
  res.json({ data: serializeBigInt(notifications) });
}));

notificationRoutes.patch("/:id/read", requirePermission(PERMISSIONS.NOTIFICATION_READ), asyncHandler(async (req, res) => {
  const user = req.user!;
  const id = String(req.params.id);
  const notification = await Notification.findByPk(id);
  if (!notification) throw new AppError(404, "ERR-NOTIFICATION-NOT-FOUND", "Notification not found");
  if (notification.userId !== user.userId) throw new AppError(403, "ERR-PERMISSION-DENIED", "Not your notification");
  await notification.update({ isRead: true, readAt: new Date() });
  res.json({ data: serializeBigInt(notification) });
}));

notificationRoutes.patch("/read-all", requirePermission(PERMISSIONS.NOTIFICATION_READ), asyncHandler(async (req, res) => {
  const user = req.user!;
  const [count] = await Notification.update(
    { isRead: true, readAt: new Date() },
    { where: { userId: user.userId, isRead: false } }
  );
  res.json({ success: true, count });
}));
