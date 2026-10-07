/**
 * Writes the audit record for one tutor turn.
 *
 * This is the module the pilot did not have. Three weeks of sessions produced
 * learning_turns rows in which 42% carried no goal_id, subject_id or
 * question_text, 58% carried no feedback, 74% recorded a mastery of zero on
 * answers that had been graded correct, and every row recorded a response time
 * of zero. None of that was a tutoring failure — it was a recording failure,
 * and it made the pedagogy impossible to audit.
 *
 * Every field written here is derived from what the orchestrator actually did,
 * never re-inferred and never guessed. Where a value genuinely does not exist
 * for a turn — the mastery of an ungraded PROBE answer, say — the column is
 * left null rather than defaulted to zero, so a later query can tell "not
 * applicable" from "scored nothing". That distinction is precisely what the
 * pilot's zero-filled mastery column destroyed.
 */

const prisma = require("../../lib/prisma");
const { OPEN_PER_GOAL, MCQ_PER_GOAL, questionTypeFor } = require("./state");

/** Questions one goal is budgeted, used to express progress through it. */
const QUESTIONS_PER_GOAL = OPEN_PER_GOAL + MCQ_PER_GOAL;

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** Running accuracy on a goal — the real mastery figure. */
function masteryOf(tally) {
  if (!tally || tally.total === 0) return null;
  return pct(tally.correct, tally.total);
}

/** How far through a goal's question budget the student has got. */
function coverageOf(tally) {
  if (!tally) return 0;
  return Math.min(100, pct(tally.total, QUESTIONS_PER_GOAL));
}

/**
 * The correction the student is owed.
 *
 * Guaranteed non-empty for every graded turn. A wrong answer with no feedback
 * is a dead end: the student cannot tell what was wrong, and the Socratic loop
 * has nothing to close over. 58% of the pilot's turns ended that way.
 */
function buildFeedbackText(evaluatorResult, graded) {
  if (!graded) return null;

  if (evaluatorResult.is_correct) {
    return evaluatorResult.complete_answer
      ? `Correct. ${evaluatorResult.complete_answer}`
      : "Correct.";
  }

  if (evaluatorResult.complete_answer) {
    return `Not quite. ${evaluatorResult.complete_answer}`;
  }
  if (evaluatorResult.error_type) {
    return `Not quite — ${String(evaluatorResult.error_type).toLowerCase()} error. Let's work through it again.`;
  }
  return "Not quite. Let's work through it again.";
}

/**
 * Build the learning_turns row for a turn. Pure, so it can be tested without a
 * database.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.chatId          - admin_chat row anchoring the session
 * @param {object} params.turn            - processTutorTurn result
 * @param {object} params.prevState       - session state before this turn
 * @param {object} params.topic           - { id, title, subject_id, subject_name }
 * @param {Array}  params.goals           - global_topic_goals for the topic
 * @param {string} params.studentMessage  - raw text the student sent
 * @param {string} [params.userName]
 * @param {number} [params.responseTimeSec]
 */
function buildTurnRecord({
  userId,
  chatId,
  turn,
  prevState,
  topic = {},
  goals = [],
  studentMessage,
  userName = null,
  responseTimeSec = 0,
}) {
  const { evaluatorResult, gradedThisTurn, nextState, answeredGoalIndex, answeredPhase } = turn;

  const goal = goals[answeredGoalIndex] || null;
  const tallyAfter = nextState.perGoal[answeredGoalIndex] || null;
  const tallyBefore = prevState?.perGoal?.[answeredGoalIndex] || null;

  return {
    user_id: userId,
    chat_id: chatId,
    // Null only when the topic genuinely has no goals. The pilot's 42% of
    // null goal_ids were sessions that did have them.
    goal_id: goal?.id ?? null,
    topic_id: topic.id ?? null,
    subject_id: topic.subject_id ?? null,
    user_name: userName,
    sender: "user",

    question_text: turn.lastQuestionText || null,
    user_answer_raw: studentMessage,
    corrected_answer: evaluatorResult.complete_answer || null,
    diff_html: evaluatorResult.diff_html || null,

    feedback_text: buildFeedbackText(evaluatorResult, gradedThisTurn),
    feedback_json: {
      is_correct: evaluatorResult.is_correct,
      score_percent: evaluatorResult.score_percent,
      error_type: evaluatorResult.error_type,
      suggested_action: evaluatorResult.suggested_action,
      reasoning: evaluatorResult.reasoning,
      resolved_answer: evaluatorResult.resolved_answer,
    },
    error_type: evaluatorResult.error_type || null,
    error_subtype: null,

    // Null, not false, when the turn was not an assessed answer. PROBE and
    // THEORY answers are thinking aloud; counting them as incorrect is what
    // dragged the pilot's correctness figure below its own target.
    is_correct: gradedThisTurn ? Boolean(evaluatorResult.is_correct) : null,
    score_percent: gradedThisTurn ? evaluatorResult.score_percent : null,
    response_time_sec: responseTimeSec,

    help_requested: turn.intent === "HELP" ? "yes" : "no",
    explain_loop_count: nextState.stuckStreak || 0,
    num_retries: nextState.consecutiveWrong || 0,

    goal_progress_before: coverageOf(tallyBefore),
    goal_progress_after: coverageOf(tallyAfter),
    mastery_score: masteryOf(tallyAfter),

    difficulty_level: null,
    topic_title: topic.title || null,
    subject_name: topic.subject_name || null,
    question_type: questionTypeFor(answeredPhase),
  };
}

