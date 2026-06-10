/**
 * Grounded-grader case tests.
 *
 * These prove the behaviour that the single-call tutor got wrong (e.g. marking
 * "Octogon" correct for a 5-sided polygon). Two layers:
 *   1. normalizeGrade guardrails — deterministic, no API. The key invariant:
 *      is_correct is derived from the rubric, NOT from whatever the model claims,
 *      and a spelling fix never turns a wrong fact into a correct answer.
 *   2. gradeAnswer pipeline — driven by a mock grader LLM that returns a
 *      realistic grounded verdict, so we test the full path offline.
 *
 * The TypeScript port for CloopDev (answerGrader.test.ts) mirrors these exactly,
 * plus a live-API integration block.
 */
const { test, assert } = require("./harness");
const { gradeAnswer, normalizeGrade } = require("../services/answer_grader");

// A mock grounded grader: returns the verdict a temperature-0 grounded grader
// SHOULD produce for each answer, so we can assert the pipeline end to end.
function mockGroundedGrader(messages) {
  const user = messages.find((m) => m.role === "user")?.content || "";
  const ans = (user.match(/STUDENT ANSWER:\s*"([\s\S]*)"/) || [])[1] || user;
  const a = ans.toLowerCase();

  // 5-sided polygon answered "Octogon" — spelling fixed, but factually wrong.
  if (/octog|octag/.test(a)) {
    return Promise.resolve(JSON.stringify({
      is_no_attempt: false, is_correct: true /* model is wrongly agreeable */,
      correctness: 0, reasoning_quality: 0, completeness: 0,
      concept_clarity_score: 0, score_percent: 25, error_type: "Conceptual Error",
      misconception_guess: "confuses octagon (8 sides) with pentagon (5 sides)",
      diff_html: "<del>Octogon</del><ins>Octagon</ins>",
      complete_answer: "A 5-sided polygon is a pentagon.",
    }));
  }
  // Correct answer with a spelling slip ("pentgon").
  if (/pent/.test(a)) {
    return Promise.resolve(JSON.stringify({
      is_no_attempt: false, is_correct: true,
      correctness: 1, reasoning_quality: 1, completeness: 1,
      concept_clarity_score: 1, score_percent: 90, error_type: "Spelling Error",
      misconception_guess: null,
      diff_html: "A 5-sided polygon is a <del>pentgon</del><ins>pentagon</ins>.",
      complete_answer: "A 5-sided polygon is a pentagon.",
    }));
  }
  // Partial.
  return Promise.resolve(JSON.stringify({
    is_no_attempt: false, is_correct: false,
    correctness: 0.5, reasoning_quality: 0.5, completeness: 0.5,
    concept_clarity_score: 0.5, score_percent: 60, error_type: "Partially Correct",
    misconception_guess: null, diff_html: null, complete_answer: "A pentagon has 5 sides.",
  }));
}

const Q = "A polygon has 5 sides. What is its specific name?";
const topic = { title: "Polygons", content: "A pentagon has 5 sides. A hexagon has 6. An octagon has 8." };
const goal = { title: "Name polygons by their number of sides" };

// ── 1. Guardrail (deterministic) ──
test("normalizeGrade: a wrong fact stays wrong even if the model claims is_correct=true", () => {
  const g = normalizeGrade(
    { is_correct: true, correctness: 0, reasoning_quality: 0, completeness: 0, score_percent: 25,
      error_type: "Conceptual Error", diff_html: "<del>Octogon</del><ins>Octagon</ins>",
      complete_answer: "A 5-sided polygon is a pentagon." },
    "Octogon"
  );
  assert.equal(g.is_correct, false, "octagon for a 5-sided polygon must be WRONG");
  assert.equal(g.error_type, "Conceptual Error");
  assert.match(g.diff_html, /<del>Octogon<\/del><ins>Octagon<\/ins>/, "spelling still corrected");
  assert.match(g.complete_answer, /pentagon/i);
});

test("normalizeGrade: a correct answer keeps its spelling fix and is_correct=true", () => {
  const g = normalizeGrade(
    { is_correct: true, correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 90,
      error_type: "Spelling Error", diff_html: "A 5-sided polygon is a <del>pentgon</del><ins>pentagon</ins>." },
    "A 5-sided polygon is a pentgon."
  );
  assert.equal(g.is_correct, true);
  assert.equal(g.error_type, "Spelling Error");
  assert.ok(g.diff_html.includes("<ins>pentagon</ins>"));
});

// ── 2. Full gradeAnswer pipeline (mock grounded LLM) ──
test("gradeAnswer: 'Octogon' for a 5-sided polygon → WRONG, names pentagon, fixes spelling", async () => {
  const g = await gradeAnswer({ answer: "Octogon", question: Q, phase: "exam", topic, goal }, mockGroundedGrader);
  assert.equal(g.is_correct, false);
  assert.equal(g.error_type, "Conceptual Error");
  assert.match(g.complete_answer, /pentagon/i);
  assert.match(g.diff_html, /Octagon/);
});

test("gradeAnswer: 'pentgon' → CORRECT with a spelling note", async () => {
  const g = await gradeAnswer({ answer: "pentgon", question: Q, phase: "exam", topic, goal }, mockGroundedGrader);
  assert.equal(g.is_correct, true);
  assert.equal(g.error_type, "Spelling Error");
  assert.ok(g.diff_html && g.diff_html.includes("<ins>pentagon</ins>"));
});

test("gradeAnswer: 'idk' → no-attempt fast path (10%, null diff), no API call needed", async () => {
  let called = false;
  const spy = (...args) => { called = true; return mockGroundedGrader(...args); };
  const g = await gradeAnswer({ answer: "idk", question: Q, phase: "exam", topic, goal }, spy);
  assert.equal(g.is_no_attempt, true);
  assert.equal(g.is_correct, false);
  assert.equal(g.score_percent, 10);
  assert.equal(g.diff_html, null);
  assert.equal(called, false, "no-attempt should not spend an LLM call");
});
