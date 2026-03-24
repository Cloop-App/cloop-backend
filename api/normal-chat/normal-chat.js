const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");
const { chatCompletion } = require("../../services/openai");

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/normal-chat/
 * Get the user's free-form chat history.
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const messages = await prisma.normalChat.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "asc" },
    });

    return res.json({ messages });
  } catch (err) {
    console.error("Get normal chat error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/normal-chat/
 * Send a free-form message to the AI tutor.
 */
router.post("/", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    // Persist user message
    const userMessage = await prisma.normalChat.create({
      data: {
        user_id: userId,
        sender: "user",
        message,
      },
    });

    // Load recent history for context
    const history = await prisma.normalChat.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "asc" },
      take: 50,
    });

    const user = await prisma.user.findUnique({ where: { user_id: userId } });

    const openaiMessages = [
      {
        role: "system",
        content: `You are Cloop, a friendly AI tutor helping ${user?.name || "a student"} learn. Answer their questions clearly and helpfully. You can explain concepts, solve problems, provide examples, and encourage learning. Keep your responses educational and appropriate for a student.`,
      },
      ...history.map((msg) => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.message,
      })),
    ];

    const aiResponse = await chatCompletion(openaiMessages);

    // Persist AI response
    const aiMessage = await prisma.normalChat.create({
      data: {
        user_id: userId,
        sender: "ai",
        message: aiResponse,
      },
    });

    return res.json({ userMessage, aiMessage });
  } catch (err) {
    console.error("Normal chat error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/normal-chat/
 * Clear the user's free-form chat history.
 */
router.delete("/", async (req, res) => {
  try {
    const userId = req.user.user_id;

    await prisma.normalChat.deleteMany({ where: { user_id: userId } });

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete normal chat error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
