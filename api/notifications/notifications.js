const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/notifications/
 * Get all notifications for the authenticated user.
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const notifications = await prisma.notification.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
    });

    return res.json(notifications);
  } catch (err) {
    console.error("Get notifications error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark a notification as read.
 * Verifies the notification belongs to the authenticated user.
 */
router.post("/:id/read", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const userId = req.user.user_id;

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification || notification.user_id !== userId) {
      return res.status(404).json({ error: "Notification not found." });
    }

    await prisma.notification.update({
      where: { id },
      data: { is_read: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/notifications/unread-count
 * Get the count of unread notifications.
 */
router.get("/unread-count", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const count = await prisma.notification.count({
      where: { user_id: userId, is_read: false },
    });

    return res.json({ count });
  } catch (err) {
    console.error("Unread count error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification.
 * Verifies the notification belongs to the authenticated user.
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const userId = req.user.user_id;

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification || notification.user_id !== userId) {
      return res.status(404).json({ error: "Notification not found." });
    }

    await prisma.notification.delete({ where: { id } });

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete notification error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/notifications/read-all
 * Mark all notifications as read.
 */
router.post("/read-all", async (req, res) => {
  try {
    const userId = req.user.user_id;

    await prisma.notification.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Read all error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
