/**
 * Regression suite for the Cloop SLM orchestration layer.
 * Uses an injected fake `completion` fn so no network/API key is needed.
 *
 * Run with:  node --test   (or: npm test)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const SLM = require("./cloop-slm");

const packet = {
  target_concept: "PHY-MEC-001",
  mastery_overall: 0.47,
  weak_dimensions: ["understanding", "transfer"],
  uncertainty: 0.19,
  suspected_misconception: "MIS-PHY-002",
  confidence: 0.62,
  prerequisite_gap: "PHY-KIN-001",
  selected_action: "SOCRATIC_DIALOGUE",
  difficulty_target: 0.4,
  do_not_do: ["give_final_answer", "invent_unverified_content", "overwrite_mastery_state"],
};

test("system prompt encodes guardrails from the packet", () => {
  const sys = SLM.buildSystemPrompt(packet, { subject: "Physics", gradeLevel: 11 });
  assert.match(sys, /NEVER state the final answer/i);
  assert.match(sys, /NEVER invent/i);
  assert.match(sys, /do NOT decide or announce the student's mastery/i);
  assert.match(sys, /Physics/);
  assert.match(sys, /Class 11/);
});

test("task prompt carries the decided action, goal and state", () => {
  const user = SLM.buildTaskPrompt(packet, {
    selected_action: "DIAGNOSTIC_QUESTION",
    reason: "cause uncertain",
  });
  assert.match(user, /ACTION: DIAGNOSTIC_QUESTION/);
  assert.match(user, /GOAL:/);
  assert.match(user, /PHY-MEC-001/);
  assert.match(user, /MIS-PHY-002/);
  assert.match(user, /cause uncertain/);
});

test("guardOutput blocks an empty response", () => {
  assert.equal(SLM.guardOutput("").ok, false);
  assert.equal(SLM.guardOutput("   ").ok, false);
});

test("guardOutput flags a leaked final answer", () => {
  const g = SLM.guardOutput("The answer is 9.8 m/s^2, clearly.", { correctAnswer: "9.8 m/s^2" });
  assert.equal(g.ok, false);
  assert.equal(g.reason, "leaked_final_answer");
});

test("guardOutput passes a clean Socratic question", () => {
  const g = SLM.guardOutput("What happens to acceleration if velocity does not change?", {
    correctAnswer: "zero net force",
  });
  assert.equal(g.ok, true);
});

test("respond returns the model message when the guard passes", async () => {
  let capturedSystem = null;
  let capturedUser = null;
  const out = await SLM.respond(
    packet,
    { selected_action: "SOCRATIC_DIALOGUE", reason: "probe reasoning" },
    {
      subject: "Physics",
      gradeLevel: 11,
      studentMessage: "A moving body must have a net force.",
      completion: async ({ system, user }) => {
        capturedSystem = system;
        capturedUser = user;
        return "If the velocity is not changing, what does that tell you about the acceleration?";
      },
    }
  );
  assert.ok(out.message.length > 0);
  assert.equal(out.guard.ok, true);
  assert.equal(out.action, "SOCRATIC_DIALOGUE");
  assert.match(capturedSystem, /communication layer/i);
  assert.match(capturedUser, /STUDENT JUST SAID: A moving body/);
});

test("respond blocks (does not surface) a leaked answer", async () => {
  const out = await SLM.respond(
    packet,
    { selected_action: "MICRO_EXPLANATION" },
    {
      correctAnswer: "42",
      completion: async () => "The final answer is 42.",
    }
  );
  assert.equal(out.message, null);
  assert.equal(out.guard.reason, "leaked_final_answer");
  assert.equal(out.blocked_message, "The final answer is 42.");
});

test("respond is resilient to model errors", async () => {
  const out = await SLM.respond(
    packet,
    { selected_action: "SOCRATIC_DIALOGUE" },
    {
      completion: async () => {
        throw new Error("rate limited");
      },
    }
  );
  assert.equal(out.message, null);
  assert.match(out.error, /rate limited/);
});

test("slmResponderFor yields a pipeline-compatible responder", async () => {
  const responder = SLM.slmResponderFor({
    plan: { selected_action: "DIAGNOSTIC_QUESTION", reason: "uncertain" },
    studentMessage: "I divided by mass.",
    completion: async () => "Which forces actually act on the block here?",
  });
  const out = await responder(packet);
  assert.equal(out.action, "DIAGNOSTIC_QUESTION");
  assert.match(out.message, /forces/i);
});
