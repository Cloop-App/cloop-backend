const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/chapters/?subjectId=
 * [B6] Returns chapters for a subject, scoped to the authenticated user.
 * Includes topic counts and completion stats.
 */
router.get("/", async (req, res) => {
  try {
    const { subjectId } = req.query;
    const userId = req.user.user_id;

    if (!subjectId) {
      return res.status(400).json({ error: "subjectId query parameter is required." });
    }

    // Verify user is enrolled in this subject
    const enrolled = await prisma.userSubject.findUnique({
      where: {
        user_id_subject_id: { user_id: userId, subject_id: parseInt(subjectId) },
      },
    });

    if (!enrolled) {
      return res.status(403).json({ error: "You are not enrolled in this subject." });
    }

    const chapters = await prisma.chapter.findMany({
      where: { subject_id: parseInt(subjectId) },
      orderBy: { order: "asc" },
      include: {
        topics: {
          select: { id: true },
        },
      },
    });

    // Compute completion per chapter
    const chaptersWithProgress = await Promise.all(
      chapters.map(async (chapter) => {
        const totalTopics = chapter.topics.length;

        const completedTopics = await prisma.topicChat.findMany({
          where: {
            user_id: userId,
            topic: { chapter_id: chapter.id },
            is_completed: true,
          },
          distinct: ["topic_id"],
        });

        const completionPercent =
          totalTopics > 0 ? Math.round((completedTopics.length / totalTopics) * 100) : 0;

        return {
          id: chapter.id,
          title: chapter.title,
          subject_id: chapter.subject_id,
          total_topics: totalTopics,
          completed_topics: completedTopics.length,
          completion_percent: completionPercent,
        };
      })
    );

    return res.json({ chapters: chaptersWithProgress });
  } catch (err) {
    console.error("Chapters error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
