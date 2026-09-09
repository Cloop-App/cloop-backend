/**
 * The tutoring loop, on the production tables.
 *
 * What ran during the pilot was a single model call given a system prompt and
 * the chat history, and asked to behave like a tutor. tutor-core — the
 * evaluator, the state machine, the escalation ladder and the validator — was
 * built and tested but wired to nothing, so none of it reached a student.
 * That is the gap this module closes: every turn now goes through
 * processTutorTurn, and the server decides the phase, the directive and the
 * question type rather than hoping the model will.
 *
 *   student message
 *     -> admin_chat row (gives the turn its chat_id)
 *     -> processTutorTurn  (evaluate -> advance -> generate -> validate)
 *     -> admin_chat rows for the reply
 *     -> learning_turns row + chat_goal_progress  (persistence.js)
 *     -> tutor_sessions.state
 */

const prisma = require("../lib/prisma");
const { processTutorTurn } = require("./tutor-core/orchestrator");
const { recordTurn } = require("./tutor-core/persistence");
const { initialState } = require("./tutor-core/state");

/** Turns of chat handed to the generator for conversational continuity. */
const HISTORY_WINDOW = 8;

/** A pause longer than this is the student leaving, not thinking. */
const MAX_RESPONSE_SECONDS = 600;

/**
 * Load the topic, its goals, and the subject they sit under.
 * Throws "Topic not found" so callers can map it to a 404.
 */
async function loadTopic(topicId) {
  const topic = await prisma.global_topics.findUnique({
    where: { id: topicId },
    include: {
      goals: { orderBy: { order: "asc" } },
      chapter: { include: { subject: true } },
    },
  });

  if (!topic) throw new Error("Topic not found");
  return topic;
}

/** Flatten a topic record into what the orchestrator and the turn record need. */
function topicContext(topic) {
  return {
    id: topic.id,
    title: topic.title,
    content: topic.content || "",
    subject_id: topic.subject_id ?? topic.chapter?.subject?.id ?? null,
    subject_name: topic.chapter?.subject?.name ?? null,
  };
}

/**
 * The open session for this student and topic, or a new one.
 *
 * State lives in the row, not in memory: a process restart between two turns
 * must not send the student back to PROBE.
 */
async function openSession(userId, topicId, goalTotal) {
  const existing = await prisma.tutor_sessions.findFirst({
    where: { user_id: userId, topic_id: topicId, is_active: true },
    orderBy: { started_at: "desc" },
  });
  if (existing) return existing;

  return prisma.tutor_sessions.create({
    data: {
      user_id: userId,
      topic_id: topicId,
      state: initialState(goalTotal),
    },
  });
}

/**
 * Load a session for display: the messages so far, the goals, and how far the
 * student has got.
 */
async function loadTutorChat(topicId, userId) {
  const topic = await loadTopic(topicId);
  const session = await openSession(userId, topicId, topic.goals.length);

  const messages = await prisma.admin_chat.findMany({
    where: { session_id: session.id },
    orderBy: { created_at: "asc" },
  });

  const progress = await prisma.chat_goal_progress.findMany({
    where: { user_id: userId, goal_id: { in: topic.goals.map((g) => g.id) } },
  });
  const completed = new Set(progress.filter((p) => p.is_completed).map((p) => p.goal_id));

  return {
    topic,
    session_id: session.id,
    phase: session.state.phase,
    messages,
    goals: topic.goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      completed: completed.has(goal.id),
    })),
  };
}

