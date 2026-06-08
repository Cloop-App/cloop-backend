/**
 * Deterministic session state machine for the Cloop tutoring engine.
 *
 * Everything that must be reliable — which goal/phase we are in, how many
 * questions have been asked, per-goal scores, when to switch concept→exam,
 * when to predict a score, and which questions must never be repeated — is
 * computed here in plain JS from the persisted chat history. The LLM only
 * renders language; it never controls the flow. This is what makes the
 * academic experience reproducible instead of drifting like the reference chat.
 *
 * State is reconstructed from `metadata` blobs stored on AI "turn" messages
 * (see services/topic_chat.js). Each tutor turn stores:
 *   metadata = {
 *     kind: "turn",
 *     goalIndex, phase, question, technique,   // the question THIS turn asked
 *     grade: { ... }                            // grade of the PREVIOUS answer
 *   }
 * and score-prediction turns additionally carry metadata.score_prediction.
 */

// Tunables for the learning flow (kept here so they're easy to audit/adjust).
const CLARITY_CLEAR_THRESHOLD = 0.8; // >= this => concept is CLEAR, move to exam
const MAX_CONCEPT_QUESTIONS = 3; // safety cap so a struggling student still advances
const MIN_EXAM_QUESTIONS = 2;
const MAX_EXAM_QUESTIONS = 3;

const CONCEPT_TECHNIQUES = [
  "Predict",
  "Contrast",
  "MisconceptionCheck",
  "Transfer",
  "ErrorSpotting",
  "ExplainLikeIm5",
];
const EXAM_TECHNIQUES = ["Recall", "MiniProblem", "TeachBack"];

/**
 * Extract the ordered list of tutor "turn" events from chat history.
 * @param {Array<{sender:string, message:string, metadata?:any}>} history
 * @returns {Array<object>} turn metadata objects in chronological order
 */
function extractTurns(history) {
  const turns = [];
  for (const msg of history) {
    if (msg.sender !== "ai") continue;
    const meta = parseMetadata(msg.metadata);
    if (meta && meta.kind === "turn") turns.push(meta);
  }
  return turns;
}

