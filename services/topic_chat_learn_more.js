const prisma = require("../lib/prisma");
const { chatCompletion } = require("./openai");

/**
 * Handle the "Learn More" flow for a topic chat.
 * Generates additional explanatory content for the current topic.
 *
 * @param {number} topicId
 * @param {string} userId
 * @returns {Promise<object>} Additional AI messages
 */
async function handleLearnMore(topicId, userId) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { chapter: { include: { subject: true } } },
  });

  if (!topic) {
    throw new Error("Topic not found");
  }

  const history = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "asc" },
    take: 20, // last 20 messages for context
  });

  const messages = [
    {
      role: "system",
      content: `You are Cloop, an AI tutor. The student wants to learn more about "${topic.title}". Provide additional explanations, examples, or practice questions to deepen their understanding. Respond in plain text (not JSON).`,
    },
    ...history.map((msg) => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.message,
    })),
    {
      role: "user",
      content: "I want to learn more about this topic. Can you explain further?",
    },
  ];

  const response = await chatCompletion(messages);

  const saved = await prisma.topicChat.create({
    data: {
      topic_id: topicId,
      user_id: userId,
      sender: "ai",
      message: response,
      message_type: "text",
    },
  });

  return { aiMessages: [saved] };
}

module.exports = { handleLearnMore };
