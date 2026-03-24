const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/topics/:chapterId
 * Returns topics for a chapter with user-specific completion and time data.
 */
router.get("/:chapterId", async (req, res) => {
  try {
    const chapterId = parseInt(req.params.chapterId);
    const userId = req.user.user_id;

    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      include: { subject: true },
    });

    if (!chapter) {
      return res.status(404).json({ error: "Chapter not found." });
    }

    const topics = await prisma.topic.findMany({
      where: { chapter_id: chapterId },
      orderBy: { order: "asc" },
    });

    // Attach user-specific progress to each topic
    const topicsWithProgress = await Promise.all(
      topics.map(async (topic) => {
        const latestChat = await prisma.topicChat.findFirst({
          where: { topic_id: topic.id, user_id: userId },
          orderBy: { created_at: "desc" },
        });

        // Sum time spent across all messages for this topic
        const timeAgg = await prisma.topicChat.aggregate({
          where: {
            topic_id: topic.id,
            user_id: userId,
            session_time_seconds: { not: null },
          },
          _max: { session_time_seconds: true },
        });

        return {
          id: topic.id,
          title: topic.title,
          content: topic.content,
          is_completed: latestChat?.is_completed || false,
          completion_percent: latestChat?.completion_percent || 0,
          time_spent_seconds: timeAgg._max.session_time_seconds || 0,
        };
      })
    );

    return res.json({ chapter, topics: topicsWithProgress });
  } catch (err) {
    console.error("Topics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
