/**
 * Full-conversation simulation of the tutoring engine with mock LLMs.
 *
 * Drives a complete two-goal session (concept → exam → score for each goal)
 * through the REAL engine and state machine, asserting the academic-quality
 * properties that the reference chat violated:
 *   - correct answers are affirmed, wrong/idk answers are not (grounded grading)
 *   - the flow never stalls: every turn ends with a question until completion
 *   - no question is ever repeated
 *   - visual aids appear during teaching but never during the exam phase
 *   - a score is predicted at each goal boundary
 */
const { test, assert } = require("./harness");
const { runTutorTurn } = require("../services/tutor_engine");
const { mockGrader, makeMockTutor } = require("./mocks");

const topic = {
  title: "Sustainable Development",
  content:
    "Sustainable development means meeting the needs of the present without compromising " +
    "the ability of future generations to meet their own needs. It balances economic growth, " +
    "social equity and environmental protection. Renewable sources (solar, wind, hydro) " +
    "replenish naturally; non-renewable sources (coal, oil, gas) do not.",
};
const goals = [
  { id: 1, title: "Define Sustainable Development", description: "Understand and define the concept" },
  { id: 2, title: "Analyze Sustainable Practices", description: "Identify everyday sustainable practices" },
];

// Scripted student answers (tags drive the mock grader).
const answers = [
  "ready",            // 1: opening — first question, no grade
  "[wrong] it means recycling",   // 2: concept wrong  -> UNCLEAR
  "[partial] balancing nature",   // 3: concept partial-> PARTLY_CLEAR
  "[correct] meeting present needs without harming the future", // 4: concept -> CLEAR -> exam
  "[correct] development that lasts",  // 5: exam
  "[correct] balances economy, society, environment", // 6: exam -> predict goal1, open goal2
  "idk",               // 7: goal2 concept no-attempt -> UNCLEAR
  "[correct] using cloth bags and saving water", // 8: goal2 concept -> CLEAR -> exam
  "[wrong] buying more plastic", // 9: exam
  "[correct] reusable bottle reduces waste", // 10: exam
  "[partial] less pollution", // 11: exam -> predict goal2 -> session complete
];

async function simulate() {
  const deps = { grade: mockGrader, tutor: makeMockTutor() };
  const history = [
    { sender: "ai", message: "Hi! Ready to begin?", message_type: "text", metadata: null },
  ];
  const turns = [];
  for (const ans of answers) {
    const res = await runTutorTurn(
      { history, topic, goals, userMessage: ans, studentName: "Asha" },
      deps
    );
    // Mirror persistence: append the user turn, then the AI rows (with metadata).
    history.push({ sender: "user", message: ans, message_type: "text", metadata: null });
    for (const row of res.aiRows) history.push({ sender: "ai", ...row });
    turns.push(res);
    if (res.sessionComplete) break;
  }
  return turns;
}

const hasMedia = (r) =>
  !!(r.mermaid_diagram || r.text_diagram || r.youtube_video || r.google_image || r.internet_link);

const lastBubble = (r) => r.messages[r.messages.length - 1].message;

test("simulation runs all 11 scripted turns and ends complete", async () => {
  const turns = await simulate();
  assert.equal(turns.length, 11);
  assert.equal(turns[10].sessionComplete, true);
  assert.ok(turns.slice(0, 10).every((t) => !t.sessionComplete));
});

test("every non-final turn auto-continues with a trailing question", async () => {
  const turns = await simulate();
  for (let i = 0; i < turns.length - 1; i++) {
    assert.ok(turns[i].response.messages.length >= 1, `turn ${i + 1} has no messages`);
    assert.match(lastBubble(turns[i].response), /\?$/, `turn ${i + 1} must end with a question`);
  }
  // Final turn must NOT ask a question.
  assert.doesNotMatch(lastBubble(turns[10].response), /\?$/);
});

test("no question is ever repeated", async () => {
  const turns = await simulate();
  const questions = turns
    .slice(0, 10)
    .map((t) => lastBubble(t.response).toLowerCase().trim());
  assert.equal(new Set(questions).size, questions.length);
});

