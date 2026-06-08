/**
 * Stage 2 of the tutoring engine: render the spoken turn.
 *
 * Given the (already decided) grade and the (already decided) next step, the
 * LLM produces the chat bubbles, the next question, and an optional visual aid.
 * It cannot change the score or the flow. The result is normalised so the API
 * payload is always well-formed.
 */

const { chatCompletion } = require("./openai");
const { buildTutorSystemPrompt } = require("./cloop_prompt");
const { safeJsonParse } = require("../lib/json");
const { resolveMedia } = require("./media_resolver");

/** Normalise a media spec object, dropping it if empty/invalid. */
function cleanDiagram(d, kind) {
  if (!d || typeof d !== "object") return null;
  const code = typeof d.code === "string" ? d.code.trim() : "";
  if (!code) return null;
  const out = {
    title: typeof d.title === "string" ? d.title : "",
    code,
    trigger: d.trigger || "teaching",
  };
  if (kind === "text") {
    const types = ["tree", "arrow", "table", "ascii"];
    out.diagram_type = types.includes(d.diagram_type) ? d.diagram_type : "tree";
  }
  return out;
}

function cleanMediaQuery(m) {
  if (!m || typeof m !== "object") return null;
  const q = typeof m.search_query === "string" ? m.search_query.trim() : "";
  if (!q) return null;
  return {
    search_query: q,
    title: typeof m.title === "string" ? m.title : "",
    trigger: m.trigger || "teaching",
  };
}

/**
 * Generate the tutor's spoken turn.
 *
 * @param {object} args
 * @param {object} args.topic           { title, content }
 * @param {object} args.grade           Stage-1 grade (or a synthetic one for the first turn)
 * @param {object} args.step            decision from session_state
 * @param {string[]} args.askedQuestions
 * @param {string} [args.studentName]
 * @param {string} [args.language]
 * @param {(messages:any[], opts:any)=>Promise<string>} [llm]
 * @returns {Promise<object>} { messages, next_question, technique, mermaid_diagram?, text_diagram?, youtube_video?, google_image? }
 */
async function generateTutorTurn(args, llm = chatCompletion) {
  const {
    topic,
    grade,
    step,
    askedQuestions = [],
    studentName,
    language,
  } = args;

  const system = buildTutorSystemPrompt({
    topicTitle: topic.title,
    topicContent: topic.content,
    grade,
    step,
    askedQuestions,
    studentName,
    language,
  });

  let raw = null;
  try {
    const out = await llm(
      [{ role: "system", content: system }, { role: "user", content: "Render the turn now." }],
      { jsonMode: true, temperature: 0.4 }
    );
    raw = safeJsonParse(out, null);
  } catch (err) {
    console.error("[tutor] failed:", err.message);
    raw = null;
  }

  return normalizeTurn(raw, step, askedQuestions);
}

/**
 * Normalise the tutor payload and guarantee the auto-continue invariant:
 * unless the session is complete, the turn MUST end with a question.
 *
 * @param {object|null} raw
 * @param {object} step
 * @param {string[]} askedQuestions
 * @returns {object}
 */
function normalizeTurn(raw, step, askedQuestions) {
  let messages = Array.isArray(raw?.messages)
    ? raw.messages
        .filter((m) => m && typeof m.message === "string" && m.message.trim())
        .map((m) => ({ message: m.message.trim(), message_type: m.message_type || "text" }))
    : [];

  let nextQuestion =
    typeof raw?.next_question === "string" && raw.next_question.trim()
      ? raw.next_question.trim()
      : null;

  const sessionComplete = step.action === "session_complete";

  if (!sessionComplete) {
    // Enforce a trailing question. If the model didn't supply one, synthesise a
    // minimal fallback so the auto-continue rule is never violated.
    if (!nextQuestion) {
      nextQuestion = fallbackQuestion(step);
    }
    // Make sure the last bubble IS the question (the UI relies on this).
    const lastBubble = messages[messages.length - 1];
    if (!lastBubble || lastBubble.message !== nextQuestion) {
      messages.push({ message: nextQuestion, message_type: "text" });
    }
  } else if (messages.length === 0) {
    messages = [
      { message: "That's a wrap for this topic — well done for working through every goal!", message_type: "text" },
    ];
    nextQuestion = null;
  }

  const result = {
    messages,
    next_question: nextQuestion,
    technique: step.technique || raw?.technique || null,
  };

  // Visual aids are only allowed when the step permits them.
  if (step.allowMedia) {
    const mermaid = cleanDiagram(raw?.mermaid_diagram, "mermaid");
    const textd = cleanDiagram(raw?.text_diagram, "text");
    // At most one diagram — prefer mermaid if both somehow present.
    if (mermaid) result.mermaid_diagram = mermaid;
    else if (textd) result.text_diagram = textd;

    const yt = cleanMediaQuery(raw?.youtube_video);
    const img = cleanMediaQuery(raw?.google_image);
    if (yt) result.youtube_video = resolveMedia.youtube(yt);
    if (img) result.google_image = resolveMedia.image(img);
  }

  // Final safety: avoid repeating an already-asked question verbatim.
  if (result.next_question && isRepeat(result.next_question, askedQuestions)) {
    const fallback = fallbackQuestion(step);
    if (!isRepeat(fallback, askedQuestions)) {
      // swap the trailing bubble too
      if (result.messages.length && result.messages[result.messages.length - 1].message === result.next_question) {
        result.messages[result.messages.length - 1].message = fallback;
      }
      result.next_question = fallback;
    }
  }

  return result;
}

function isRepeat(question, asked) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const q = norm(question);
  return asked.some((a) => norm(a) === q);
}

function fallbackQuestion(step) {
  const goal = step.nextGoalTitle || "this topic";
  if (step.nextPhase === "exam") {
    return `In one line, state the key idea behind ${goal}.`;
  }
  return `Can you give one everyday example related to ${goal}?`;
}

module.exports = { generateTutorTurn, normalizeTurn };
