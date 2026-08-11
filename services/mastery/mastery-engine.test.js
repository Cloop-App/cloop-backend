/**
 * Replay / regression test suite for Cloop Mastery Engine v1.0.
 *
 * These tests encode the worked numerical examples and the validation-suite
 * scenarios directly from "Cloop Mastery Engine v1.0" so that any change to
 * the engine that drifts from the specification fails loudly.
 *
 * Run with:  node --test   (or: npm test)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("./mastery-engine");

const near = (a, b, eps = 1e-3) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

// ─── §4 Overall mastery formula ──────────────────────────────────
test("§4 overall weights sum to 1.0", () => {
  const sum = Object.values(M.OVERALL_WEIGHTS).reduce((a, b) => a + b, 0);
  near(sum, 1.0, 1e-9);
});

test("§4 weightedMastery of all-equal dims equals that value", () => {
  const dims = M.DIMENSIONS.reduce((a, d) => ((a[d] = 0.5), a), {});
  near(M.weightedMastery(dims), 0.5);
});

// ─── §5 Mastery bands ────────────────────────────────────────────
test("§5 mastery bands map to the spec's ranges", () => {
  assert.equal(M.masteryBand(0.1).band, "Unmastered");
  assert.equal(M.masteryBand(0.3).band, "Emerging");
  assert.equal(M.masteryBand(0.55).band, "Developing");
  assert.equal(M.masteryBand(0.7).band, "Proficient");
  assert.equal(M.masteryBand(0.85).band, "Strong");
  assert.equal(M.masteryBand(0.95).band, "Mastered");
});

// ─── §7 Correctness signal ───────────────────────────────────────
test("§7 correctness signal mapping", () => {
  assert.equal(M.correctnessSignal("correct"), 1.0);
  assert.equal(M.correctnessSignal("unknown"), null); // no update
  assert.ok(M.correctnessSignal("partial", 0.6) >= 0.4);
  assert.ok(M.correctnessSignal("partial", 0.99) <= 0.85);
  assert.ok(M.correctnessSignal("incorrect_conceptual") <= 0.2);
  assert.ok(M.correctnessSignal("incorrect_valid_method") >= 0.2);
});

// ─── §13 Worked example — positive evidence ──────────────────────
// Current application mastery = 0.62. Correct transfer problem.
// E=1.00, alpha=0.15, W=0.90  →  M_new = 0.6713
test("§13 positive-evidence worked example → 0.6713", () => {
  const out = M.updateDimensionValue(0.62, 1.0, 0.9, 0.15);
  near(out, 0.6713);
});

// ─── §14 Worked example — conceptual error ───────────────────────
// Current mastery = 0.62. Strong conceptual error.
// E=0.05, alpha=0.15, W=0.80  →  M_new ≈ 0.5516
test("§14 conceptual-error worked example → 0.5516", () => {
  const out = M.updateDimensionValue(0.62, 0.05, 0.8, 0.15);
  near(out, 0.5516);
});

// ─── §12 Evidence weight ─────────────────────────────────────────
test("§12 evidence weight is clamped to [0.20, 1.00]", () => {
  const wLow = M.evidenceWeight({
    difficulty: 0,
    conceptRelevance: 0,
    taskStrength: 0,
    independence: 0,
    evaluatorReliability: 0,
  });
  near(wLow, 0.3); // 0.30 + 0 => floor of formula, above 0.20 clamp
  const wHigh = M.evidenceWeight({
    difficulty: 1,
    conceptRelevance: 1,
    taskStrength: 1,
    independence: 1,
    evaluatorReliability: 1,
  });
  near(wHigh, 1.0); // 0.30+0.20+0.15+0.15+0.10+0.10 = 1.00
  assert.ok(wHigh <= 1.0 && wLow >= 0.2);
});

// ─── §15 Repetition discount ─────────────────────────────────────
test("§15 independence factor floors at 0.35", () => {
  near(M.independenceFactor(0), 1.0);
  near(M.independenceFactor(1), 0.88);
  assert.equal(M.independenceFactor(100), 0.35);
});

// ─── §16 Hint discount ───────────────────────────────────────────
test("§16 hint discounts match the table", () => {
  near(M.hintDiscount("none"), 1.0);
  near(M.hintDiscount("minor"), 0.85);
  near(M.hintDiscount("multiple"), 0.65);
  near(M.hintDiscount("worked_step"), 0.45);
  near(M.hintDiscount("answer_revealed"), 0.2);
});

// ─── §18 Uncertainty is separate and bounded ─────────────────────
test("§18 uncertainty decays toward novelty and stays in [0.05,0.50]", () => {
  const s1 = M.updateUncertainty(0.19, 0.2);
  near(s1, 0.19 * 0.92 + 0.08 * 0.2);
  assert.ok(M.updateUncertainty(0.0, 0) >= 0.05);
  assert.ok(M.updateUncertainty(1.0, 1) <= 0.5);
});

// ─── §20 Retention/forgetting projection ─────────────────────────
test("§20 retention decays with elapsed time", () => {
  near(M.projectRetention(0.8, 0, 0.05), 0.8);
  assert.ok(M.projectRetention(0.8, 30, 0.05) < 0.8);
});

// ─── §22 Prerequisite propagation limits downstream penalty ──────
test("§22 upstream attribution dampens downstream penalty only", () => {
  // Full attribution upstream → downstream barely moves.
  const damped = M.attributeUpstream(0.05, 0.62, 1.0);
  near(damped, 0.62);
  // No attribution → full penalty target.
  near(M.attributeUpstream(0.05, 0.62, 0.0), 0.05);
  // Positive evidence is never dampened.
  near(M.attributeUpstream(1.0, 0.62, 0.9), 1.0);
});

// ─── §28 Top-level update: end-to-end behaviours ─────────────────

test("Validation: unknown response → no mastery penalty, no event", () => {
  const state = { dimensions: dimsAt(0.62), uncertainty: 0.2, evidence_count: 3 };
  const { state: next, event } = M.updateMastery(state, { outcome: "unknown" });
  assert.equal(event, null);
  near(next.overall_mastery, 0.62);
});

test("Validation: easy correct after weak state → small positive update, no jump", () => {
  const state = { dimensions: dimsAt(0.30), uncertainty: 0.3 };
  const { state: next } = M.updateMastery(state, {
    outcome: "correct",
    taskType: "basic_recall",
    difficulty: 0.35,
  });
  assert.ok(next.overall_mastery > 0.30, "should increase");
  assert.ok(next.overall_mastery < 0.45, "should not jump to mastered");
});

test("Validation: hard transfer correct → larger transfer update than easy recall", () => {
  const base = { dimensions: dimsAt(0.5), uncertainty: 0.3 };
  const transfer = M.updateMastery(base, {
    outcome: "correct",
    taskType: "transfer",
    difficulty: 0.95,
  }).state;
  const recall = M.updateMastery(base, {
    outcome: "correct",
    taskType: "basic_recall",
    difficulty: 0.35,
  }).state;
  assert.ok(
    transfer.dimensions.transfer - 0.5 > recall.dimensions.recall - 0.5,
    "transfer evidence should move its dimension more than easy recall"
  );
});

test("Validation: repeated identical correct → diminishing update", () => {
  const base = { dimensions: dimsAt(0.5), uncertainty: 0.3 };
  const fresh = M.updateMastery(base, {
    outcome: "correct",
    taskType: "familiar_application",
    difficulty: 0.65,
    nSimilar: 0,
  }).state;
  const repeated = M.updateMastery(base, {
    outcome: "correct",
    taskType: "familiar_application",
    difficulty: 0.65,
    nSimilar: 8,
  }).state;
  assert.ok(
    repeated.dimensions.application - 0.5 < fresh.dimensions.application - 0.5,
    "repeated similar item should produce a smaller update"
  );
});

test("Validation: correct with hints → positive but discounted vs no hints", () => {
  const base = { dimensions: dimsAt(0.5), uncertainty: 0.3 };
  const noHint = M.updateMastery(base, {
    outcome: "correct",
    taskType: "familiar_application",
    hintLevel: "none",
  }).state;
  const hinted = M.updateMastery(base, {
    outcome: "correct",
    taskType: "familiar_application",
    hintLevel: "multiple",
  }).state;
  assert.ok(hinted.dimensions.application > 0.5, "still positive");
  assert.ok(
    hinted.dimensions.application < noHint.dimensions.application,
    "assisted evidence should count for less"
  );
});

test("Validation: calculation slip → fluency penalty stronger than conceptual dims", () => {
  const state = { dimensions: dimsAt(0.62), uncertainty: 0.2 };
  const { state: next } = M.updateMastery(state, {
    outcome: "incorrect_valid_method",
    errorType: "calculation",
    difficulty: 0.6,
  });
  const dF = 0.62 - next.dimensions.procedural_fluency;
  const dU = 0.62 - next.dimensions.understanding; // untouched
  assert.ok(dF > 0, "fluency should drop");
  assert.ok(dU <= 1e-9, "understanding should be untouched by a calc slip");
});

test("Validation: conceptual misconception → meaningful U/A/N reduction", () => {
  const state = { dimensions: dimsAt(0.62), uncertainty: 0.2 };
  const { state: next, event } = M.updateMastery(state, {
    outcome: "incorrect_conceptual",
    errorType: "conceptual",
    difficulty: 0.7,
  });
  assert.ok(next.dimensions.understanding < 0.62);
  assert.ok(next.dimensions.application < 0.62);
  assert.ok(next.dimensions.analysis < 0.62);
  assert.ok(next.dimensions.recall === 0.62, "recall untouched");
  assert.ok(event && event.after.overall < event.before.overall);
});

test("Validation: prerequisite failure → downstream penalty limited", () => {
  const state = { dimensions: dimsAt(0.62), uncertainty: 0.2 };
  const full = M.updateMastery(state, {
    outcome: "incorrect_conceptual",
    errorType: "conceptual",
    difficulty: 0.7,
    prerequisiteAttribution: 0,
  }).state;
  const routed = M.updateMastery(state, {
    outcome: "incorrect_conceptual",
    errorType: "conceptual",
    difficulty: 0.7,
    prerequisiteAttribution: 0.8,
  }).state;
  assert.ok(
    routed.dimensions.application > full.dimensions.application,
    "routing blame upstream should limit the downstream drop"
  );
});

test("Validation: overconfident wrong → flagged diagnostically, not fixed subtraction", () => {
  const state = { dimensions: dimsAt(0.62), uncertainty: 0.2 };
  const { event } = M.updateMastery(state, {
    outcome: "incorrect_conceptual",
    errorType: "conceptual",
    studentConfidence: 0.9,
  });
  assert.ok(event.diagnosis.overconfidence > 0, "overconfidence flagged");
});

test("§26 update produces an immutable-style audit event with before/after", () => {
  const state = {
    student_id: "STU-SYN-001",
    concept_id: "PHY-MEC-001",
    dimensions: dimsAt(0.62),
    uncertainty: 0.2,
  };
  const { event } = M.updateMastery(state, {
    outcome: "incorrect_conceptual",
    errorType: "conceptual",
    interactionId: "INTX-001",
    difficulty: 0.7,
  });
  assert.equal(event.student_id, "STU-SYN-001");
  assert.equal(event.concept_id, "PHY-MEC-001");
  assert.equal(event.interaction_id, "INTX-001");
  assert.equal(event.model_version, M.MODEL_VERSION);
  assert.ok("before" in event && "after" in event && "evidence" in event);
});

test("§29 SLM state packet carries guardrails and weak dimensions", () => {
  const state = {
    concept_id: "PHY-MEC-001",
    dimensions: { ...dimsAt(0.6), understanding: 0.3, transfer: 0.2 },
    overall_mastery: 0.47,
    uncertainty: 0.19,
  };
  const packet = M.buildSlmStatePacket(state, {
    selectedAction: "SOCRATIC_DIAGNOSTIC",
    difficultyTarget: 0.4,
  });
  assert.ok(packet.weak_dimensions.includes("transfer"));
  assert.ok(packet.weak_dimensions.includes("understanding"));
  assert.equal(packet.selected_action, "SOCRATIC_DIAGNOSTIC");
  assert.ok(packet.do_not_do.includes("overwrite_mastery_state"));
});

// helper: build a dimensions object where every dimension = v
function dimsAt(v) {
  return M.DIMENSIONS.reduce((a, d) => ((a[d] = v), a), {});
}