/**
 * The pipeline's audit record for this turn.
 *
 * Everything the evaluator decided and the state machine did, so a session can
 * be replayed and questioned afterwards. The pilot had none of it — not
 * because anyone forgot to log, but because the pipeline that produces these
 * values was never wired up.
 */
function buildTurnLog({ userId, chatId, turn, topic = {}, goals = [], studentMessage }) {
  const { evaluatorResult, gradedThisTurn, nextState, answeredGoalIndex, answeredPhase } = turn;

  const goal = goals[answeredGoalIndex] || null;
  const tally = nextState.perGoal[answeredGoalIndex] || null;
  const bubbles = Array.isArray(turn.messages) ? turn.messages : [];
  const preview = bubbles.map((b) => b.message).filter(Boolean).join(" ").slice(0, 500);
  const report = turn.masteryReport;

  return {
    user_id: userId,
    topic_id: topic.id,
    chapter_id: topic.chapter_id ?? null,
    subject_id: topic.subject_id ?? null,
    goal_id: goal?.id ?? null,
    chat_id: chatId,

    intent: turn.intent,
    is_correct: gradedThisTurn ? Boolean(evaluatorResult.is_correct) : null,
    score_percent: gradedThisTurn ? evaluatorResult.score_percent : null,
    error_type: evaluatorResult.error_type || null,
    diff_html: evaluatorResult.diff_html || null,
    complete_answer: evaluatorResult.complete_answer || null,
    suggested_action: evaluatorResult.suggested_action || null,
    evaluator_reasoning: evaluatorResult.reasoning || null,

    phase: nextState.phase,
    answered_in_phase: answeredPhase,
    state_instruction: turn.stateInstruction,
    question_type: questionTypeFor(answeredPhase),
    goal_index: answeredGoalIndex,
    goal_total: nextState.goalTotal ?? goals.length,
    escalation_step: turn.escalationStep || 0,

    goal_correct: tally?.correct ?? 0,
    goal_total_questions: tally?.total ?? 0,
    goal_errors: tally?.errors ?? [],

    total_turns: nextState.totalTurns ?? 0,
    total_questions: nextState.totalQuestions ?? 0,
    consecutive_wrong: nextState.consecutiveWrong ?? 0,
    off_topic_streak: nextState.offTopicStreak ?? 0,
    stuck_streak: nextState.stuckStreak ?? 0,
    reteach_pending: Boolean(nextState.reteachPending),
    reveal_pending: Boolean(nextState.revealPending),

    user_message: studentMessage,
    ai_response_preview: preview || null,
    ai_bubble_count: bubbles.length,

    // Only meaningful once the session has something to report.
    mastery_score_percent: report?.overall_mastery_percent ?? null,
    performance_level: report?.performance_level ?? null,
    star_rating: report?.star_rating ?? null,
    end_reason: nextState.endedReason ?? null,

    was_graded: Boolean(gradedThisTurn),
  };
}

/**
 * A wrong answer, filed against the curriculum it belongs to.
 *
 * Returns null for anything that is not an assessed, incorrect answer, so an
 * unscored PROBE guess never shows up as a mistake the student made.
 */
