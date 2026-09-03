const prisma = require("../lib/prisma");
const { chatCompletion } = require("./openai");
const { buildSystemPrompt, generateGreeting } = require("./topic_chat_helpers");
const { parseTutorResponse } = require("./topic_chat_response");
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

  // The tutor opens with its own Hook question, so a canned greeting is
  // normally suppressed. generateGreeting returning null leaves the chat
  // empty until the model's first turn.
  let initialGreeting = null;
  if (messages.length === 0) {
    const greetingText = generateGreeting(topic.title, user?.name || "Student");
    if (greetingText) {
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

  // Call the model, and retry once if the turn comes back unusable. A turn
  // with no renderable message must never be persisted: it reaches the
  // student as a blank chat bubble.
  const aiResponse = await requestTutorTurn(openaiMessages);

  // Persist AI messages. parseTutorResponse has already dropped blanks and
  // normalised the message key, so anything here is safe to render.
  const aiMessages = [];
  for (const msg of aiResponse.ai_messages) {
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

  const aiResponse = await requestTutorTurn(openaiMessages);

  const aiMessages = [];
  for (const msg of aiResponse.ai_messages) {
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

/**
 * Ask the model for one tutor turn, retrying once when the reply is not
 * usable JSON or carries nothing renderable.
 *
 * A blank chat bubble is always a bug, never a legitimate turn, so the retry
 * is not optional: without it a single malformed reply is shown to the
 * student as an empty message.
 *
 * @param {Array<{role: string, content: string}>} openaiMessages
 * @returns {Promise<object>} a normalised tutor turn
 */
async function requestTutorTurn(openaiMessages) {
  const REPAIR =
    "Your last reply was not usable. Reply with ONE valid json object and " +
    "nothing else: no prose, no markdown, no code fences. It must contain a " +
    'non-empty "ai_messages" array.';

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages =
      attempt === 1
        ? openaiMessages
        : [...openaiMessages, { role: "system", content: REPAIR }];

    const raw = await chatCompletion(messages, { jsonMode: true });
    const result = parseTutorResponse(raw);
    last = result;

    if (result.note) {
      console.warn(`[topic_chat] attempt ${attempt}: ${result.note}`);
    }
    if (result.parseOk && result.hasMessages) return result.response;
    console.warn(
      `[topic_chat] attempt ${attempt} unusable ` +
        `(parseOk=${result.parseOk}, messages=${result.response.ai_messages.length})`
    );
  }

  // Both attempts failed. Return whatever text we salvaged rather than an
  // empty turn; if even that is empty, say something honest instead of
  // rendering nothing.
  if (!last.hasMessages) {
    last.response.ai_messages = [
      {
        message_type: "text",
        message: "Sorry, that did not come through. Could you send that again?",
      },
    ];
  }
  return last.response;
}

module.exports = { loadTopicChat, processMessage, processOption };
