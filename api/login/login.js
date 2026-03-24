const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken, generateToken } = require("../../middleware/auth");
const { sendLoginNotifications } = require("../../services/notifications");

const router = Router();

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

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: emailOrPhone.toLowerCase() },
          { phone: emailOrPhone },
        ],
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
 * Get user details by ID.
 * [B2] FIX: Added authenticateToken — was previously unprotected.
 * Users can only access their own data.
 */
router.get("/users/:id", authenticateToken, async (req, res) => {
  try {
    if (req.params.id !== req.user.user_id) {
      return res.status(403).json({ error: "Access denied." });
    }

    const user = await prisma.user.findUnique({
      where: { user_id: req.params.id },
      include: {
        grade_level: true,
        board: true,
        user_subjects: { include: { subject: true } },
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
 * [B2] FIX: Added authenticateToken — was previously unprotected.
 * Users can only update their own data.
 */
router.put("/users/:id", authenticateToken, async (req, res) => {
  try {
    if (req.params.id !== req.user.user_id) {
      return res.status(403).json({ error: "Access denied." });
    }

    const { name, grade_level_id, board_id, subjects, language_id, study_goal, phone } =
      req.body;

    const user = await prisma.user.update({
      where: { user_id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(grade_level_id !== undefined && { grade_level_id }),
        ...(board_id !== undefined && { board_id }),
        ...(language_id !== undefined && { preferred_language: String(language_id) }),
        ...(study_goal !== undefined && { study_goal }),
        ...(phone !== undefined && { phone }),
      },
    });

    // If subjects array provided, sync user subjects
    if (subjects && Array.isArray(subjects)) {
      await prisma.userSubject.deleteMany({ where: { user_id: req.params.id } });
      for (const subjectId of subjects) {
        await prisma.userSubject.create({
          data: { user_id: req.params.id, subject_id: subjectId },
        });
      }
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
 * [B2] FIX: Added authenticateToken — was previously unprotected.
 * Users can only delete their own account.
 */
router.delete("/users/:id", authenticateToken, async (req, res) => {
  try {
    if (req.params.id !== req.user.user_id) {
      return res.status(403).json({ error: "Access denied." });
    }

    await prisma.user.delete({ where: { user_id: req.params.id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
