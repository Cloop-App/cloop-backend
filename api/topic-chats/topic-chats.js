const { Router } = require("express");
const { authenticateToken } = require("../../middleware/auth");
const prisma = require("../../lib/prisma");
const { loadTutorChat, processMessage, processOption } = require("../../services/tutor_session");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/topic-chats/:topicId
 * Load a tutoring session — messages so far, goals, and the current phase.
 */
router.get("/:topicId", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId, 10);
    const userId = req.user.user_id;

    return res.json(await loadTutorChat(topicId, userId));
  } catch (err) {
    if (err.message === "Topic not found") {
      return res.status(404).json({ error: "Topic not found." });
    }
    console.error("Load topic chat error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/topic-chats/:topicId
 * One tutoring turn, through the full tutor-core pipeline:
 * evaluate -> advance state -> generate -> validate -> persist.
 */
router.post("/:topicId", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId, 10);
    const userId = req.user.user_id;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    return res.json(await processMessage(topicId, userId, message));
  } catch (err) {
    if (err.message === "Topic not found") {
      return res.status(404).json({ error: "Topic not found." });
    }
    console.error("Process message error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/topic-chats/:topicId/option
 * An option button ("Got it", "Confused"). Runs the same pipeline as a typed
 * message so the answer is evaluated and recorded rather than waved through.
 */
router.post("/:topicId/option", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId, 10);
    const userId = req.user.user_id;
    const { option } = req.body;

    if (!option) {
      return res.status(400).json({ error: "Option is required." });
    }

    return res.json(await processOption(topicId, userId, option));
  } catch (err) {
    if (err.message === "Topic not found") {
      return res.status(404).json({ error: "Topic not found." });
    }
    console.error("Option error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/topic-chats/:topicId/update-time
 * Record time spent on the topic.
 */
router.post("/:topicId/update-time", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId, 10);
    const userId = req.user.user_id;
    const { session_time_seconds } = req.body;

    if (session_time_seconds === undefined) {
      return res.status(400).json({ error: "session_time_seconds is required." });
    }

    await prisma.user_topic_progress.upsert({
      where: { user_id_topic_id: { user_id: userId, topic_id: topicId } },
      create: {
        user_id: userId,
        topic_id: topicId,
        time_spent_seconds: session_time_seconds,
        last_accessed_at: new Date(),
      },
      update: {
        time_spent_seconds: session_time_seconds,
        last_accessed_at: new Date(),
      },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Update time error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
