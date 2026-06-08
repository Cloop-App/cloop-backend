/**
 * Test entry point. Runs the offline tutoring-engine test suites with mock LLMs
 * — no database, no OpenAI key required.
 *
 *   node test/run.js
 */
require("./unit");
require("./tutor_simulation");
const { run } = require("./harness");

run().then((ok) => {
  if (!ok) process.exitCode = 1;
});
