/**
 * Thin wrapper around the OpenAI Chat Completions API.
 *
 * The client and the `openai` package are loaded lazily on first use so that
 * importing this module (and the tutoring engine that depends on it) never
 * requires the package to be installed or an API key to be present — the engine
 * is fully unit-testable with injected mock LLM callers.
 *
 * To swap the LLM provider, this is the only file that needs to change: keep the
 * `chatCompletion(messages, options) => Promise<string>` contract.
 */

let _client = null;

function getClient() {
  if (_client) return _client;
  const OpenAI = require("openai");
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Send a chat completion request.
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {string} [options.model]        defaults to "gpt-4o"
 * @param {number} [options.temperature]  defaults to 0.7
 * @param {boolean} [options.jsonMode]    if true, requests a JSON object
 * @returns {Promise<string>} the assistant's response content
 */
async function chatCompletion(messages, options = {}) {
  const { model = "gpt-4o", temperature = 0.7, jsonMode = false } = options;

  const params = { model, messages, temperature };
  if (jsonMode) params.response_format = { type: "json_object" };

  const response = await getClient().chat.completions.create(params);
  return response.choices[0].message.content;
}

module.exports = { chatCompletion, getClient };
