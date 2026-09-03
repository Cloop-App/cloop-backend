/**
 * Build the system prompt for a topic chat session.
 * This configures the AI tutor's persona and expected response format.
 *
 * @param {{ title: string, content: string | null }} topic
 * @param {Array<{ title: string, description: string | null }>} goals
 * @param {string} userName
 * @param {string} [language]
 * @returns {string}
 */
function buildSystemPrompt(topic, goals, userName, language) {
  const goalList = goals
    .map((g, i) => `${i + 1}. ${g.title}${g.description ? `: ${g.description}` : ""}`)
    .join("\n");

  const langInstruction = language
    ? `Respond in ${language} unless the student writes in a different language.`
    : "";

  return `You are Cloop, a friendly and encouraging AI tutor helping ${userName} learn about "${topic.title}".

${topic.content ? `Topic content:\n${topic.content}\n` : ""}

Learning Goals:
${goalList}

Instructions:
- Ask one question at a time, progressing through the learning goals in order.
- After the student answers, evaluate their response and provide feedback.
- If the student's answer contains errors, provide a corrected version with specific corrections.
- Track which goals have been completed based on the student's demonstrated understanding.
- When all goals are completed, generate a session summary.
${langInstruction}

You MUST respond with a valid JSON object in this format:
{
  "ai_messages": [
    { "message_type": "text", "message": "Your response here" }
  ],
  "feedback": {
    "is_correct": true | false | null,
    "bubble_color": "green" | "red" | "default"
  },
  "user_correction": null | {
    "message_type": "user_correction",
    "diff_html": "<del>wrong</del> <ins>correct</ins>",
    "options": ["Got it", "Confused"]
  },
  "goals_update": [
    { "goal_index": 0, "completed": true }
  ],
  "session_summary": null | {
    "total_questions": 5,
    "correct_answers": 4,
    "incorrect_answers": 1,
    "score_percent": 80,
    "star_rating": 4,
    "performance_level": "Great",
    "top_error_types": ["conceptual"],
    "weak_goals": []
  }
}`;
}

/**
 * Generate an initial greeting for a topic chat.
 *
 * Returns null by design. The tutor opens every session with a question
 * (the Hook phase), so a canned greeting here would announce the topic and
 * ask permission to start — both of which the session arc forbids, and
 * neither of which the system prompt can suppress once this text is
 * persisted ahead of the model's first turn.
 *
 * @param {string} topicTitle
 * @param {string} userName
 * @returns {string | null}
 */
function generateGreeting(topicTitle, userName) {
  return null;
}

module.exports = { buildSystemPrompt, generateGreeting };
