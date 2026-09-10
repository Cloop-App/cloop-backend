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
    const notifications = await prisma.notifications.findMany({
      where: { user_id: req.user.user_id },
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
 *
 * Scoped to the caller. Keyed on the id alone, any signed-in user could mark
 * — or delete, below — another user's notifications.
 */
router.post("/:id/read", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const { count } = await prisma.notifications.updateMany({
      where: { id, user_id: req.user.user_id },
      data: { is_read: true },
    });

    if (count === 0) {
      return res.status(404).json({ error: "Notification not found." });
    }

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
    const count = await prisma.notifications.count({
      where: { user_id: req.user.user_id, is_read: false },
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
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const { count } = await prisma.notifications.deleteMany({
      where: { id, user_id: req.user.user_id },
    });

    if (count === 0) {
      return res.status(404).json({ error: "Notification not found." });
    }

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
    await prisma.notifications.updateMany({
      where: { user_id: req.user.user_id, is_read: false },
      data: { is_read: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Read all error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
