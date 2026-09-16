const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/chapters/?subjectId=
 * Chapters for a subject the user is enrolled in, with their progress.
 *
 * Progress comes from user_chapter_progress rather than being counted out of
 * chat messages, which is what the previous version did — it treated any
 * completed chat as a completed topic and could not see a topic finished in
 * more than one sitting.
 */
router.get("/", async (req, res) => {
  try {
    const subjectId = parseInt(req.query.subjectId, 10);
    const userId = req.user.user_id;

    if (!Number.isInteger(subjectId)) {
      return res.status(400).json({ error: "subjectId query parameter is required." });
    }

    const enrolled = await prisma.user_subject_enrollment.findUnique({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
    });

    if (!enrolled) {
      return res.status(403).json({ error: "You are not enrolled in this subject." });
    }

    const chapters = await prisma.global_chapters.findMany({
      where: { subject_id: subjectId },
      orderBy: { order: "asc" },
      include: { topics: { select: { id: true } } },
    });

    const progress = await prisma.user_chapter_progress.findMany({
      where: { user_id: userId, chapter_id: { in: chapters.map((c) => c.id) } },
    });
    const byChapter = new Map(progress.map((p) => [p.chapter_id, p]));

    return res.json({
      chapters: chapters.map((chapter) => {
        const totalTopics = chapter.topics.length;
        const seen = byChapter.get(chapter.id);
        const completedTopics = seen?.completed_topics ?? 0;

        return {
          id: chapter.id,
          title: chapter.title,
          subject_id: chapter.subject_id,
          total_topics: totalTopics,
          completed_topics: completedTopics,
          completion_percent:
            totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 100) : 0,
        };
      }),
    });
  } catch (err) {
    console.error("Chapters error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
