/**
 * Robust JSON parsing for LLM responses.
 *
 * LLMs occasionally wrap JSON in markdown code fences or add stray prose even
 * when asked for "JSON only". This helper extracts and parses the first valid
 * JSON object so a single formatting slip never crashes the tutoring pipeline.
 */

/**
 * Parse a string that is expected to contain a JSON object.
 * Strips ```json fences and trailing/leading prose. Returns `fallback` (default
 * null) if no valid JSON object can be recovered.
 *
 * @template T
 * @param {string} raw
 * @param {T} [fallback]
 * @returns {object|T}
 */
function safeJsonParse(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;

  let text = String(raw).trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Fast path.
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to bracket extraction */
  }

  // Recover the first balanced { ... } block (handles strings/escapes).
  const start = text.indexOf("{");
  if (start === -1) return fallback;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return fallback;
        }
      }
    }
  }
  return fallback;
}

module.exports = { safeJsonParse };
