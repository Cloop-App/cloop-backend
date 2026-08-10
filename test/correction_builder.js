/**
 * Correction builder tests — the strikethrough shown for wrong answers.
 * Proves the diff is a clean word-level replacement (no garbling, no invented
 * words, safe HTML), matching the app's CORRECTIONS card.
 */
const { test, assert } = require("./harness");
const { buildWordDiff, buildCorrection } = require("../services/correction_builder");
const { gradeAnswer } = require("../services/answer_grader");

test("single wrong term → clean <del>/<ins> swap", () => {
  assert.equal(buildWordDiff("chemicals", "pollutants"), "<del>chemicals</del><ins>pollutants</ins>");
});

test("keeps shared words as plain text (the iris → the pupil)", () => {
  assert.equal(buildWordDiff("the iris", "the pupil"), "the <del>iris</del><ins>pupil</ins>");
});

test("multi-word wrong term is grouped, not mashed per-word", () => {
  assert.equal(buildWordDiff("water pollution", "eutrophication"),
    "<del>water pollution</del><ins>eutrophication</ins>");
});

test("no change when the answer already matches (case-insensitive) → null", () => {
  assert.equal(buildWordDiff("Pollutants", "pollutants"), null);
});

test("escapes HTML in student input (no injection)", () => {
  const html = buildWordDiff("<b>x</b>", "pollutants");
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;/);
});

test("buildCorrection returns the correct sentence + the strikethrough", () => {
  const c = buildCorrection({
    studentAnswer: "chemicals",
    correctTerm: "pollutants",
    completeAnswer: "The harmful substances that cause air pollution are called pollutants.",
  });
  assert.equal(c.complete_answer, "The harmful substances that cause air pollution are called pollutants.");
  assert.equal(c.diff_html, "<del>chemicals</del><ins>pollutants</ins>");
});

test("gradeAnswer surfaces correct_term for the engine to build the diff", async () => {
  const mock = () =>
    Promise.resolve(JSON.stringify({
      is_correct: true, correctness: 0, reasoning_quality: 0, completeness: 0,
      score_percent: 30, error_type: "Conceptual Error", diff_html: null,
      complete_answer: "The harmful substances are called pollutants.", correct_term: "pollutants",
    }));
  const g = await gradeAnswer(
    { answer: "chemicals", question: "What are they called?", phase: "exam",
      topic: { title: "Pollution", content: "" }, goal: { title: "Air pollution" } },
    mock
  );
  assert.equal(g.is_correct, false); // guardrail flips the agreeable claim
  assert.equal(g.correct_term, "pollutants");
  assert.equal(buildWordDiff("chemicals", g.correct_term), "<del>chemicals</del><ins>pollutants</ins>");
});
