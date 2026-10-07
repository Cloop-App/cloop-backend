const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/topics/:chapterId
 * Topics in a chapter, with the user's progress against each.
 */
router.get("/:chapterId", async (req, res) => {
  try {
    const chapterId = parseInt(req.params.chapterId, 10);
    const userId = req.user.user_id;

    const chapter = await prisma.global_chapters.findUnique({
      where: { id: chapterId },
      include: { subject: true },
    });

    if (!chapter) {
      return res.status(404).json({ error: "Chapter not found." });
    }

    const topics = await prisma.global_topics.findMany({
      where: { chapter_id: chapterId },
      orderBy: { order: "asc" },
    });

    // One query for the whole chapter rather than two per topic.
    const progress = await prisma.user_topic_progress.findMany({
      where: { user_id: userId, topic_id: { in: topics.map((t) => t.id) } },
    });
    const byTopic = new Map(progress.map((p) => [p.topic_id, p]));

    return res.json({
      chapter,
      topics: topics.map((topic) => {
        const seen = byTopic.get(topic.id);
        return {
          id: topic.id,
          title: topic.title,
          content: topic.content,
          is_completed: seen?.is_completed ?? false,
          completion_percent: Number(seen?.completion_percent ?? 0),
          time_spent_seconds: seen?.time_spent_seconds ?? 0,
        };
      }),
    });
  } catch (err) {
    console.error("Topics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
