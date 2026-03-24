const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");

const router = Router();

/**
 * [B1] FIX: All three saved-topics endpoints now require authenticateToken.
 * Previously these were unprotected and accepted userId in query/body.
 * Now userId is derived from the JWT token.
 */
router.use(authenticateToken);

/**
 * GET /api/saved-topics/
 * Get the user's saved/bookmarked topics.
 * [B1] FIX: Was unprotected with ?userId= param. Now uses JWT user_id.
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const savedTopics = await prisma.savedTopic.findMany({
      where: { user_id: userId },
      include: {
        topic: {
          include: {
            chapter: {
              include: { subject: true },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    return res.json(
      savedTopics.map((st) => ({
        topic_id: st.topic_id,
        topics: {
          title: st.topic.title,
          subjects: st.topic.chapter?.subject?.name || null,
          chapters: st.topic.chapter?.title || null,
        },
      }))
    );
  } catch (err) {
    console.error("Get saved topics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/saved-topics/save
 * Save/bookmark a topic.
 * [B1] FIX: Was unprotected. Now uses JWT user_id.
 */
router.post("/save", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { topicId } = req.body;

    if (!topicId) {
      return res.status(400).json({ error: "topicId is required." });
    }

    const saved = await prisma.savedTopic.create({
      data: { user_id: userId, topic_id: topicId },
    });

    return res.json({ id: saved.id, user_id: saved.user_id, topic_id: saved.topic_id });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Topic already saved." });
    }
    console.error("Save topic error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/saved-topics/unsave
 * Remove a saved/bookmarked topic.
 * [B1] FIX: Was unprotected. Now uses JWT user_id.
 */
router.delete("/unsave", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { topicId } = req.body;

    if (!topicId) {
      return res.status(400).json({ error: "topicId is required." });
    }

    await prisma.savedTopic.deleteMany({
      where: { user_id: userId, topic_id: topicId },
    });

    return res.json({ message: "Topic unsaved successfully." });
  } catch (err) {
    console.error("Unsave topic error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
