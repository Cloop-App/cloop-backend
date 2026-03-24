const { Router } = require("express");
const { authenticateToken } = require("../../middleware/auth");
const prisma = require("../../lib/prisma");
const { loadTopicChat, processMessage, processOption } = require("../../services/topic_chat");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/topic-chats/:topicId
 * Load a topic chat session — returns messages, goals, and initial greeting.
 */
router.get("/:topicId", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId);
    const userId = req.user.user_id;

    const result = await loadTopicChat(topicId, userId);
    return res.json(result);
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
 * Send a user message and get AI response.
 * Full pipeline: persist → OpenAI → parse → persist AI msgs → update goals → summary.
 */
router.post("/:topicId", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId);
    const userId = req.user.user_id;
    const { message, session_time_seconds } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const result = await processMessage(topicId, userId, message, session_time_seconds);
    return res.json(result);
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
 * Handle option button selection (Got it / Confused / End Session / Learn More).
 */
router.post("/:topicId/option", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId);
    const userId = req.user.user_id;
    const { chatId, option } = req.body;

    if (!option) {
      return res.status(400).json({ error: "Option is required." });
    }

    const result = await processOption(topicId, userId, chatId, option);
    return res.json(result);
  } catch (err) {
    console.error("Option error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/topic-chats/:topicId/update-time
 * Update the session time for a topic chat.
 */
router.post("/:topicId/update-time", async (req, res) => {
  try {
    const topicId = parseInt(req.params.topicId);
    const userId = req.user.user_id;
    const { session_time_seconds } = req.body;

    if (session_time_seconds === undefined) {
      return res.status(400).json({ error: "session_time_seconds is required." });
    }

    // Update the latest chat message with the session time
    const latestChat = await prisma.topicChat.findFirst({
      where: { topic_id: topicId, user_id: userId },
      orderBy: { created_at: "desc" },
    });

    if (latestChat) {
      await prisma.topicChat.update({
        where: { id: latestChat.id },
        data: { session_time_seconds },
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Update time error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
