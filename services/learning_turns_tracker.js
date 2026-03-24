const prisma = require("../lib/prisma");

/**
 * Track goal progress for a topic chat session.
 * Updates the completion status of goals in the topic_chats records.
 *
 * @param {number} topicId
 * @param {string} userId
 * @param {Array<{goal_index: number, completed: boolean}>} goalsUpdate
 */
async function trackGoalProgress(topicId, userId, goalsUpdate) {
  const goals = await prisma.topicGoal.findMany({
    where: { topic_id: topicId },
    orderBy: { order: "asc" },
  });

  const completedGoals = goalsUpdate.filter((g) => g.completed);
  const totalGoals = goals.length;
  const completedCount = completedGoals.length;
  const completionPercent = totalGoals > 0 ? (completedCount / totalGoals) * 100 : 0;

  // Update the latest chat message for this topic with completion info
  const latestChat = await prisma.topicChat.findFirst({
    where: { topic_id: topicId, user_id: userId },
    orderBy: { created_at: "desc" },
  });

  if (latestChat) {
    await prisma.topicChat.update({
      where: { id: latestChat.id },
      data: {
        completion_percent: completionPercent,
        is_completed: completionPercent >= 100,
      },
    });
  }
}

module.exports = { trackGoalProgress };
