/**
 * Unit tests for the deterministic building blocks of the tutoring engine.
 */
const { test, assert } = require("./harness");
const { safeJsonParse } = require("../lib/json");
const { normalizeGrade, looksLikeNoAttempt, gradeAnswer } = require("../services/answer_grader");
const { normalizeTurn } = require("../services/tutor_turn");
const { resolveMedia } = require("../services/media_resolver");
const { ratingFor } = require("../services/topic_chat_metrics");
const { mockGrader } = require("./mocks");

// ── lib/json ──
test("safeJsonParse strips code fences", () => {
  const out = safeJsonParse('```json\n{"a":1}\n```');
  assert.deepEqual(out, { a: 1 });
});
test("safeJsonParse recovers JSON amid prose", () => {
  const out = safeJsonParse('Sure! {"a": {"b": 2}} hope that helps');
  assert.deepEqual(out, { a: { b: 2 } });
});
test("safeJsonParse returns fallback on garbage", () => {
  assert.equal(safeJsonParse("not json", null), null);
});

// ── no-attempt detection ──
test("looksLikeNoAttempt catches idk / blank / skip", () => {
  for (const s of ["", "  ", "idk", "I don't know", "no idea", "skip", "?"]) {
    assert.equal(looksLikeNoAttempt(s), true, `expected no-attempt for "${s}"`);
  }
  assert.equal(looksLikeNoAttempt("Solar energy is renewable"), false);
});

// ── grade normalisation: the core academic guardrail ──
test("normalizeGrade forces is_correct=false when correctness<1 even if model claims true", () => {
  const g = normalizeGrade(
    { is_correct: true, correctness: 0.5, reasoning_quality: 1, completeness: 1, score_percent: 90 },
    "some answer"
  );
  assert.equal(g.is_correct, false);
});
test("normalizeGrade keeps is_correct=true only when correctness=1 and completeness>=0.5", () => {
  const g = normalizeGrade(
    { is_correct: true, correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 100 },
    "great answer"
  );
  assert.equal(g.is_correct, true);
});
test("normalizeGrade treats blank/idk as no-attempt with honesty credit and null diff", () => {
  const g = normalizeGrade({ correctness: 1, is_correct: true }, "idk");
  assert.equal(g.is_no_attempt, true);
  assert.equal(g.is_correct, false);
  assert.equal(g.score_percent, 10);
  assert.equal(g.diff_html, null);
});
test("normalizeGrade drops diff_html that lacks correction markup", () => {
  const g = normalizeGrade(
    { correctness: 1, reasoning_quality: 1, completeness: 1, diff_html: "no tags here", score_percent: 100 },
    "answer"
  );
  assert.equal(g.diff_html, null);
});

// ── gradeAnswer end to end with a mock LLM (typo path) ──
test("gradeAnswer preserves a real spelling diff for an otherwise-correct answer", async () => {
  const g = await gradeAnswer(
    {
      answer: "coal is non renewble source of energy [typo]",
      question: "Is coal renewable?",
      phase: "concept",
      topic: { title: "Energy", content: "" },
      goal: { title: "Energy types" },
    },
    mockGrader
  );
  assert.equal(g.is_correct, true);
  assert.match(g.diff_html, /<del>renewble<\/del><ins>renewable<\/ins>/);
  assert.equal(g.error_type, "Spelling Error");
});

