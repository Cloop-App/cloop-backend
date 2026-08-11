/**
 * Regression suite for the Cloop Learning Intelligence Pipeline v1.0.
 * Encodes the worked example and anti-patterns from the pipeline spec.
 *
 * Run with:  node --test   (or: npm test)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./learning-pipeline");

// ─── Stage D — error detection ───────────────────────────────────
test("Stage D: correct answer yields no error", () => {
  const e = P.detectError({ correctness: "correct" });
  assert.equal(e.error_id, null);
});

test("Stage D: unknown → insufficient_evidence, not a misconception", () => {
  const e = P.detectError({ correctness: "unknown" });
  assert.equal(e.error_id, "insufficient_evidence");
});

test("Stage D: explicit evaluator label wins", () => {
  const e = P.detectError({ correctness: "incorrect_conceptual", explicitErrorType: "vector" });
  assert.equal(e.error_id, "vector");
});

// ─── Stage E — misconception is a candidate, not a permanent label ──
test("Stage E: single weak signal is a candidate but not promoted", () => {
  const m = P.misconceptionConfidence({
    evidenceStrength: 0.5,
    patternConsistency: 0.4,
    conceptAlignment: 0.6,
    historySupport: 0.3,
    evaluatorConfidence: 0.8,
    evidenceCount: 1,
  });
  assert.equal(m.candidate, true);
  assert.equal(m.promote, false);
});

test("Stage E: strong repeated aligned evidence promotes", () => {
  const m = P.misconceptionConfidence({
    evidenceStrength: 0.95,
    patternConsistency: 0.95,
    conceptAlignment: 0.95,
    historySupport: 0.95,
    evaluatorConfidence: 0.95,
    evidenceCount: 3,
  });
  assert.ok(m.confidence >= 0.7);
  assert.equal(m.promote, true);
});

// ─── Stage F — prerequisite diagnosis ────────────────────────────
test("Stage F: weakest strongly-linked prerequisite is flagged for review", () => {
  const pc = P.prerequisiteCheck(
    [
      { concept_id: "PHY-KIN-001", mastery: 0.47, edgeStrength: 0.9 },
      { concept_id: "PHY-ALG-001", mastery: 0.8, edgeStrength: 0.4 },
    ],
    { errorCompatible: true }
  );
  assert.equal(pc.concept_id, "PHY-KIN-001");
  assert.equal(pc.needs_review, true);
  assert.ok(pc.attribution > 0);
});

// ─── Stage H — gap priority is suppressed by low evidence ────────
test("Stage H: near-zero evidence confidence suppresses priority", () => {
  const strong = P.gapPriority({
    mastery: 0.3,
    conceptImportance: 0.9,
    prerequisiteLeverage: 0.9,
    examRelevance: 0.9,
    evidenceConfidence: 0.9,
    expectedGain: 0.9,
  });
  const uncertain = P.gapPriority({
    mastery: 0.3,
    conceptImportance: 0.9,
    prerequisiteLeverage: 0.9,
    examRelevance: 0.9,
    evidenceConfidence: 0.05,
    expectedGain: 0.9,
  });
  assert.ok(uncertain.priority < strong.priority);
});

// ─── Stage I — the spec's worked decision (§17) ──────────────────
// Target concept weak, but the exact source of error is UNCERTAIN → the
// engine must value a diagnostic/Socratic probe over another hard problem
// or an immediate explanation.
test("§17 worked example: uncertain FBD error → probe, not another hard problem", () => {
  const { selected, candidates } = P.planAction({
    mastery: 0.43,
    uncertainty: 0.45, // exact source of error is uncertain
    prerequisite: { needs_review: false, attribution: 0.2 },
    misconception: { confidence: 0.35 }, // ambiguous
    examRelevance: 0.7,
    nSimilar: 0,
  });
  assert.ok(
    ["DIAGNOSTIC_QUESTION", "SOCRATIC_DIALOGUE"].includes(selected.type),
    `expected a diagnostic/Socratic probe, got ${selected.type}`
  );
  // It should NOT pick an immediate explanation while the cause is uncertain.
  const explanationRank = candidates.findIndex((c) => c.type === "MICRO_EXPLANATION");
  const probeRank = candidates.findIndex((c) =>
    ["DIAGNOSTIC_QUESTION", "SOCRATIC_DIALOGUE"].includes(c.type)
  );
  assert.ok(probeRank < explanationRank, "probe should outrank immediate explanation");
});

test("Stage I: confident misconception favours a counterexample", () => {
  const { selected } = P.planAction({
    mastery: 0.4,
    uncertainty: 0.1,
    misconception: { confidence: 0.9 },
  });
  assert.equal(selected.type, "COUNTEREXAMPLE");
});

test("Stage I: strong prerequisite gap favours remediation", () => {
  const { selected } = P.planAction({
    mastery: 0.4,
    uncertainty: 0.15,
    prerequisite: { needs_review: true, attribution: 0.85 },
  });
  assert.equal(selected.type, "PREREQUISITE_REMEDIATION");
});

// ─── Full pipeline — the §22 worked example end to end ───────────
test("§22 worked example: constant-velocity misconception runs end-to-end", async () => {
  const out = await P.runPipeline({
    interactionId: "INTX-001",
    studentId: "STU-SYN-001",
    evaluation: { correctness: false, confidence: 0.98 },
    conceptEvidence: [
      { concept_id: "PHY-MEC-001", weight: 0.75 },
      { concept_id: "PHY-KIN-001", weight: 0.25 },
    ],
    masteryState: {
      student_id: "STU-SYN-001",
      concept_id: "PHY-MEC-001",
      dimensions: dimsAt(0.62),
      uncertainty: 0.14,
    },
    errorSignals: { explicitErrorType: "conceptual", difficulty: 0.7 },
    misconceptionFactors: {
      misconceptionId: "MIS-PHY-002",
      evidenceStrength: 0.6,
      patternConsistency: 0.5,
      conceptAlignment: 0.9,
      historySupport: 0.4,
      evaluatorConfidence: 0.98,
      evidenceCount: 1,
    },
    prerequisites: [{ concept_id: "PHY-KIN-001", mastery: 0.47, edgeStrength: 0.8 }],
    gap: { conceptImportance: 0.9, prerequisiteLeverage: 0.8, examRelevance: 0.8, expectedGain: 0.7 },
  });

  // Mastery must move DOWN modestly, not collapse (one response isn't enough
  // to establish a stable misconception).
  assert.ok(out.mastery_update.after < out.mastery_update.before, "mastery should dip");
  assert.ok(out.mastery_update.before - out.mastery_update.after < 0.1, "no collapse");

  // Misconception recorded as a candidate, NOT promoted from one signal.
  assert.equal(out.misconceptions[0].promote, false);

  // Prerequisite weakness surfaced.
  assert.equal(out.prerequisite_check.concept_id, "PHY-KIN-001");
  assert.equal(out.prerequisite_check.needs_review, true);

  // Adaptive action should be a diagnostic/Socratic probe — not another hard
  // question and not an immediate answer.
  assert.ok(
    ["DIAGNOSTIC_QUESTION", "SOCRATIC_DIALOGUE"].includes(out.adaptive_plan.selected_action)
  );

  // SLM packet carries the guardrails.
  assert.ok(out.slm_state_packet.do_not_do.includes("give_final_answer"));
  assert.ok(out.slm_state_packet.do_not_do.includes("overwrite_mastery_state"));

  // Immutable mastery event produced for the audit trail.
  assert.ok(out._mastery_event && out._mastery_event.interaction_id === "INTX-001");
});

test("pipeline: injected SLM responder is called with the constrained packet", async () => {
  let seen = null;
  const out = await P.runPipeline(
    {
      interactionId: "INTX-002",
      evaluation: { correctness: false, confidence: 0.9 },
      conceptEvidence: [{ concept_id: "PHY-MEC-001", weight: 1 }],
      masteryState: { dimensions: dimsAt(0.5), uncertainty: 0.3 },
      errorSignals: { explicitErrorType: "conceptual" },
    },
    {
      slmResponder: async (packet) => {
        seen = packet;
        return { message: "What does acceleration mean if velocity is unchanged?" };
      },
    }
  );
  assert.ok(seen && seen.do_not_do.includes("give_final_answer"));
  assert.equal(out.slm_response.message.length > 0, true);
});

test("pipeline: SLM failure is non-fatal; structured decision still returned", async () => {
  const out = await P.runPipeline(
    {
      interactionId: "INTX-003",
      evaluation: { correctness: "unknown", confidence: 0.4 },
      conceptEvidence: [{ concept_id: "PHY-MEC-001", weight: 1 }],
      masteryState: { dimensions: dimsAt(0.5), uncertainty: 0.3 },
    },
    {
      slmResponder: async () => {
        throw new Error("model timeout");
      },
    }
  );
  assert.ok(out.slm_response.error.includes("model timeout"));
  assert.ok(out.adaptive_plan.selected_action, "decision still produced");
  // Unknown response → no mastery penalty.
  assert.equal(out.mastery_update.before, out.mastery_update.after);
});

function dimsAt(v) {
  return {
    recall: v,
    understanding: v,
    application: v,
    analysis: v,
    transfer: v,
    procedural_fluency: v,
    retention: v,
  };
}
