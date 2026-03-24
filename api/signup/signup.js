const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { generateToken } = require("../../middleware/auth");
const { sendLoginNotifications } = require("../../services/notifications");

const router = Router();

/**
 * POST /api/signup/
 * Register a new user.
 */
router.post("/", async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return res.status(409).json({ error: "User with this email already exists." });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        phone: phone || null,
      },
    });

    const token = generateToken(user);

    // Send welcome notifications asynchronously
    sendLoginNotifications(user.user_id, user.name);

    return res.status(201).json({
      token,
      user: {
        user_id: user.user_id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/signup/options
 * Returns dropdown data for onboarding: grades, boards, languages, subjects.
 */
router.get("/options", async (req, res) => {
  try {
    const [grades, boards, languages, subjects] = await Promise.all([
      prisma.gradeLevel.findMany({ orderBy: { id: "asc" } }),
      prisma.board.findMany({ orderBy: { id: "asc" } }),
      prisma.language.findMany({ orderBy: { id: "asc" } }),
      prisma.subject.findMany({ orderBy: { id: "asc" } }),
    ]);

    return res.json({ grades, boards, languages, subjects });
  } catch (err) {
    console.error("Options error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
