/**
 * The model client tutor-core runs on.
 *
 * Both model-backed steps — the evaluator and the dialogue generator — import
 * this module. It did not exist: every tutor-core test installs its own stub
 * through `require.cache` before loading the orchestrator, so the missing
 * require never threw in a test run and the package looked healthy while being
 * impossible to execute against a real model.
 *
 * The transport is `services/openai.js`, which already speaks to any
 * OpenAI-compatible provider (set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL;
 * DeepSeek is one such provider).
 */

// Required lazily. services/openai.js builds its provider client at module
// scope and throws when no API key is set, so a top-level require here would
// make every module that imports tutor-core unloadable without one — including
// at app boot, and in any test that does not stub this file.
let chatCompletion;
function transport() {
  if (!chatCompletion) ({ chatCompletion } = require("../openai"));
  return chatCompletion;
}

/**
 * Run one model call for a tutor-core step.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {boolean} [options.jsonFormat] - demand a single JSON object back
 * @param {string} [options.featureArea] - call-site label, used in error text
 * @param {string} [options.subFeature]
 * @returns {Promise<string>} raw assistant content
 */
async function invokeModel(systemPrompt, messages = [], options = {}) {
  const {
    temperature = 0.2,
    maxTokens = 800,
    jsonFormat = false,
    featureArea = "tutor-core",
    subFeature = "unknown",
  } = options;

  try {
    return await transport()(
      [{ role: "system", content: systemPrompt }, ...messages],
      { temperature, maxTokens, jsonMode: jsonFormat }
    );
  } catch (error) {
    // Both callers catch and fall back to a safe turn, so the student still
    // gets a reply. Name the step that failed — "evaluation failed" alone does
    // not say which of the two model calls went down.
    error.message = `[${featureArea}/${subFeature}] ${error.message}`;
    throw error;
  }
}

/**
 * Pull one JSON object out of a model reply.
 *
 * Even in JSON mode a reply can arrive fenced or with a sentence in front of
 * it, so a bare JSON.parse is not enough. Returns null rather than throwing:
 * every caller already has a fallback turn for unusable output, and an
 * exception here would lose it.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function extractJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;

  const text = String(raw).trim();
  if (!text) return null;

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to a scan for the first complete object
  }

  const slice = firstJsonObject(unfenced);
  if (!slice) return null;
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/**
 * The first balanced {...} run in `text`, or null.
 *
 * Braces inside string literals are skipped, so prose containing a quoted "{"
 * cannot end the object early.
 */
function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

module.exports = { invokeModel, extractJson };
