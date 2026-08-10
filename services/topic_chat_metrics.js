const prisma = require("../lib/prisma");

/**
 * Derive a star rating (0-5) and a human label from an overall percentage.
 */
function ratingFor(percent) {
  const star = Math.max(0, Math.min(5, Math.round(percent / 20)));
  let level = "Needs Practice";
  if (percent >= 85) level = "Excellent";
  else if (percent >= 70) level = "Great";
  else if (percent >= 55) level = "Good";
  else if (percent >= 40) level = "Fair";
  return { star, level };
}

function parseMeta(meta) {
  if (!meta) return null;
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

/**
 * Aggregate the per-goal score predictions recorded across the session into a
 * single UserTopicReport. Pulls every persisted `score_prediction` metadata row
 * (plus the just-computed final prediction) so the report reflects the whole
 * topic, not a single LLM guess.
 *
 * @param {object} args
 * @param {number} args.topicId
 * @param {string} args.userId
 * @param {Array<{id:number,title:string}>} args.goals
 * @param {object|null} [args.finalPrediction]  the prediction for the last goal
 * @returns {Promise<object>} the saved summary
 */
async function saveSessionReport({ topicId, userId, goals, finalPrediction }) {
  const rows = await prisma.topicChat.findMany({
    where: { topic_id: topicId, user_id: userId, message_type: "score_prediction" },
    orderBy: { created_at: "asc" },
  });

  // Collect one prediction per goal_id (latest wins), then add the final one.
  const byGoal = new Map();
  for (const r of rows) {
    const m = parseMeta(r.metadata);
    if (m && m.goal_id != null) byGoal.set(m.goal_id, m);
  }
  if (finalPrediction && finalPrediction.goal_id != null) {
    byGoal.set(finalPrediction.goal_id, finalPrediction);
  }

  const predictions = [...byGoal.values()];
  const goalScores = goals.map((g) => {
    const p = byGoal.get(g.id);
    return {
      goal_id: g.id,
      goal_title: g.title,
      predicted_score: p ? p.predicted_score : null,
    };
  });

  const scored = predictions.map((p) => p.predicted_score).filter((n) => typeof n === "number");
  const overall = scored.length
    ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10
    : 0;

  const { star, level } = ratingFor(overall);

  // Weak goals = scored below 60%.
  const weakGoals = goalScores
    .filter((g) => typeof g.predicted_score === "number" && g.predicted_score < 60)
    .map((g) => g.goal_title);

  const summary = {
    total_goals: goals.length,
    goals_scored: scored.length,
    score_percent: overall,
    star_rating: star,
    performance_level: level,
    weak_goals: weakGoals,
    goal_scores: goalScores,
  };

  await prisma.userTopicReport.create({
    data: {
      user_id: userId,
      topic_id: topicId,
      total_questions: 0,
      correct_answers: 0,
      incorrect_answers: 0,
      score_percent: overall,
      star_rating: star,
      performance_level: level,
      top_error_types: [],
      weak_goals: weakGoals,
      time_spent_seconds: 0,
      goal_scores: goalScores,
    },
  });

  return summary;
}

module.exports = { saveSessionReport, ratingFor };