function buildErrorRecord({ userId, chatId, turn, topic = {}, goals = [], studentMessage }, prevState) {
  const { evaluatorResult, gradedThisTurn, nextState, answeredGoalIndex, answeredPhase } = turn;
  if (!gradedThisTurn || evaluatorResult.is_correct !== false) return null;
  if (!topic.chapter_id || !topic.subject_id) return null;

  return {
    user_id: userId,
    topic_id: topic.id,
    chapter_id: topic.chapter_id,
    subject_id: topic.subject_id,
    goal_id: goals[answeredGoalIndex]?.id ?? null,
    chat_id: chatId,

    error_type: evaluatorResult.error_type || "Conceptual",
    severity: (evaluatorResult.score_percent ?? 0) === 0 ? "high" : "medium",

    question_text: turn.lastQuestionText || null,
    user_answer: studentMessage,
    correct_answer: evaluatorResult.complete_answer || null,
    diff_html: evaluatorResult.diff_html || null,
    score_percent: evaluatorResult.score_percent ?? 0,

    phase: answeredPhase,
    attempt_number: (nextState.consecutiveWrong ?? 0) + 1,
    was_retaught: Boolean(nextState.reteachPending),
    mastery_before: masteryOf(prevState?.perGoal?.[answeredGoalIndex]) ?? 0,
    mastery_after: masteryOf(nextState.perGoal[answeredGoalIndex]) ?? 0,
  };
}

/**
 * Persist the turn and the goal tally it changed.
 *
 * Failures are logged and swallowed, deliberately: the student's reply is the
 * product and has already been generated, so a database hiccup must not cost
 * them their answer. The tag is distinctive so this is alertable — silent loss
 * is what let the pilot run three weeks on half-empty rows, and the fix is to
 * make the loss loud, not to make it fatal.
 *
 * @returns {Promise<{ok: boolean, id?: number, error?: string}>}
 */
async function recordTurn(params) {
  let record, log, errorRecord;
  try {
    record = buildTurnRecord(params);
    log = buildTurnLog(params);
    errorRecord = buildErrorRecord(params, params.prevState);
  } catch (error) {
    console.error("[learning-turns] BUILD FAILED", error.message, {
      user_id: params.userId,
      chat_id: params.chatId,
    });
    return { ok: false, error: error.message };
  }

  try {
    const saved = await prisma.learning_turns.create({ data: record });
    await prisma.tutor_turn_logs.create({ data: log });
    if (errorRecord) await prisma.topic_chat_errors.create({ data: errorRecord });
    await upsertGoalProgress(params, record);
    return { ok: true, id: saved.id };
  } catch (error) {
    console.error("[learning-turns] PERSIST FAILED", error.message, {
      user_id: record.user_id,
      chat_id: record.chat_id,
      goal_id: record.goal_id,
      phase: log.phase,
      turn: log.total_turns,
    });
    return { ok: false, error: error.message };
  }
}

/**
 * Keep chat_goal_progress in step with the state machine's own tally.
 *
 * Only assessed turns move it. An acknowledgement or an "I don't know" is not
 * a question answered, and counting it as one inflates the denominator that
 * every completion figure is drawn from.
 *
 * Keyed on the session's anchor message, not this turn's. The table's unique
 * key is (chat_id, goal_id, user_id), so keying it on the current message
 * makes every turn a fresh row — which is how the pilot ended up with 2,209
 * progress rows describing 137 goals, and why goal completion read as 41%
 * when on the real grain it was 67%.
 */
async function upsertGoalProgress(params, record) {
  const { turn, goals = [], goalChatId } = params;
  if (!record.goal_id || !turn.gradedThisTurn) return;

  const chatId = goalChatId ?? record.chat_id;

  const tally = turn.nextState.perGoal[turn.answeredGoalIndex];
  if (!tally) return;

  const incorrect = Math.max(0, tally.total - tally.correct);
  // A goal is done once its budget of questions has been asked, whatever the
  // student scored — mastery is reported separately and a low score is a
  // result, not an incomplete goal.
  const isCompleted = tally.total >= QUESTIONS_PER_GOAL || turn.answeredGoalIndex < turn.nextState.goalIndex;

  await prisma.chat_goal_progress.upsert({
    where: {
      chat_id_goal_id_user_id: {
        chat_id: chatId,
        goal_id: record.goal_id,
        user_id: record.user_id,
      },
    },
    create: {
      chat_id: chatId,
      goal_id: record.goal_id,
      user_id: record.user_id,
      num_questions: tally.total,
      num_correct: tally.correct,
      num_incorrect: incorrect,
      is_completed: isCompleted,
    },
    update: {
      num_questions: tally.total,
      num_correct: tally.correct,
      num_incorrect: incorrect,
      is_completed: isCompleted,
      updated_at: new Date(),
    },
  });
}

module.exports = {
  recordTurn,
  buildTurnRecord,
  buildTurnLog,
  buildErrorRecord,
  buildFeedbackText,
  masteryOf,
  coverageOf,
  QUESTIONS_PER_GOAL,
};
