/**
 * Cloop SLM Orchestration Layer v1.0
 * -------------------------------------------------------------------------
 * The "SLM" in Cloop's architecture is NOT a model that owns academic truth.
 * Per the ontology / pipeline / mastery specs, it is a reasoning &
 * communication component that operates strictly over the structured state
 * the deterministic engine produces:
 *
 *     ACADEMIC GRAPH + MASTERY ENGINE + PIPELINE  →  state packet  →  SLM  →  dialogue
 *
 * This module turns a §29 state packet + adaptive plan into an age-appropriate
 * explanation / diagnostic question / hint / Socratic prompt, under hard
 * guardrails (never reveal the final answer when disallowed, never invent
 * unverified academic content, never claim to change mastery).
 *
 * Today it orchestrates a general model (gpt-4o via services/openai.js) with a
 * constrained contract. When the verified interaction corpus exists, the same
 * contract is what a fine-tuned Cloop-specific SLM would be trained to satisfy
 * — so this layer is stable across that migration; only the backing model
 * changes. The `completion` function is injectable so the layer is testable
 * without any network access.
 */

const SLM_VERSION = "cloop-slm-orchestrator-v1.0";

// Maps an adaptive action (Stage I) to the SLM's concrete communication goal.
const ACTION_GOALS = {
  DIAGNOSTIC_QUESTION: {
    goal: "Ask ONE targeted diagnostic question that reveals whether the student holds the suspected misconception. Do not explain or give the answer.",
    reveal_answer: false,
    expects: "question",
  },
  SOCRATIC_DIALOGUE: {
    goal: "Ask ONE Socratic question that leads the student to examine their own reasoning about the target concept. Do not state the correct answer.",
    reveal_answer: false,
    expects: "question",
  },
  MICRO_EXPLANATION: {
    goal: "Give a concise (2–4 sentence) conceptual clarification of the target concept at the student's level. Correct the misconception directly but briefly.",
    reveal_answer: false,
    expects: "explanation",
  },
  COUNTEREXAMPLE: {
    goal: "Present ONE clear counterexample that disconfirms the student's incorrect rule/belief, then ask them what it implies.",
    reveal_answer: false,
    expects: "explanation",
  },
  VISUAL_REPRESENTATION: {
    goal: "Describe a diagram/graph the student should draw or picture, and ask them to reason from it. Do not solve it for them.",
    reveal_answer: false,
    expects: "explanation",
  },
  WORKED_EXAMPLE: {
    goal: "Show a worked example of the PROCEDURE on a DIFFERENT problem (not the student's current item), step by step.",
    reveal_answer: false,
    expects: "explanation",
  },
  GUIDED_PRACTICE: {
    goal: "Offer the next scaffolded step and prompt the student to complete it. Provide support, not the full solution.",
    reveal_answer: false,
    expects: "prompt",
  },
  INDEPENDENT_PRACTICE: {
    goal: "Pose one practice problem at the target difficulty with no scaffolding.",
    reveal_answer: false,
    expects: "question",
  },
  RETRIEVAL_PRACTICE: {
    goal: "Ask a short retrieval question that strengthens recall of the target concept.",
    reveal_answer: false,
    expects: "question",
  },
  TRANSFER_PROBLEM: {
    goal: "Pose ONE problem that uses the same principle in a structurally different context, to test transfer.",
    reveal_answer: false,
    expects: "question",
  },
  RETEST: {
    goal: "Pose a fresh item equivalent to the one just missed, to verify durable change. Do not reuse the exact question.",
    reveal_answer: false,
    expects: "question",
  },
  PREREQUISITE_REMEDIATION: {
    goal: "Briefly bridge to the weak prerequisite concept, then ask a short question on that prerequisite before returning to the target.",
    reveal_answer: false,
    expects: "explanation",
  },
};

/**
 * Build the constrained system prompt. Guardrails come primarily from the
 * state packet's `do_not_do`, reinforced with the engine's role separation.
 *
 * @param {object} packet §29 SLM state packet
 * @param {object} opts   { tone, gradeLevel, subject }
 */
function buildSystemPrompt(packet, opts = {}) {
  const tone = opts.tone || "supportive";
  const grade = opts.gradeLevel ? `Class ${opts.gradeLevel}` : "a secondary-school";
  const subject = opts.subject ? ` ${opts.subject}` : "";
  const doNot = Array.isArray(packet.do_not_do) ? packet.do_not_do : [];

  const guardrails = [
    doNot.includes("give_final_answer") &&
      "NEVER state the final answer or the fully worked solution to the student's current question. Lead them toward it instead.",
    doNot.includes("invent_unverified_content") &&
      "NEVER invent facts, formulas, values, exam rules or curriculum claims. If a fact is not supplied in the context, do not assert it.",
    doNot.includes("overwrite_mastery_state") &&
      "You do NOT decide or announce the student's mastery, scores, or whether they have 'mastered' anything. The engine owns that.",
  ].filter(Boolean);

  return [
    `You are Cloop, an adaptive${subject} tutor for ${grade} student in the Indian curriculum (CBSE / ICSE / ISC / JEE / NEET / KCET context).`,
    `Your tone is ${tone}, concise, and encouraging. Never condescending.`,
    "",
    "You are the COMMUNICATION layer of a larger system. A separate deterministic engine has already diagnosed the student and decided the next best action. Your job is ONLY to carry out that action as natural dialogue.",
    "",
    "Hard rules:",
    ...guardrails.map((g) => `- ${g}`),
    "- Do exactly the ONE action described in the goal. Do not pile on extra steps.",
    "- Keep it short: one question, or 2–4 sentences of explanation. This is a chat turn, not a lecture.",
    "- Address the student directly in second person.",
  ].join("\n");
}

