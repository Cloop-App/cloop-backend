/**
 * Stage 1 of the tutoring engine: grade the student's answer.
 *
 * Runs a low-temperature LLM call grounded in the topic's curriculum content,
 * then normalises and sanity-checks the result so downstream scoring is always
 * well-formed. The LLM is injectable for testing.
 */

const { chatCompletion } = require("./openai");
const { buildGraderSystemPrompt } = require("./cloop_prompt");
const { safeJsonParse } = require("../lib/json");

const NO_ATTEMPT_PATTERNS = [
  /^\s*$/,
  /^(i\s*)?(dont|don'?t|do not)\s*know\b/i,
  /^idk\b/i,
  /^no\s*(idea|clue)\b/i,
  /^skip\b/i,
  /^pass\b/i,
  /^\?+$/,
];

/** Cheap deterministic no-attempt detector (backstop for the grader). */
function looksLikeNoAttempt(answer) {
  const a = (answer || "").trim();
  if (a.length === 0) return true;
  return NO_ATTEMPT_PATTERNS.some((re) => re.test(a));
}

function clampStep(n) {
  // Snap to the 0 / 0.5 / 1 rubric.
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  if (x <= 0.25) return 0;
  if (x < 0.75) return 0.5;
  return 1;
}

function clampPercent(n) {
  const x = Math.round(Number(n));
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

/**
 * Normalise a raw grader payload into a guaranteed-valid grade object.
 * @param {object|null} raw
 * @param {string} answer
 * @returns {object}
 */
function normalizeGrade(raw, answer) {
  const noAttempt =
    (raw && raw.is_no_attempt === true) || looksLikeNoAttempt(answer);

  if (noAttempt) {
    return {
      is_no_attempt: true,
      is_correct: false,
      correctness: 0,
      reasoning_quality: 0,
      completeness: 0,
      concept_clarity_score: 0.1,
      score_percent: 10,
      error_type: "Knowledge Gap",
      misconception_guess: null,
      diff_html: null,
      complete_answer:
        (raw && typeof raw.complete_answer === "string" && raw.complete_answer) ||
        "",
    };
  }

  const correctness = clampStep(raw?.correctness);
  const reasoning = clampStep(raw?.reasoning_quality);
  const completeness = clampStep(raw?.completeness);
  const clarity =
    typeof raw?.concept_clarity_score === "number"
      ? Math.max(0, Math.min(1, Math.round(raw.concept_clarity_score * 100) / 100))
      : Math.round(((correctness + reasoning + completeness) / 3) * 100) / 100;

  // is_correct must be consistent with the sub-scores, regardless of what the
  // model claimed — this is the guardrail against "Correct!" on wrong answers.
  const isCorrect = correctness === 1 && completeness >= 0.5;

  let errorType =
    typeof raw?.error_type === "string" && raw.error_type ? raw.error_type : "None";
  if (isCorrect && (errorType === "None" || !errorType)) {
    // keep "None" unless there's a genuine spelling/grammar slip flagged via diff
  }
  if (!isCorrect && (errorType === "None" || !errorType)) {
    errorType = "Conceptual Error";
  }

  // diff_html only survives if it actually contains a correction markup.
  let diff = typeof raw?.diff_html === "string" ? raw.diff_html.trim() : null;
  if (diff && !/<del>.*<\/del>/i.test(diff)) diff = null;

  return {
    is_no_attempt: false,
    is_correct: isCorrect,
    correctness,
    reasoning_quality: reasoning,
    completeness,
    concept_clarity_score: clarity,
    score_percent: clampPercent(
      raw?.score_percent != null ? raw.score_percent : isCorrect ? 100 : clarity * 100
    ),
    error_type: errorType,
    misconception_guess:
      typeof raw?.misconception_guess === "string" && raw.misconception_guess.trim()
        ? raw.misconception_guess.trim()
        : null,
    diff_html: diff,
    complete_answer:
      typeof raw?.complete_answer === "string" ? raw.complete_answer : "",
  };
}

/**
 * Grade a student answer against the active question and curriculum.
 *
 * @param {object} args
 * @param {string} args.answer
 * @param {string} args.question
 * @param {"concept"|"exam"} args.phase
 * @param {object} args.topic            { title, content }
 * @param {object} args.goal             { title, description }
 * @param {string} [args.gradeBand]
 * @param {(messages:any[], opts:any)=>Promise<string>} [llm]  injectable for tests
 * @returns {Promise<object>} normalized grade
 */
async function gradeAnswer(args, llm = chatCompletion) {
  const { answer, question, phase, topic, goal, gradeBand } = args;

  // Fast-path no-attempts without spending an LLM call.
  if (looksLikeNoAttempt(answer)) {
    return normalizeGrade({ is_no_attempt: true }, answer);
  }

  const system = buildGraderSystemPrompt({
    topicTitle: topic.title,
    topicContent: topic.content,
    goalTitle: goal.title,
    goalDescription: goal.description,
    question,
    phase,
    gradeBand,
  });

  const messages = [
    { role: "system", content: system },
    { role: "user", content: `STUDENT ANSWER:\n"${answer}"` },
  ];

  let raw = null;
  try {
    const out = await llm(messages, { jsonMode: true, temperature: 0 });
    raw = safeJsonParse(out, null);
  } catch (err) {
    // On any grader failure, fall back to a neutral partial grade so the
    // session can continue rather than crash.
    console.error("[grader] failed:", err.message);
    raw = null;
  }

  if (!raw) {
    return {
      is_no_attempt: false,
      is_correct: false,
      correctness: 0.5,
      reasoning_quality: 0.5,
      completeness: 0.5,
      concept_clarity_score: 0.5,
      score_percent: 50,
      error_type: "Partially Correct",
      misconception_guess: null,
      diff_html: null,
      complete_answer: "",
    };
  }

  return normalizeGrade(raw, answer);
}

module.exports = { gradeAnswer, normalizeGrade, looksLikeNoAttempt };
