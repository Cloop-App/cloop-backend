const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken, generateToken } = require("../../middleware/auth");
const { sendLoginNotifications } = require("../../services/notifications");
const { autoTriggerContentGeneration } = require("../../services/curriculum-auto-trigger");

const router = Router();

/**
 * Reject a request for someone else's account.
 *
 * These three routes authenticated the caller but never checked the id in the
 * path against them, so any signed-in user could read, change or delete any
 * other account by number.
 */
function ownAccountOnly(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id !== req.user.user_id) {
    res.status(403).json({ error: "You may only access your own account." });
    return null;
  }
  return id;
}

/**
 * POST /api/login/
 * Passwordless login via email or phone.
 */
router.post("/", async (req, res) => {
  try {
    const { emailOrPhone } = req.body;

    if (!emailOrPhone) {
      return res.status(400).json({ error: "Email or phone is required." });
    }

    const user = await prisma.users.findFirst({
      where: {
        OR: [{ email: emailOrPhone.toLowerCase() }, { phone: emailOrPhone }],
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const token = generateToken(user);

    // Fire login notifications asynchronously (do not await)
    sendLoginNotifications(user.user_id, user.name);

    return res.json({
      token,
      user: {
        user_id: user.user_id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/login/users/:id
 * Get user details.
 */
router.get("/users/:id", authenticateToken, async (req, res) => {
  try {
    const id = ownAccountOnly(req, res);
    if (id === null) return;

    const user = await prisma.users.findUnique({
      where: { user_id: id },
      include: {
        subject_enrollments: { include: { subject: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user });
  } catch (err) {
    console.error("Get user error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * PUT /api/login/users/:id
 * Update user details.
 *
 * grade_level and board are stored as text ("Class 9", "Central Board of
 * Secondary Education") and subjects as short codes, which is how the
 * curriculum catalog is keyed.
 */
router.put("/users/:id", authenticateToken, async (req, res) => {
  try {
    const id = ownAccountOnly(req, res);
    if (id === null) return;

    const { name, grade_level, board, subjects, preferred_language, study_goal, phone } = req.body;

    const user = await prisma.users.update({
      where: { user_id: id },
      data: {
        ...(name !== undefined && { name }),
        ...(grade_level !== undefined && { grade_level }),
        ...(board !== undefined && { board }),
        ...(preferred_language !== undefined && { preferred_language }),
        ...(study_goal !== undefined && { study_goal }),
        ...(phone !== undefined && { phone }),
        ...(Array.isArray(subjects) && { subjects }),
      },
    });

    // Subjects, board or grade changing all change which catalog applies.
    if (subjects !== undefined || grade_level !== undefined || board !== undefined) {
      await autoTriggerContentGeneration(id);
    }

    return res.json({ user });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/login/users/:id
 * Delete a user account.
 */
router.delete("/users/:id", authenticateToken, async (req, res) => {
  try {
    const id = ownAccountOnly(req, res);
    if (id === null) return;

    await prisma.users.delete({ where: { user_id: id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
