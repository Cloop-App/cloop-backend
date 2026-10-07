const OpenAI = require("openai");

// Any OpenAI-compatible provider works: set LLM_BASE_URL + LLM_API_KEY +
// LLM_MODEL. For DeepSeek: LLM_BASE_URL=https://api.deepseek.com,
// LLM_MODEL=deepseek-chat. Falls back to OpenAI defaults when unset.
const DEFAULT_MODEL = process.env.LLM_MODEL || "gpt-4o";

const openai = new OpenAI({
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.LLM_BASE_URL || undefined,
});

/**
 * Send a chat completion request to the configured LLM provider.
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {string} [options.model] - defaults to LLM_MODEL env (or "gpt-4o")
 * @param {number} [options.temperature] - defaults to 0.7
 * @param {boolean} [options.jsonMode] - if true, sets response_format to json_object
 * @param {number} [options.maxTokens] - output cap; defaults to 2000 so a full
 *   tutor turn (bubbles + blocks) cannot be truncated mid-JSON
 * @returns {Promise<string>} The assistant's response content
 */
async function chatCompletion(messages, options = {}) {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.7,
    jsonMode = false,
    maxTokens = 2000,
  } = options;

  const params = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (jsonMode) {
    // Enforced provider-side. Without this the model is free to answer in
    // prose, which no downstream parser can reliably recover. DeepSeek
    // additionally requires the word "json" to appear in the prompt.
    params.response_format = { type: "json_object" };
  }

  const response = await openai.chat.completions.create(params);
  return response.choices[0].message.content;
}

module.exports = { openai, chatCompletion };
