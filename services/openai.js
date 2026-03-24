const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Send a chat completion request to OpenAI.
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {string} [options.model] - defaults to "gpt-4o"
 * @param {number} [options.temperature] - defaults to 0.7
 * @param {boolean} [options.jsonMode] - if true, sets response_format to json_object
 * @returns {Promise<string>} The assistant's response content
 */
async function chatCompletion(messages, options = {}) {
  const { model = "gpt-4o", temperature = 0.7, jsonMode = false } = options;

  const params = {
    model,
    messages,
    temperature,
  };

  if (jsonMode) {
    params.response_format = { type: "json_object" };
  }

  const response = await openai.chat.completions.create(params);
  return response.choices[0].message.content;
}

module.exports = { openai, chatCompletion };
