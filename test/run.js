/**
 * Test entry point. Runs the offline tutoring-engine test suites with mock LLMs
 * — no database, no OpenAI key required.
 *
 *   node test/run.js
 */
require("./unit");
require("./grader_cases");
require("./tutor_simulation");
require("./cost_optim");
const { run } = require("./harness");

run().then((ok) => {
  if (!ok) process.exitCode = 1;
});
