/**
 * End-to-end demo of the Cloop learning-intelligence vertical slice.
 *
 *   evidence → pipeline (diagnose/prioritise/plan) → mastery update
 *            → constrained SLM turn
 *
 * Runs fully offline: it injects a fake SLM completion so no API key is
 * needed. Swap `completion` for the default to hit the real model.
 *
 *   node services/demo-learning-loop.js
 */

const { runPipeline } = require("./pipeline/learning-pipeline");
const { slmResponderFor } = require("./slm/cloop-slm");

// A fake model turn so the demo runs with no network. In production, omit
// `completion` and the layer calls gpt-4o via services/openai.js.
const fakeCompletion = async ({ user }) => {
  if (/ACTION: (DIAGNOSTIC_QUESTION|SOCRATIC_DIALOGUE)/.test(user)) {
    return "If the block moves at a steady speed, what does that tell you about its acceleration — and therefore about the net force on it?";
  }
  return "Let's look at which forces actually act on the block before we calculate anything.";
};

async function main() {
  // Scenario (from the pipeline spec §22): student claims a body moving at
  // constant velocity has a non-zero net force "because it is moving."
  const input = {
    interactionId: "INTX-DEMO-001",
    studentId: "STU-SYN-001",
    evaluation: { correctness: false, confidence: 0.98, studentConfidence: 0.85 },
    conceptEvidence: [
      { concept_id: "PHY-MEC-001", weight: 0.75 },
      { concept_id: "PHY-KIN-001", weight: 0.25 },
    ],
    masteryState: {
      student_id: "STU-SYN-001",
      concept_id: "PHY-MEC-001",
      dimensions: {
        identification: 0.7,
        explanation: 0.6,
        representation: 0.58,
        application: 0.62,
        error_diagnosis: 0.55,
        transfer: 0.5,
        stability: 0.6,
      },
      uncertainty: 0.14,
      evidence_count: 1,
    },
    errorSignals: { explicitErrorType: "conceptual", difficulty: 0.7, taskType: "understanding" },
    misconceptionFactors: {
      misconceptionId: "MIS-PHY-MOTION-REQUIRES-FORCE",
      evidenceStrength: 0.6,
      patternConsistency: 0.5,
      conceptAlignment: 0.9,
      historySupport: 0.4,
      evaluatorConfidence: 0.98,
      evidenceCount: 1,
    },
    prerequisites: [{ concept_id: "PHY-KIN-001", mastery: 0.47, edgeStrength: 0.8 }],
    gap: {
      conceptImportance: 0.9,
      prerequisiteLeverage: 0.8,
      examRelevance: 0.85,
      expectedGain: 0.7,
    },
  };

  const out = await runPipeline(input, {
    slmResponder: slmResponderFor({
      subject: "Physics",
      gradeLevel: 11,
      studentMessage: "A body moving at constant velocity has a non-zero net force because it is moving.",
      questionText: "A block slides at constant velocity across a floor. What is the net force on it?",
      completion: fakeCompletion,
    }),
  });

  const show = (label, v) => console.log(label.padEnd(22), v);
  console.log("\n=== Cloop Learning Loop — one turn ===\n");
  show("Correctness:", out.evaluation.correctness);
  show("Error:", out.errors.map((e) => `${e.error_id} (${e.confidence})`).join(", "));
  show(
    "Misconception:",
    out.misconceptions
      .map((m) => `${m.misconception_id} conf=${m.confidence.toFixed(2)} promoted=${m.promote}`)
      .join(", ")
  );
  show(
    "Prerequisite:",
    `${out.prerequisite_check.concept_id} mastery=${out.prerequisite_check.mastery} needs_review=${out.prerequisite_check.needs_review}`
  );
  show(
    "Mastery:",
    `${out.mastery_update.before.toFixed(3)} → ${out.mastery_update.after.toFixed(3)} (${out.mastery_update.band}, σ=${out.mastery_update.uncertainty.toFixed(2)})`
  );
  show("Gap priority:", out.learning_gap.priority.toFixed(3));
  show("Selected action:", `${out.adaptive_plan.selected_action}`);
  show("  reason:", out.adaptive_plan.reason);
  console.log("\nSLM turn to student:");
  console.log("  " + (out.slm_response.message || `[blocked: ${out.slm_response.guard.reason}]`));
  console.log("\nAudit event id:", out._mastery_event?.interaction_id, "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
