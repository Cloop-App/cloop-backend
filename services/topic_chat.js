const prisma = require("../lib/prisma");
const { chatCompletion } = require("./openai");
const { buildSystemPrompt, generateGreeting } = require("./topic_chat_helpers");
const { calculateSessionMetrics } = require("./topic_chat_metrics");
const { trackGoalProgress } = require("./learning_turns_tracker");

/**
 * Load or initialize a topic chat session.
 * Returns existing messages + goals, or creates the initial greeting.
 */
async function loadTopicChat(topicId, userId) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: {
      goals: { orderBy: { order: "asc" } },
      chapter: { include: { subject: true } },
    },
  });

  if (!topic) {
    throw new Error("Topic not found");
  }

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

  // Compute goal completion status from messages
  const goals = topic.goals.map((goal) => ({
    id: goal.id,
    title: goal.title,
    description: goal.description,
    completed: false, // Will be computed from chat history
  }));

  return { topic, messages, goals, initialGreeting };
}

/**
 * Process a user message in a topic chat.
 * Calls OpenAI, persists messages, updates goals, and returns the response.
 */
async function processMessage(topicId, userId, userMessage, sessionTimeSeconds) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { goals: { orderBy: { order: "asc" } } },
  });

  if (!topic) {
    throw new Error("Topic not found");
  }

  const user = await prisma.user.findUnique({ where: { user_id: userId } });

  // Load chat history for context
  const history = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "asc" },
  });

  // Persist the user message
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

  // Build messages array for OpenAI
  const systemPrompt = buildSystemPrompt(
    topic,
    topic.goals,
    user?.name || "Student",
    user?.preferred_language
  );

  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.message,
    })),
    { role: "user", content: userMessage },
  ];

  // Call OpenAI
  const aiResponseRaw = await chatCompletion(openaiMessages, { jsonMode: true });
  let aiResponse;
  try {
    aiResponse = JSON.parse(aiResponseRaw);
  } catch {
    // If AI didn't return valid JSON, wrap it
    aiResponse = {
      ai_messages: [{ message_type: "text", message: aiResponseRaw }],
      feedback: { is_correct: null, bubble_color: "default" },
      user_correction: null,
      goals_update: [],
      session_summary: null,
    };
  }

  // Persist AI messages
  const aiMessages = [];
  for (const msg of aiResponse.ai_messages || []) {
    const saved = await prisma.topicChat.create({
      data: {
        topic_id: topicId,
        user_id: userId,
        sender: "ai",
        message: msg.message,
        message_type: msg.message_type || "text",
      },
    });
    aiMessages.push(saved);
  }

  // Track goal progress
  if (aiResponse.goals_update?.length > 0) {
    await trackGoalProgress(topicId, userId, aiResponse.goals_update);
  }

  // Update topic completion if session summary is present
  let sessionSummary = aiResponse.session_summary || null;
  if (sessionSummary) {
    await prisma.topicChat.update({
      where: { id: savedUserMessage.id },
      data: { is_completed: true, completion_percent: 100 },
    });

    // Save report
    await calculateSessionMetrics(topicId, userId, sessionSummary);

    // Increment user chat count
    await prisma.user.update({
      where: { user_id: userId },
      data: { chat_count: { increment: 1 } },
    });
  }

  return {
    userMessage: savedUserMessage,
    aiMessages,
    feedback: aiResponse.feedback || { is_correct: null, bubble_color: "default" },
    userCorrection: aiResponse.user_correction || null,
    session_summary: sessionSummary,
  };
}

/**
 * Handle an option selection (Got it / Confused / End Session / Learn More).
 */
async function processOption(topicId, userId, chatId, option) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { goals: { orderBy: { order: "asc" } } },
  });

  const user = await prisma.user.findUnique({ where: { user_id: userId } });

  const history = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "asc" },
  });

  const systemPrompt = buildSystemPrompt(
    topic,
    topic.goals,
    user?.name || "Student",
    user?.preferred_language
  );

  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.message,
    })),
    {
      role: "user",
      content: `[Student selected option: "${option}"]`,
    },
  ];

  const aiResponseRaw = await chatCompletion(openaiMessages, { jsonMode: true });
  let aiResponse;
  try {
    aiResponse = JSON.parse(aiResponseRaw);
  } catch {
    aiResponse = {
      ai_messages: [{ message_type: "text", message: aiResponseRaw }],
      feedback: { is_correct: null, bubble_color: "default" },
    };
  }

  const aiMessages = [];
  for (const msg of aiResponse.ai_messages || []) {
    const saved = await prisma.topicChat.create({
      data: {
        topic_id: topicId,
        user_id: userId,
        sender: "ai",
        message: msg.message,
        message_type: msg.message_type || "text",
      },
    });
    aiMessages.push(saved);
  }

  return {
    aiMessages,
    feedback: aiResponse.feedback || { is_correct: null, bubble_color: "default" },
  };
}

module.exports = { loadTopicChat, processMessage, processOption };