test("grading is grounded: correct answers affirmed, wrong/idk answers are not", async () => {
  const turns = await simulate();
  const fb = (i) => turns[i].response.user_correction?.feedback?.is_correct;
  assert.equal(fb(1), false, "wrong concept answer must not be marked correct");
  assert.equal(fb(2), false, "partial answer must not be marked correct");
  assert.equal(fb(3), true, "correct concept answer must be affirmed");
  assert.equal(fb(5), true, "correct exam answer must be affirmed");
  // The no-attempt turn (index 6): honesty credit, not correct, no strikethrough.
  assert.equal(turns[6].response.user_correction.feedback.is_correct, false);
  assert.equal(turns[6].response.user_correction.diff_html, null);
  assert.equal(turns[6].response.user_correction.emoji, "😓");
});

test("understanding status reflects answer quality", async () => {
  const turns = await simulate();
  assert.equal(turns[1].response.evaluation.understanding_status, "UNCLEAR");
  assert.equal(turns[2].response.evaluation.understanding_status, "PARTLY_CLEAR");
  assert.equal(turns[3].response.evaluation.understanding_status, "CLEAR");
  assert.equal(turns[6].response.evaluation.understanding_status, "UNCLEAR");
});

test("media is proactive: only when the student is confused or the session is done", async () => {
  const turns = await simulate();
  for (const t of turns) {
    const step = t.response.evaluation.next_step_type;
    // Policy: teaching media on a confusion recheck; further-learning media at
    // completion; nothing on openers, correct answers, exam turns, or goal hops.
    const expectMedia = t.sessionComplete || step === "recheck_understanding";
    assert.equal(
      hasMedia(t.response),
      expectMedia,
      `media gating wrong for step "${step}" (sessionComplete=${t.sessionComplete}): expected ${expectMedia}`
    );
  }
});

test("a confusion turn teaches with a diagram, never an internet link", async () => {
  const turns = await simulate();
  const confused = turns[1].response; // wrong concept answer -> recheck
  assert.equal(confused.evaluation.next_step_type, "recheck_understanding");
  assert.ok(confused.mermaid_diagram, "confusion turn should teach with a diagram");
  assert.equal(confused.internet_link, undefined, "no further-reading link mid-lesson");
});

test("session completion shares further-learning video + link, but no diagram", async () => {
  const turns = await simulate();
  const done = turns[10].response;
  assert.equal(turns[10].sessionComplete, true);
  assert.ok(done.youtube_video, "completion should offer a video for further learning");
  assert.ok(done.internet_link, "completion should offer an internet link");
  assert.ok(done.internet_link.url.startsWith("https://www.google.com/search?q="));
  assert.equal(done.mermaid_diagram, undefined, "no teaching diagram at the wrap-up");
});

test("concept_clarity_score is present for concept grades and null for exam grades", async () => {
  const turns = await simulate();
  for (const t of turns) {
    const ev = t.response.evaluation;
    const gradedConcept = t.response.user_correction && ev.question_mode === "concept";
    if (gradedConcept) {
      assert.equal(typeof ev.concept_clarity_score, "number", "concept grade needs a clarity score");
    } else {
      assert.equal(ev.concept_clarity_score, null);
    }
  }
});

test("a score is predicted at each goal boundary (one per goal)", async () => {
  const turns = await simulate();
  const preds = turns.filter((t) => t.response.score_prediction).map((t) => t.response.score_prediction);
  assert.equal(preds.length, 2);
  assert.equal(preds[0].goal_id, 1);
  assert.equal(preds[1].goal_id, 2);
  for (const p of preds) {
    assert.ok(p.predicted_score >= 0 && p.predicted_score <= 100);
    // predicted = concept*50 + exam*50
    const expected = Math.round((p.concept_score * 50 + p.exam_score * 50) * 10) / 10;
    assert.equal(p.predicted_score, expected);
  }
});

test("every turn carries a well-formed evaluation block", async () => {
  const turns = await simulate();
  for (const t of turns) {
    const ev = t.response.evaluation;
    assert.ok(["concept", "exam"].includes(ev.question_mode));
    assert.ok(typeof ev.next_step_type === "string" && ev.next_step_type.length);
    assert.ok(["CLEAR", "PARTLY_CLEAR", "UNCLEAR", "N/A"].includes(ev.understanding_status));
  }
});
