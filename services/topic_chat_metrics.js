const prisma = require("../lib/prisma");

/**
 * Persist session summary as a UserTopicReport.
 *
 * @param {number} topicId
 * @param {string} userId
 * @param {object} summary - parsed session_summary from AI response
 */
async function calculateSessionMetrics(topicId, userId, summary) {
  await prisma.userTopicReport.create({
    data: {
      user_id: userId,
      topic_id: topicId,
      total_questions: summary.total_questions || 0,
      correct_answers: summary.correct_answers || 0,
      incorrect_answers: summary.incorrect_answers || 0,
      score_percent: summary.score_percent || 0,
      star_rating: summary.star_rating || 0,
      performance_level: summary.performance_level || null,
      top_error_types: summary.top_error_types || [],
      weak_goals: summary.weak_goals || [],
      time_spent_seconds: summary.time_spent_seconds || 0,
    },
  });
}

module.exports = { calculateSessionMetrics };