function parseMetadata(meta) {
  if (!meta) return null;
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Reconstruct the live session state from history + the topic's goals.
 *
 * @param {Array} history  chat messages (chronological)
 * @param {Array<{id:number,title:string,description?:string}>} goals
 * @returns {object} state
 */
function reconstructState(history, goals) {
  const turns = extractTurns(history);

  // Per-goal accumulators.
  const perGoal = goals.map(() => ({
    conceptClarity: [], // clarity scores recorded in concept phase
    examScores: [], // score_percent/100 recorded in exam phase
    conceptAsked: 0,
    examAsked: 0,
  }));

  // Replay every recorded grade into the goal/phase it was graded under. At a
  // goal boundary the graded answer belongs to the OLD goal while the question
  // this turn asked opens the NEW goal, so we bucket by the grade's own stamp.
  for (const turn of turns) {
    const grade = turn.grade;
    if (!grade || typeof grade.gradedPhase !== "string") continue;
    const gi =
      typeof grade.gradedGoalIndex === "number" ? grade.gradedGoalIndex : turn.goalIndex;
    const g = perGoal[gi];
    if (!g) continue;
    if (grade.gradedPhase === "concept") {
      g.conceptClarity.push(clamp01(grade.concept_clarity_score));
    } else if (grade.gradedPhase === "exam") {
      g.examScores.push(clamp01((grade.score_percent || 0) / 100));
    }
  }

  // Count how many questions have been asked per goal/phase.
  for (const turn of turns) {
    const g = perGoal[turn.goalIndex];
    if (!g || !turn.question) continue;
    if (turn.phase === "concept") g.conceptAsked++;
    else if (turn.phase === "exam") g.examAsked++;
  }

  const lastTurn = turns[turns.length - 1] || null;
  const goalIndex = lastTurn ? lastTurn.goalIndex : 0;
  const phase = lastTurn ? lastTurn.phase : "concept";
  const lastQuestion = lastTurn ? lastTurn.question : null;

  const askedQuestions = turns
    .map((t) => t.question)
    .filter((q) => typeof q === "string" && q.trim().length > 0);

  const recentTechniques = turns
    .slice(-3)
    .map((t) => t.technique)
    .filter(Boolean);

  return {
    goals,
    goalIndex,
    phase,
    lastQuestion,
    askedQuestions,
    recentTechniques,
    perGoal,
    started: turns.length > 0,
  };
}

/**
 * Pick the technique for the NEXT question, honouring rotation rules:
 *  - concept phase never uses Recall
 *  - exam phase prefers Recall but not more than twice in a row
 *  - if there's a misconception, prefer a misconception-targeting technique
 *
 * @param {object} state
 * @param {"concept"|"exam"} phase
 * @param {object|null} grade
 * @returns {string}
 */
function pickTechnique(state, phase, grade) {
  if (phase === "exam") {
    const lastTwo = state.recentTechniques.slice(-2);
    const recallStreak = lastTwo.length === 2 && lastTwo.every((t) => t === "Recall");
    if (recallStreak) return "MiniProblem";
    return "Recall";
  }

  // Concept phase.
  if (grade && grade.misconception_guess) {
    const targeted = ["Contrast", "ErrorSpotting", "MisconceptionCheck"];
    const fresh = targeted.find((t) => !state.recentTechniques.includes(t));
    return fresh || "Contrast";
  }
  // Ensure each goal eventually uses at least one of Contrast/Transfer/ErrorSpotting.
  const conceptTurnsForGoal = state.perGoal[state.goalIndex]?.conceptAsked || 0;
  const required = ["Contrast", "Transfer", "ErrorSpotting"];
  if (conceptTurnsForGoal >= 1 && !state.recentTechniques.some((t) => required.includes(t))) {
    return required[0];
  }
  const fresh = CONCEPT_TECHNIQUES.find((t) => !state.recentTechniques.includes(t));
  return fresh || "Predict";
}

/**
 * Given the current state and the grade of the just-submitted answer, decide
 * the next step. This is the heart of the flow: concept → recheck → exam →
 * predict_score → next goal → ... → session_complete.
 *
 * Returns a `step` describing what the tutor should do next, plus the updated
 * scoring snapshot to persist.
 *
 * @param {object} state    from reconstructState
 * @param {object} grade    from answer_grader.gradeAnswer (the previous answer)
 * @returns {object} step
 */
function applyTransition(state, grade) {
  const { goalIndex, phase, goals } = state;
  const goal = goals[goalIndex];
  const g = state.perGoal[goalIndex];

  // Record this answer into the right bucket and remember which phase it was
  // graded under (so reconstruction stays correct on the next turn).
  const gradedPhase = phase;
  if (phase === "concept") {
    g.conceptClarity.push(clamp01(grade.concept_clarity_score));
    g.conceptAsked = Math.max(g.conceptAsked, 1);
  } else {
    g.examScores.push(clamp01((grade.score_percent || 0) / 100));
    g.examAsked = Math.max(g.examAsked, 1);
  }

  const conceptCount = g.conceptClarity.length;
  const examCount = g.examScores.length;
  const latestClarity = clamp01(grade.concept_clarity_score);

  // ── Concept phase: stay until CLEAR or the safety cap is hit. ──
  if (phase === "concept") {
    const isClear = latestClarity >= CLARITY_CLEAR_THRESHOLD;
    const capped = conceptCount >= MAX_CONCEPT_QUESTIONS;
    if (!isClear && !capped) {
      const understanding = latestClarity < 0.5 ? "UNCLEAR" : "PARTLY_CLEAR";
      return finalizeAskStep(state, {
        nextPhase: "concept",
        nextStepType: "recheck_understanding",
        understanding,
        gradedPhase,
        grade,
        allowMedia: true, // teaching aids welcome while concept is shaky
      });
    }
    // Concept is done — move to the exam phase.
    return finalizeAskStep(state, {
      nextPhase: "exam",
      nextStepType: "ask_exam_question",
      understanding: "CLEAR",
      gradedPhase,
      grade,
      allowMedia: false,
    });
  }

  // ── Exam phase: ask 2-3, then predict the score and advance. ──
  const examAvg = avg(g.examScores);
  const enough =
    examCount >= MAX_EXAM_QUESTIONS ||
    (examCount >= MIN_EXAM_QUESTIONS && examAvg >= 0.999); // 2 perfect answers is enough

  if (!enough) {
    return finalizeAskStep(state, {
      nextPhase: "exam",
      nextStepType: "continue_exam_question",
      understanding: "N/A",
      gradedPhase,
      grade,
      allowMedia: false,
    });
  }

  // Exam complete for this goal — emit a score prediction. Round the component
  // scores first and derive predicted_score from those rounded values so the
  // numbers shown to the student stay internally consistent
  // (concept*50 + exam*50 == predicted).
  const conceptScore = Math.round(clamp01(avg(g.conceptClarity)) * 100) / 100;
  const examScore = Math.round(clamp01(examAvg) * 100) / 100;
  const predictedScore = Math.round((conceptScore * 50 + examScore * 50) * 10) / 10;
  const scorePrediction = {
    goal_id: goal.id,
    goal_title: goal.title,
    concept_score: conceptScore,
    exam_score: examScore,
    predicted_score: predictedScore,
  };

  const isLastGoal = goalIndex >= goals.length - 1;
  if (isLastGoal) {
    return {
      action: "session_complete",
      gradedPhase,
      grade,
      goalIndex,
      nextPhase: phase,
      nextGoalTitle: goal.title,
      nextStepType: "predict_score",
      understanding: "N/A",
      technique: null,
      allowMedia: false,
      scorePrediction,
      sessionComplete: true,
    };
  }

  // Advance to the next goal's concept phase.
  const nextGoalIndex = goalIndex + 1;
  const stateForNext = { ...state, goalIndex: nextGoalIndex, phase: "concept" };
  const technique = pickTechnique(stateForNext, "concept", null);
  return {
    action: "ask_question",
    gradedPhase,
    grade,
    goalIndex: nextGoalIndex,
    nextPhase: "concept",
    nextGoalTitle: goals[nextGoalIndex].title,
    nextGoalDescription: goals[nextGoalIndex].description || null,
    nextStepType: "predict_score", // this turn both predicts AND opens the next goal
    understanding: "N/A",
    technique,
    allowMedia: true,
    scorePrediction,
    sessionComplete: false,
  };
}

/**
 * Build an "ask_question" step for the current goal (no goal advance).
 * @private
 */
function finalizeAskStep(state, opts) {
  const { nextPhase, gradedPhase, grade } = opts;
  const technique = pickTechnique(state, nextPhase, grade);
  const goal = state.goals[state.goalIndex];
  return {
    action: "ask_question",
    gradedPhase,
    grade,
    goalIndex: state.goalIndex,
    nextPhase,
    nextGoalTitle: goal.title,
    nextGoalDescription: goal.description || null,
    nextStepType: opts.nextStepType,
    understanding: opts.understanding,
    technique,
    allowMedia: opts.allowMedia,
    scorePrediction: null,
    sessionComplete: false,
  };
}

/**
 * Decide the very first question of a fresh session (no prior answer to grade).
 * @param {object} state
 * @returns {object} step
 */
function firstStep(state) {
  const technique = pickTechnique(state, "concept", null);
  const goal = state.goals[0];
  return {
    action: "ask_question",
    gradedPhase: null,
    grade: null,
    goalIndex: 0,
    nextPhase: "concept",
    nextGoalTitle: goal.title,
    nextGoalDescription: goal.description || null,
    nextStepType: "ask_concept_question",
    understanding: "N/A",
    technique,
    allowMedia: true,
    scorePrediction: null,
    sessionComplete: false,
  };
}

module.exports = {
  reconstructState,
  applyTransition,
  firstStep,
  pickTechnique,
  // exported for tests / tuning
  CLARITY_CLEAR_THRESHOLD,
  MAX_CONCEPT_QUESTIONS,
  MIN_EXAM_QUESTIONS,
  MAX_EXAM_QUESTIONS,
  CONCEPT_TECHNIQUES,
  EXAM_TECHNIQUES,
};