/** Seconds the student took, measured from the tutor's last message. */
function elapsedSince(lastAiMessage) {
  if (!lastAiMessage?.created_at) return 0;
  const seconds = (Date.now() - new Date(lastAiMessage.created_at).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(Math.min(seconds, MAX_RESPONSE_SECONDS) * 10) / 10;
}

/**
 * Run one turn.
 *
 * @param {number} topicId
 * @param {number} userId
 * @param {string} studentMessage
 */
async function processMessage(topicId, userId, studentMessage) {
  const topic = await loadTopic(topicId);
  const goals = topic.goals;
  const session = await openSession(userId, topicId, goals.length);

  const history = await prisma.admin_chat.findMany({
    where: { session_id: session.id },
    orderBy: { created_at: "desc" },
    take: HISTORY_WINDOW,
  });
  history.reverse();

  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  const lastAiMessage = [...history].reverse().find((m) => m.sender === "ai");
  const responseTimeSec = elapsedSince(lastAiMessage);

  // Persisted before the model runs, so the turn has a chat_id to hang off and
  // the student's words survive even if generation fails.
  const savedUserMessage = await prisma.admin_chat.create({
    data: {
      user_id: userId,
      session_id: session.id,
      sender: "user",
      message: studentMessage,
      message_type: "text",
    },
  });

  const turn = await processTutorTurn({
    studentMessage,
    topic: topicContext(topic),
    goals,
    chatHistory: history,
    currentState: session.state,
    userProfile: { grade_level: user?.grade_level, board: user?.board, name: user?.name },
  });

  // A correction belongs on the student's own message, which is where the app
  // renders the strikethrough and the emoji.
  if (turn.userCorrection) {
    await prisma.admin_chat.update({
      where: { id: savedUserMessage.id },
      data: {
        message_type: "user_correction",
        diff_html: turn.userCorrection.diff_html,
        emoji: turn.userCorrection.emoji,
      },
    });
  }

  const aiMessages = [];
  for (const bubble of turn.messages) {
    aiMessages.push(
      await prisma.admin_chat.create({
        data: {
          user_id: userId,
          session_id: session.id,
          sender: "ai",
          message: bubble.message,
          message_type: bubble.message_type || "text",
          options: Array.isArray(bubble.options)
            ? bubble.options.map((o) => (typeof o === "string" ? o : o.text || o.value || ""))
            : [],
        },
      })
    );
  }

  await recordTurn({
    userId,
    chatId: savedUserMessage.id,
    turn,
    prevState: session.state,
    topic: topicContext(topic),
    goals,
    studentMessage,
    userName: user?.name || null,
    responseTimeSec,
  });

  if (turn.masteryReport) {
    await persistMasteryReport(userId, topicId, turn.masteryReport);
  }

  const finished = turn.nextState.phase === "DONE";
  await prisma.tutor_sessions.update({
    where: { id: session.id },
    data: {
      state: turn.nextState,
      is_active: !finished,
      ended_reason: finished ? turn.nextState.endedReason || "complete" : null,
      ended_at: finished ? new Date() : null,
      updated_at: new Date(),
    },
  });

  return {
    userMessage: savedUserMessage,
    aiMessages,
    userCorrection: turn.userCorrection,
    phase: turn.nextState.phase,
    directive: turn.stateInstruction,
    mastery_report: turn.masteryReport,
    mermaid_diagram: turn.mermaid_diagram,
    all_goals_completed: turn.all_goals_completed,
  };
}

/**
 * Save the end-of-session report.
 *
 * Every figure comes from the tallies the state machine kept as answers were
 * graded. The path this replaces read them out of a `session_summary` the
 * model wrote about its own teaching, which is how a report could claim a
 * score the session had not earned.
 */
async function persistMasteryReport(userId, topicId, report) {
  const row = {
    total_questions: report.total_questions,
    correct_answers: report.correct_answers,
    incorrect_answers: report.incorrect_answers,
    score_percent: report.overall_mastery_percent,
    star_rating: report.star_rating,
    performance_level: report.performance_level,
    metrics_json: {
      overall_band: report.overall_band,
      goals_covered: report.goals_covered,
      goals_total: report.goals_total,
      ended_reason: report.ended_reason,
      top_error_types: report.top_error_types,
      weak_goals: report.weak_goals,
      learned_well: report.learned_well,
      not_covered: report.not_covered,
      per_goal: report.per_goal,
    },
  };

  await prisma.user_topic_reports.upsert({
    where: { user_id_topic_id: { user_id: userId, topic_id: topicId } },
    create: { user_id: userId, topic_id: topicId, ...row },
    update: { ...row, updated_at: new Date() },
  });
}

/**
 * An option button ("Got it", "Confused") is just a student turn whose text
 * the app chose. Routing it through the same path means it is evaluated,
 * scored and recorded like any other — during the pilot these bypassed
 * assessment entirely.
 */
async function processOption(topicId, userId, option) {
  return processMessage(topicId, userId, option);
}

module.exports = {
  loadTutorChat,
  processMessage,
  processOption,
  persistMasteryReport,
  topicContext,
  elapsedSince,
};
