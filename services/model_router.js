/**
 * Tiered model router — send each turn to the cheapest model that can do it well.
 *
 * Rationale (recommended cost strategy): most turns — greetings, affirming a
 * correct answer, asking a recall/exam question, the closing message — do not
 * need a frontier model. Reserve the expensive tier for genuine diagnostic
 * reasoning: judging a concept answer and analysing misconceptions.
 *
 * Three tiers, each configurable per provider via env so you can point them at
 * DeepSeek, OpenAI, Claude, etc. without touching code:
 *   MODEL_CHEAP  — routine generation (default deepseek-chat)
 *   MODEL_MID    — factual grading / light teaching (default deepseek-chat)
 *   MODEL_SMART  — misconception diagnosis (default deepseek-reasoner)
 *
 * Only the routing DECISIONS live here (pure functions, fully testable); the
 * actual call still goes through services/openai.js:chatCompletion.
 */

const TIERS = {
  cheap: process.env.MODEL_CHEAP || "deepseek-chat",
  mid: process.env.MODEL_MID || "deepseek-chat",
  smart: process.env.MODEL_SMART || "deepseek-reasoner",
};

/**
 * Which model should GRADE this answer?
 * - Concept answers carry misconception risk → SMART (this is the diagnosis).
 * - Exam answers are factual recall checks → MID (accuracy matters, but the
 *   judgement is simpler). No-attempts never reach the LLM at all.
 *
 * @param {{phase: "concept"|"exam"}} ctx
 * @returns {string} model id
 */
function routeGrader(ctx) {
  return ctx.phase === "exam" ? TIERS.mid : TIERS.smart;
}

/**
 * Which model should RENDER this tutor turn?
 * - Confusion / teaching / recheck / struggle check-in → SMART/MID (the turn
 *   must teach well and adapt to the misconception).
 * - Everything else — opener, correct-answer affirmation, exam question,
 *   score prediction, closing — is low-stakes → CHEAP.
 *
 * @param {object} step   the state-machine step
 * @param {object|null} grade
 * @returns {string} model id
 */
function routeTutor(step, grade) {
  const confused = !!(grade && !grade.is_correct && !grade.is_no_attempt);
  const teachingStep =
    step.nextStepType === "recheck_understanding" ||
    step.nextStepType === "struggle_checkin" ||
    step.allowMedia === true ||
    step.extension === true;

  if (confused || teachingStep) return TIERS.mid;
  return TIERS.cheap;
}

/**
 * Classify a turn as "routine" (cheap) or "diagnostic" (needs a better model).
 * Exposed for logging / analytics so you can see the cheap/expensive split.
 */
function classifyTurn(step, grade) {
  const model = routeTutor(step, grade);
  return { model, tier: model === TIERS.cheap ? "routine" : "diagnostic" };
}

module.exports = { routeGrader, routeTutor, classifyTurn, TIERS };
