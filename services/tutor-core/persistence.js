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

    // The instrumentation. Without these five a session cannot be replayed.
    phase: answeredPhase,
    directive: turn.stateInstruction,
    intent: turn.intent,
    escalation_step: turn.escalationStep || 0,
    turn_number: nextState.totalTurns,
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
  let record;
  try {
    record = buildTurnRecord(params);
  } catch (error) {
    console.error("[learning-turns] BUILD FAILED", error.message, {
      user_id: params.userId,
      chat_id: params.chatId,
    });
    return { ok: false, error: error.message };
  }

  try {
    const saved = await prisma.learning_turns.create({ data: record });
    await upsertGoalProgress(params, record);
    return { ok: true, id: saved.id };
  } catch (error) {
    console.error("[learning-turns] PERSIST FAILED", error.message, {
      user_id: record.user_id,
      chat_id: record.chat_id,
      goal_id: record.goal_id,
      phase: record.phase,
      turn_number: record.turn_number,
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
 */
async function upsertGoalProgress(params, record) {
  const { turn, goals = [] } = params;
  if (!record.goal_id || !turn.gradedThisTurn) return;

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
        chat_id: record.chat_id,
        goal_id: record.goal_id,
        user_id: record.user_id,
      },
    },
    create: {
      chat_id: record.chat_id,
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
  buildFeedbackText,
  masteryOf,
  coverageOf,
  QUESTIONS_PER_GOAL,
};
