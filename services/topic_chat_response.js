/**
 * Parse and normalise a tutor turn returned by the LLM.
 *
 * Three failure modes were reaching students as blank chat bubbles:
 *
 *   1. Key mismatch. Older prompt revisions told the model to emit
 *      `messages`; the app reads `ai_messages`. `aiResponse.ai_messages || []`
 *      then iterates nothing and the turn renders empty.
 *   2. Blank strings. A message whose text is "", whitespace or undefined was
 *      persisted anyway, producing an empty bubble in the transcript.
 *   3. Non-JSON output. When the model answers in prose the raw text was
 *      wrapped verbatim — markdown fences, diagram source and all.
 *
 * None of these are fixable from inside the prompt: once the model has
 * returned prose, no instruction inside that prose can rescue the turn. The
 * guard belongs here and in the renderer.
 */

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/** Strip a markdown code fence the model wrapped around its JSON. */
function unfence(raw) {
  const m = String(raw || "").match(FENCE);
  return m ? m[1] : String(raw || "");
}

/**
 * Pull the first balanced {...} out of a string, so a JSON object with a
 * stray sentence before or after it still parses.
 */
function extractObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Keep only messages that will actually render as a bubble. */
function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === "string" ? { message_type: "text", message: m } : m))
    .filter((m) => m && typeof m.message === "string" && m.message.trim() !== "")
    .map((m) => ({ message_type: m.message_type || "text", message: m.message.trim() }));
}

/**
 * @param {string} raw - the model's reply
 * @returns {{ response: object, parseOk: boolean, hasMessages: boolean, note: string|null }}
 *   `response` always has the six top-level keys the app expects.
 *   `hasMessages` is false when there is nothing renderable — callers must
 *   retry rather than persist an empty turn.
 */
function parseTutorResponse(raw) {
  const text = unfence(raw);
  let parsed = null;
  let note = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    const inner = extractObject(text);
    if (inner) {
      try {
        parsed = JSON.parse(inner);
        note = "recovered a JSON object embedded in prose";
      } catch {
        /* fall through */
      }
    }
  }

  if (!parsed || typeof parsed !== "object") {
    // Model answered in prose. Keep the text so the turn is not lost, but
    // say so, and let the caller decide whether to retry.
    return {
      response: {
        ai_messages: cleanMessages([{ message_type: "text", message: text }]),
        feedback: { is_correct: null, bubble_color: "default" },
        user_correction: null,
        goals_update: [],
        session_summary: null,
        evaluation: null,
      },
      parseOk: false,
      hasMessages: text.trim() !== "",
      note: "model did not return JSON",
    };
  }

  // Accept either key. Older prompt revisions said `messages`; the app and
  // the current prompt both say `ai_messages`.
  const messages = cleanMessages(parsed.ai_messages || parsed.messages);
  if (!parsed.ai_messages && parsed.messages) {
    note = 'model used "messages"; normalised to "ai_messages"';
  }

  return {
    response: {
      ai_messages: messages,
      feedback: parsed.feedback || { is_correct: null, bubble_color: "default" },
      user_correction: parsed.user_correction || null,
      goals_update: Array.isArray(parsed.goals_update) ? parsed.goals_update : [],
      session_summary: parsed.session_summary || null,
      evaluation: parsed.evaluation || null,
      ...parsed,
      ai_messages: messages,
    },
    parseOk: true,
    hasMessages: messages.length > 0,
    note,
  };
}

module.exports = { parseTutorResponse, cleanMessages, unfence, extractObject };
