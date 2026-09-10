const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { generateToken } = require("../../middleware/auth");
const { sendLoginNotifications } = require("../../services/notifications");
const { SUBJECT_NAMES } = require("../../services/curriculum");

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

    const existing = await prisma.users.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return res.status(409).json({ error: "User with this email already exists." });
    }

    const user = await prisma.users.create({
      data: {
        name,
        email: email.toLowerCase(),
        phone: phone || null,
        subjects: [],
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
 * Dropdown data for onboarding: grades, boards, languages, subjects.
 *
 * Subjects come from the code list rather than the catalog: catalog entries
 * exist per board and grade, so before a student has picked either there is
 * nothing there to offer them.
 */
router.get("/options", async (req, res) => {
  try {
    const [grades, boards, languages] = await Promise.all([
      prisma.grade_levels.findMany({ orderBy: { id: "asc" } }),
      prisma.boards.findMany({ orderBy: { id: "asc" } }),
      prisma.languages.findMany({ where: { is_active: true }, orderBy: { id: "asc" } }),
    ]);

    const subjects = Object.entries(SUBJECT_NAMES).map(([code, name]) => ({ code, name }));

    return res.json({ grades, boards, languages, subjects });
  } catch (err) {
    console.error("Options error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
