/**
 * Minimal zero-dependency test harness (no Jest/Mocha needed).
 * Usage:
 *   const { test, run } = require("./harness");
 *   test("name", () => { assert(...) });
 *   run();  // prints results, sets exit code
 */
const assert = require("node:assert/strict");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  ✗ ${name}`);
      console.log(`      ${err.message.split("\n").join("\n      ")}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  return failures.length === 0;
}

module.exports = { test, run, assert };
