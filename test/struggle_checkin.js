/**
 * Struggle check-in simulation.
 *
 * Verifies the academic rule the compressed prompt added: after 3 straight
 * UNCLEAR answers on a concept, the tutor does NOT silently jump ahead — it
 * re-teaches (with a visual) and offers a choice, and the student's choice is
 * treated as a CHOICE (never graded).
 */
const { test, assert } = require("./harness");
const { runTutorTurn } = require("../services/tutor_engine");
const { makeMockTutor } = require("./mocks");

// Mock grader: every scripted "[wrong]" answer is UNCLEAR (clarity 0).
function wrongGrader() {
  return Promise.resolve(
    JSON.stringify({
      is_no_attempt: false, is_correct: false,
      correctness: 0, reasoning_quality: 0, completeness: 0,
      concept_clarity_score: 0, score_percent: 25, error_type: "Conceptual Error",
      misconception_guess: "mixes up the idea", diff_html: null,
      complete_answer: "The correct idea, explained simply.",
    })
  );
}

const topic = { title: "Fractions", content: "A fraction represents part of a whole." };
const goals = [{ id: 1, title: "Understand fractions", description: "What a fraction means" }];

async function run(finalReply) {
  const deps = { grade: wrongGrader, tutor: makeMockTutor() };
  const history = [{ sender: "ai", message: "Hi! Ready?", message_type: "text", metadata: null }];
  const answers = ["start", "[wrong]", "[wrong]", "[wrong]", finalReply];
  const turns = [];
  for (const ans of answers) {
    const res = await runTutorTurn({ history, topic, goals, userMessage: ans, studentName: "Sam" }, deps);
    history.push({ sender: "user", message: ans, message_type: "text", metadata: null });
    for (const row of res.aiRows) history.push({ sender: "ai", ...row });
    turns.push(res);
  }
  return turns;
}

test("after 3 straight UNCLEAR answers, the tutor offers a check-in (not a silent jump)", async () => {
  const turns = await run("Move on");
  const checkin = turns[3].response; // 3rd wrong answer triggers it
  assert.equal(checkin.evaluation.next_step_type, "struggle_checkin");
  assert.deepEqual(checkin.options, ["Practice a bit more", "Move on"]);
  // It teaches with a visual and does NOT end on a quiz question.
  assert.ok(
    checkin.mermaid_diagram || checkin.text_diagram || checkin.youtube_video,
    "check-in should include a teaching visual"
  );
  const last = checkin.messages[checkin.messages.length - 1].message;
  assert.match(last, /move on|practi/i, "check-in ends with the practise/move-on choice");
  // The triggering answer was still graded (wrong).
  assert.equal(checkin.user_correction.feedback.is_correct, false);
});

test("'Move on' is treated as a choice (not graded) and advances to the exam", async () => {
  const turns = await run("Move on");
  const afterChoice = turns[4].response;
  assert.equal(afterChoice.user_correction, null, "a choice must not be graded");
  assert.equal(afterChoice.evaluation.next_step_type, "ask_exam_question");
  assert.equal(afterChoice.evaluation.question_mode, "exam");
});

test("'Practice a bit more' keeps practising with an easier concept question", async () => {
  const turns = await run("Practice a bit more");
  const afterChoice = turns[4].response;
  assert.equal(afterChoice.user_correction, null, "a choice must not be graded");
  assert.equal(afterChoice.evaluation.next_step_type, "recheck_understanding");
  assert.equal(afterChoice.evaluation.question_mode, "concept");
  // Ends with a real question again (auto-continue resumes).
  assert.match(afterChoice.messages[afterChoice.messages.length - 1].message, /\?\s*$/);
});