/**
 * Build the user-turn content describing the current structured state.
 * @param {object} packet
 * @param {object} plan   { selected_action, reason }
 * @param {object} ctx    { studentMessage, questionText }
 */
function buildTaskPrompt(packet, plan, ctx = {}) {
  const action = plan?.selected_action || "SOCRATIC_DIALOGUE";
  const spec = ACTION_GOALS[action] || ACTION_GOALS.SOCRATIC_DIALOGUE;
  const lines = [
    `ACTION: ${action}`,
    `GOAL: ${spec.goal}`,
    plan?.reason ? `WHY (engine's reason): ${plan.reason}` : null,
    "",
    "STUDENT STATE (authoritative — do not contradict or restate as scores):",
    `- target concept: ${packet.target_concept ?? "unknown"}`,
    `- weak dimensions: ${(packet.weak_dimensions || []).join(", ") || "none flagged"}`,
    packet.suspected_misconception
      ? `- suspected misconception: ${packet.suspected_misconception} (confidence ${fmt(packet.confidence)})`
      : null,
    packet.prerequisite_gap ? `- prerequisite gap: ${packet.prerequisite_gap}` : null,
    packet.difficulty_target != null ? `- difficulty target: ${fmt(packet.difficulty_target)}` : null,
    "",
    ctx.questionText ? `CURRENT QUESTION: ${ctx.questionText}` : null,
    ctx.studentMessage ? `STUDENT JUST SAID: ${ctx.studentMessage}` : null,
    "",
    "Respond with ONLY the message to show the student. No preamble, no meta-commentary.",
  ].filter((l) => l !== null);
  return lines.join("\n");
}

/**
 * A light post-generation guard. Structured-output prompting is the primary
 * defence; this is a cheap backstop that flags an obvious answer leak so the
 * caller can regenerate or fall back rather than showing it.
 *
 * @param {string} text
 * @param {object} ctx { correctAnswer }
 * @returns {{ ok: boolean, reason?: string }}
 */
function guardOutput(text, ctx = {}) {
  if (!text || !text.trim()) return { ok: false, reason: "empty_response" };
  if (ctx.correctAnswer != null) {
    const ans = String(ctx.correctAnswer).trim().toLowerCase();
    if (ans.length >= 2 && text.toLowerCase().includes(ans)) {
      return { ok: false, reason: "leaked_final_answer" };
    }
  }
  return { ok: true };
}

/**
 * Produce a grounded SLM response for a decided action.
 *
 * @param {object} packet §29 state packet
 * @param {object} plan   { selected_action, reason }
 * @param {object} [opts]
 *   {
 *     tone, gradeLevel, subject,
 *     studentMessage, questionText, correctAnswer,
 *     completion?: async ({system,user,temperature}) => string,  // injectable
 *     model, temperature,
 *   }
 * @returns {Promise<object>} { message, action, guard, model_version, meta }
 */
async function respond(packet, plan, opts = {}) {
  const system = buildSystemPrompt(packet, opts);
  const user = buildTaskPrompt(packet, plan, opts);
  const action = plan?.selected_action || "SOCRATIC_DIALOGUE";

  const complete = opts.completion || defaultCompletion;
  let raw = "";
  try {
    raw = await complete({
      system,
      user,
      model: opts.model,
      temperature: opts.temperature ?? 0.5,
    });
  } catch (err) {
    return {
      message: null,
      action,
      guard: { ok: false, reason: "model_error" },
      error: String(err?.message || err),
      model_version: SLM_VERSION,
    };
  }

  const message = (raw || "").trim();
  const guard = guardOutput(message, { correctAnswer: opts.correctAnswer });

  return {
    message: guard.ok ? message : null,
    blocked_message: guard.ok ? undefined : message,
    action,
    guard,
    model_version: SLM_VERSION,
    meta: { expects: (ACTION_GOALS[action] || {}).expects || "message" },
  };
}

/**
 * Factory: returns a responder with the signature the learning pipeline's
 * injected `slmResponder(packet)` expects. Because the pipeline passes only
 * the packet, per-turn context (student message, question text) is bound here.
 *
 * @param {object} bound
 *   { plan, tone, gradeLevel, subject, studentMessage, questionText,
 *     correctAnswer, completion, model, temperature }
 * @returns {(packet: object) => Promise<object>}
 */
function slmResponderFor(bound = {}) {
  return (packet) =>
    respond(packet, bound.plan || { selected_action: packet.selected_action }, bound);
}

// Default backing model: the existing OpenAI wrapper. Lazily required so unit
// tests that inject `completion` never touch the SDK or need an API key.
async function defaultCompletion({ system, user, model = "gpt-4o", temperature = 0.5 }) {
  const { chatCompletion } = require("../openai");
  return chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { model, temperature }
  );
}

function fmt(x) {
  return typeof x === "number" ? x.toFixed(2) : String(x ?? "n/a");
}

module.exports = {
  SLM_VERSION,
  ACTION_GOALS,
  buildSystemPrompt,
  buildTaskPrompt,
  guardOutput,
  respond,
  slmResponderFor,
};
