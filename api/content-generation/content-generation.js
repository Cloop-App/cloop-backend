const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * POST /api/content-generation/generate
 * Queue content generation for a single subject.
 */
router.post("/generate", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { subjectId } = req.body;

    if (!subjectId) {
      return res.status(400).json({ error: "subjectId is required." });
    }

    // Upsert job — create if not exists, reset if failed
    const existing = await prisma.contentGenerationJob.findUnique({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
    });

    if (existing && existing.status === "completed") {
      return res.json({ success: true, message: "Content already generated." });
    }

    if (existing) {
      await prisma.contentGenerationJob.update({
        where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
        data: { status: "pending", error: null },
      });
    } else {
      await prisma.contentGenerationJob.create({
        data: { user_id: userId, subject_id: subjectId, status: "pending" },
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/content-generation/generate-all
 * Queue content generation for all of the user's subjects.
 */
router.post("/generate-all", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const userSubjects = await prisma.userSubject.findMany({
      where: { user_id: userId },
      select: { subject_id: true },
    });

    for (const { subject_id } of userSubjects) {
      const existing = await prisma.contentGenerationJob.findUnique({
        where: { user_id_subject_id: { user_id: userId, subject_id } },
      });

      if (!existing) {
        await prisma.contentGenerationJob.create({
          data: { user_id: userId, subject_id, status: "pending" },
        });
      } else if (existing.status === "failed") {
        await prisma.contentGenerationJob.update({
          where: { user_id_subject_id: { user_id: userId, subject_id } },
          data: { status: "pending", error: null },
        });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Generate all error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/content-generation/status/:userId/:subjectId
 * Get generation status for a specific subject.
 * NOTE: userId in the path is kept for backwards compatibility with mobile.
 * The authenticated user's ID is used for authorization.
 */
router.get("/status/:userId/:subjectId", async (req, res) => {
  try {
    const subjectId = parseInt(req.params.subjectId);

    const status = await prisma.contentGenerationJob.findUnique({
      where: {
        user_id_subject_id: { user_id: req.user.user_id, subject_id: subjectId },
      },
    });

    if (!status) {
      return res.json({ exists: false, status: null });
    }

    return res.json({ exists: true, status });
  } catch (err) {
    console.error("Status error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/content-generation/all-statuses/:userId
 * Get generation statuses for all of the user's subjects.
 * NOTE: userId in the path is kept for backwards compatibility with mobile.
 */
router.get("/all-statuses/:userId", async (req, res) => {
  try {
    const statuses = await prisma.contentGenerationJob.findMany({
      where: { user_id: req.user.user_id },
      include: { subject: true },
    });

    return res.json({ data: statuses });
  } catch (err) {
    console.error("All statuses error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/content-generation/reset
 * Reset content generation for a subject (delete generated content and re-queue).
 */
router.post("/reset", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { subjectId } = req.body;

    if (!subjectId) {
      return res.status(400).json({ error: "subjectId is required." });
    }

    // Delete existing chapters/topics for this subject
    await prisma.chapter.deleteMany({
      where: { subject_id: subjectId },
    });

    // Reset the job
    await prisma.contentGenerationJob.upsert({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
      update: { status: "pending", error: null },
      create: { user_id: userId, subject_id: subjectId, status: "pending" },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Reset error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