// ── turn normalisation: auto-continue + media gating ──
test("normalizeTurn always ends with a question when the session is not complete", () => {
  const step = { action: "ask_question", nextPhase: "concept", nextGoalTitle: "X", allowMedia: false, technique: "Contrast" };
  const turn = normalizeTurn({ messages: [{ message: "Nice try." }], next_question: null }, step, []);
  assert.ok(turn.next_question, "should synthesise a question");
  const last = turn.messages[turn.messages.length - 1];
  assert.equal(last.message, turn.next_question);
});
test("normalizeTurn strips diagrams/videos when the step forbids media (exam phase)", () => {
  const step = { action: "ask_question", nextPhase: "exam", nextGoalTitle: "X", allowMedia: false, technique: "Recall" };
  const raw = {
    messages: [{ message: "Correct." }],
    next_question: "Define X?",
    mermaid_diagram: { code: "graph TD\n A-->B", title: "t" },
    youtube_video: { search_query: "x", title: "v" },
  };
  const turn = normalizeTurn(raw, step, []);
  assert.equal(turn.mermaid_diagram, undefined);
  assert.equal(turn.youtube_video, undefined);
});
test("normalizeTurn keeps + resolves media when the step allows it", () => {
  const step = { action: "ask_question", nextPhase: "concept", nextGoalTitle: "X", allowMedia: true, technique: "Contrast" };
  const raw = {
    messages: [{ message: "Not quite." }],
    next_question: "Why is coal non-renewable?",
    mermaid_diagram: { code: "graph TD\n A-->B", title: "t", trigger: "correction" },
    youtube_video: { search_query: "renewable energy kids", title: "v" },
  };
  const turn = normalizeTurn(raw, step, []);
  assert.ok(turn.mermaid_diagram);
  assert.ok(turn.youtube_video.url.startsWith("https://www.youtube.com/results?search_query="));
});
test("normalizeTurn avoids repeating an already-asked question", () => {
  const step = { action: "ask_question", nextPhase: "concept", nextGoalTitle: "Friction", allowMedia: false, technique: "Contrast" };
  const turn = normalizeTurn(
    { messages: [{ message: "ok" }], next_question: "What is friction?" },
    step,
    ["what is friction?"]
  );
  assert.notEqual(turn.next_question.toLowerCase().replace(/[^a-z ]/g, "").trim(), "what is friction");
});

// ── media resolver ──
test("resolveMedia builds deterministic, working search URLs without an API key", () => {
  const yt = resolveMedia.youtube({ search_query: "photosynthesis for kids" });
  const img = resolveMedia.image({ search_query: "photosynthesis diagram" });
  assert.equal(yt.url, "https://www.youtube.com/results?search_query=photosynthesis%20for%20kids");
  assert.equal(img.url, "https://www.google.com/search?tbm=isch&q=photosynthesis%20diagram");
});
test("resolveMedia.web builds a search link, or passes through an explicit URL", () => {
  const fromQuery = resolveMedia.web({ search_query: "friction notes class 8" });
  assert.equal(fromQuery.url, "https://www.google.com/search?q=friction%20notes%20class%208");
  const explicit = resolveMedia.web({ search_query: "x", url: "https://ncert.nic.in/page" });
  assert.equal(explicit.url, "https://ncert.nic.in/page");
});

// ── media policy: confusion vs completion ──
test("normalizeTurn at session completion offers a video + link but no diagram", () => {
  const step = { action: "session_complete", nextPhase: "exam", nextGoalTitle: "X", extension: true, sessionComplete: true };
  const raw = {
    messages: [{ message: "Great work this session!" }],
    next_question: null,
    mermaid_diagram: { code: "graph TD\n A-->B", title: "t" },
    youtube_video: { search_query: "topic deep dive", title: "More" },
    internet_link: { search_query: "topic notes", title: "Read more" },
  };
  const turn = normalizeTurn(raw, step, []);
  assert.equal(turn.mermaid_diagram, undefined, "no diagram in the wrap-up");
  assert.ok(turn.youtube_video, "video offered for further learning");
  assert.ok(turn.internet_link, "internet link offered for further learning");
});
test("normalizeTurn never attaches an internet link mid-lesson (confusion turn)", () => {
  const step = { action: "ask_question", nextPhase: "concept", nextGoalTitle: "X", allowMedia: true, technique: "Contrast" };
  const raw = {
    messages: [{ message: "Not quite." }],
    next_question: "Why is coal non-renewable?",
    internet_link: { search_query: "coal notes", title: "Read" },
    mermaid_diagram: { code: "graph TD\n A-->B", title: "t" },
  };
  const turn = normalizeTurn(raw, step, []);
  assert.equal(turn.internet_link, undefined, "links are for completion only");
  assert.ok(turn.mermaid_diagram, "a diagram is fine while teaching");
});

// ── rating ──
test("ratingFor maps percentages to sensible stars/labels", () => {
  assert.deepEqual(ratingFor(90), { star: 5, level: "Excellent" });
  assert.deepEqual(ratingFor(72), { star: 4, level: "Great" });
  assert.deepEqual(ratingFor(30), { star: 2, level: "Needs Practice" });
});
