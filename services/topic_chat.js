const prisma = require("../lib/prisma");
const { generateGreeting } = require("./topic_chat_helpers");
const { runTutorTurn } = require("./tutor_engine");
const { saveSessionReport } = require("./topic_chat_metrics");

/**
 * Cloop tutoring orchestrator (persistence adapter).
 *
 * All pedagogy — grounded grading, deterministic flow/scoring, turn rendering
 * and visual-aid selection — lives in services/tutor_engine.js (pure, testable).
 * This module only loads history, writes the engine's output to the database,
 * and shapes the HTTP response.
 */

/**
 * Load or initialize a topic chat session.
 */
async function loadTopicChat(topicId, userId) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: {
      goals: { orderBy: { order: "asc" } },
      chapter: { include: { subject: true } },
    },
  });

  if (!topic) throw new Error("Topic not found");

  const messages = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "asc" },
  });

  const user = await prisma.user.findUnique({ where: { user_id: userId } });

  let initialGreeting = null;
  if (messages.length === 0) {
    const greetingText = generateGreeting(topic.title, user?.name || "Student");
    const greeting = await prisma.topicChat.create({
      data: {
        topic_id: topicId,
        user_id: userId,
        sender: "ai",
        message: greetingText,
        message_type: "text",
      },
    });
    messages.push(greeting);
    initialGreeting = greetingText;
  }

  const goals = topic.goals.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
  }));

  return { topic, messages, goals, initialGreeting };
}

/**
 * Process a user message: run the engine and persist its output.
 *
 * @param {number} topicId
 * @param {string} userId
 * @param {string} userMessage
 * @param {number} [sessionTimeSeconds]
 * @param {object} [deps]  injectable LLM callers for testing { grade, tutor }
 */
async function processMessage(topicId, userId, userMessage, sessionTimeSeconds, deps = {}) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { goals: { orderBy: { order: "asc" } } },
  });
  if (!topic) throw new Error("Topic not found");
  if (!topic.goals.length) throw new Error("Topic has no learning goals");

  const user = await prisma.user.findUnique({ where: { user_id: userId } });

  const history = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "asc" },
  });

  // Persist the student's message.
  const savedUserMessage = await prisma.topicChat.create({
    data: {
      topic_id: topicId,
      user_id: userId,
      sender: "user",
      message: userMessage,
      message_type: "text",
      session_time_seconds: sessionTimeSeconds || null,
    },
  });

  const goals = topic.goals.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
  }));

  // Run the pure engine.
  const result = await runTutorTurn(
    {
      history,
      topic: { title: topic.title, content: topic.content },
      goals,
      userMessage,
      studentName: user?.name || "Student",
      language: user?.preferred_language || null,
    },
    deps
  );

  // Persist the AI rows in order.
  const aiMessages = [];
  for (const row of result.aiRows) {
    const saved = await prisma.topicChat.create({
      data: { topic_id: topicId, user_id: userId, sender: "ai", ...row },
    });
    aiMessages.push(saved);
  }

  // On completion, persist the aggregated report and mark the session done.
  let sessionSummary = null;
  if (result.sessionComplete) {
    sessionSummary = await saveSessionReport({
      topicId,
      userId,
      goals,
      finalPrediction: result.finalPrediction,
    });
    await prisma.topicChat.update({
      where: { id: savedUserMessage.id },
      data: { is_completed: true, completion_percent: 100 },
    });
    await prisma.user.update({
      where: { user_id: userId },
      data: { chat_count: { increment: 1 } },
    });
  }

  const response = { ...result.response };
  if (sessionSummary) response.session_summary = sessionSummary;

  return { userMessage: savedUserMessage, aiMessages, response };
}

/**
 * Handle a tap option (e.g. "Learn More") as a normal student turn.
 */
async function processOption(topicId, userId, chatId, option) {
  return processMessage(topicId, userId, `[Student selected: ${option}]`);
}

module.exports = { loadTopicChat, processMessage, processOption };
