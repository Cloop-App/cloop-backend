/**
 * Seed-dataset replay regression suite.
 *
 * Locks the behaviour of the whole learning-intelligence engine against the
 * vendored Cloop Seed Dataset v1.0. This is the specs' repeated instruction:
 * "Replay the Cloop Seed Dataset as automated regression tests." Any drift in
 * error routing, misconception promotion, mastery movement or action
 * selection fails here.
 *
 * Run with:  node --test   (or: npm test)   — fully offline.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadSeed, interactionToPipelineInput } = require("./seed-loader");
const { runPipeline } = require("../pipeline/learning-pipeline");
const { replay } = require("./replay");

test("seed dataset loads with the expected pilot shape", () => {
  const { raw, index } = loadSeed();
  assert.equal(raw.metadata.status, "PILOT_SYNTHETIC");
  assert.ok(raw.concepts.length >= 10);
  assert.equal(raw.student_interactions.length, 6);
  assert.ok(index.questions.get("Q-PHY-001"));
  assert.ok(index.mastery.get("STU-SYN-001|PHY-MEC-001"));
});

test("error categories map to engine error types", () => {
  const loaded = loadSeed();
  const byId = new Map(loaded.raw.student_interactions.map((i) => [i.id, i]));
  const inputFor = (id) => interactionToPipelineInput(byId.get(id), loaded);
  assert.equal(inputFor("INTX-002").errorSignals.explicitErrorType, "ERR-REP-01"); // vector→representation
  assert.equal(inputFor("INTX-003").errorSignals.explicitErrorType, "ERR-PROC-01"); // algebraic→procedural
  assert.equal(inputFor("INTX-001").errorSignals.explicitErrorType, "ERR-CON-01"); // conceptual
});

test("replay: no mastery score ever leaves [0,1]", async () => {
  const { results } = await replay();
  for (const { out } of results) {
    assert.ok(out.mastery_update.after >= 0 && out.mastery_update.after <= 1);
    assert.ok(out.mastery_update.uncertainty >= 0.05 && out.mastery_update.uncertainty <= 0.5);
  }
});

test("replay: a single interaction never promotes a misconception", async () => {
  const { results } = await replay();
  for (const { out } of results) {
    for (const m of out.misconceptions) {
      assert.equal(m.promote, false, "one response must not promote a permanent label");
    }
  }
});

test("replay: incorrect answers dip mastery modestly (no collapse) and probe", async () => {
  const { results } = await replay();
  const wrong = results.filter((r) => r.interaction.correct === false);
  assert.equal(wrong.length, 4);
  for (const { out } of wrong) {
    const delta = out.mastery_update.before - out.mastery_update.after;
    assert.ok(delta > 0, "wrong answer should reduce mastery");
    assert.ok(delta < 0.1, "one wrong answer must not collapse the concept");
    assert.ok(out.errors.length >= 1, "a failure produces an error label");
    assert.ok(
      ["DIAGNOSTIC_QUESTION", "SOCRATIC_DIALOGUE", "PREREQUISITE_REMEDIATION", "COUNTEREXAMPLE"].includes(
        out.adaptive_plan.selected_action
      ),
      `unexpected action ${out.adaptive_plan.selected_action}`
    );
    assert.ok(out._mastery_event, "failure appends an immutable mastery event");
  }
});

test("replay: correct answers raise mastery, no error/misconception, verify via transfer/retrieval", async () => {
  const { results } = await replay();
  const right = results.filter((r) => r.interaction.correct === true);
  assert.equal(right.length, 2);
  for (const { out } of right) {
    assert.ok(out.mastery_update.after > out.mastery_update.before, "correct raises mastery");
    assert.equal(out.errors.length, 0, "no error on a correct answer");
    assert.equal(out.misconceptions.length, 0, "no misconception on a correct answer");
    assert.ok(
      ["TRANSFER_PROBLEM", "RETRIEVAL_PRACTICE", "INDEPENDENT_PRACTICE"].includes(
        out.adaptive_plan.selected_action
      ),
      `expected a verification action, got ${out.adaptive_plan.selected_action}`
    );
  }
});

test("replay INTX-001: constant-velocity misconception → probe, modest dip", async () => {
  const { results } = await replay();
  const r = results.find((x) => x.interaction.id === "INTX-001");
  assert.ok(r);
  assert.equal(r.out.errors[0].error_id, "ERR-CON-01");
  assert.ok(r.out.mastery_update.after < r.out.mastery_update.before);
  assert.ok(
    ["DIAGNOSTIC_QUESTION", "SOCRATIC_DIALOGUE"].includes(r.out.adaptive_plan.selected_action)
  );
  // Prerequisite weakness (kinematics) is surfaced for the mechanics item.
  assert.ok(r.out.prerequisite_check, "prerequisite check present");
});

test("replay is deterministic (same inputs → same decisions)", async () => {
  const a = await replay();
  const b = await replay();
  const key = (res) =>
    res.results.map((r) => `${r.interaction.id}:${r.out.adaptive_plan.selected_action}:${r.out.mastery_update.after.toFixed(4)}`).join("|");
  assert.equal(key(a), key(b));
});

test("training examples in the seed are usable as an SLM eval set", () => {
  const { raw } = loadSeed();
  assert.ok(raw.training_examples.length >= 1);
  for (const ex of raw.training_examples) {
    assert.ok(ex.task, "task type present");
    assert.ok(ex.input && ex.expected, "input/expected present");
  }
});
