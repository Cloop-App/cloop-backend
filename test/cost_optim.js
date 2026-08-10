/**
 * Cost-optimisation tests: tiered model routing + correction cache.
 * All offline — proves the routing decisions and cache hit/miss behaviour that
 * cut inference cost, with no API calls.
 */
const { test, assert } = require("./harness");

// Load the router in isolation with DISTINCT tier ids so we can prove routing
// actually sends different turn types to different models.
delete require.cache[require.resolve("../services/model_router")];
process.env.MODEL_CHEAP = "cheap-x";
process.env.MODEL_MID = "mid-x";
process.env.MODEL_SMART = "smart-x";
const { routeGrader, routeTutor, classifyTurn, TIERS } = require("../services/model_router");

const { createCorrectionCache, cacheKey, normalize } = require("../services/correction_cache");
const { gradeAnswer } = require("../services/answer_grader");

// ── Model router ──
test("grader: concept answers get the SMART model, exam answers get MID", () => {
  assert.equal(routeGrader({ phase: "concept" }), TIERS.smart);
  assert.equal(routeGrader({ phase: "exam" }), TIERS.mid);
});

test("tutor: routine turns get CHEAP, teaching/confusion turns get a better model", () => {
  // Correct answer moving to exam → routine → cheap.
  const routine = { nextStepType: "ask_exam_question", allowMedia: false };
  assert.equal(routeTutor(routine, { is_correct: true, is_no_attempt: false }), TIERS.cheap);

  // First opener → cheap.
  assert.equal(routeTutor({ nextStepType: "ask_concept_question", allowMedia: false }, null), TIERS.cheap);

  // Confusion recheck → not cheap.
  const recheck = { nextStepType: "recheck_understanding", allowMedia: true };
  assert.equal(routeTutor(recheck, { is_correct: false, is_no_attempt: false }), TIERS.mid);

  // Struggle check-in → not cheap.
  assert.equal(routeTutor({ nextStepType: "struggle_checkin", allowMedia: true }, null), TIERS.mid);

  // Session complete (extension media) → not cheap.
  assert.equal(routeTutor({ nextStepType: "predict_score", extension: true }, { is_correct: true }), TIERS.mid);
});

test("classifyTurn labels the cheap/diagnostic split for analytics", () => {
  assert.equal(classifyTurn({ nextStepType: "ask_exam_question" }, { is_correct: true }).tier, "routine");
  assert.equal(classifyTurn({ nextStepType: "recheck_understanding" }, { is_correct: false }).tier, "diagnostic");
});

// ── Correction cache ──
test("cacheKey normalises casing/punctuation so cosmetic variants share an entry", () => {
  const a = cacheKey({ topicId: 245, question: "Name a 5-sided polygon?", answer: "Octogon" });
  const b = cacheKey({ topicId: 245, question: "name a 5-sided polygon", answer: "octogon." });
  assert.equal(a, b);
  const c = cacheKey({ topicId: 245, question: "Name a 5-sided polygon?", answer: "Octagon" });
  assert.notEqual(a, c); // genuinely different answer → different key
});

test("cache stores real grades but never no-attempts or failure fallbacks", async () => {
  const cache = createCorrectionCache();
  const p = { topicId: 1, question: "q", answer: "coal is renewable" };
  await cache.set(p, { is_correct: false, score_percent: 30 });
  assert.ok(await cache.get(p));

  await cache.set({ topicId: 1, question: "q", answer: "idk" }, { is_no_attempt: true });
  assert.equal(await cache.get({ topicId: 1, question: "q", answer: "idk" }), null);

  await cache.set({ topicId: 1, question: "q", answer: "x" }, { _fallback: true });
  assert.equal(await cache.get({ topicId: 1, question: "q", answer: "x" }), null);
});

test("gradeAnswer serves a repeat answer from cache without a second LLM call", async () => {
  let calls = 0;
  const mock = () => {
    calls++;
    return Promise.resolve(
      JSON.stringify({
        correctness: 0, reasoning_quality: 0, completeness: 0, concept_clarity_score: 0,
        score_percent: 25, error_type: "Conceptual Error", diff_html: null,
        complete_answer: "A 5-sided polygon is a pentagon.",
      })
    );
  };
  const cache = createCorrectionCache();
  const base = {
    question: "A polygon has 5 sides. What is its specific name?",
    phase: "exam",
    topic: { id: 245, title: "Polygons", content: "" },
    goal: { title: "Name polygons" },
    cache,
  };

  const g1 = await gradeAnswer({ ...base, answer: "Octogon" }, mock);
  const g2 = await gradeAnswer({ ...base, answer: "octogon." }, mock); // same normalised answer

  assert.equal(calls, 1, "second identical answer must hit the cache, not the LLM");
  assert.equal(g2._cached, true);
  assert.equal(g1.is_correct, false);
  assert.equal(g2.is_correct, false);
});
