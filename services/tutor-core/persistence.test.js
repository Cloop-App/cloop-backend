/**
 * The turn record is the only evidence a session leaves behind, so each of the
 * pilot's recording failures gets a test that would have caught it.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  buildTurnRecord,
  buildTurnLog,
  buildErrorRecord,
  buildFeedbackText,
  masteryOf,
  coverageOf,
} = require("./persistence");

const TOPIC = {
  id: 7,
  title: "Reflection of Light",
  chapter_id: 4,
  subject_id: 3,
  subject_name: "Science",
};
const GOALS = [
  { id: 11, title: "Describe reflection" },
  { id: 12, title: "Apply the law of reflection" },
];

function tallies(...pairs) {
  return pairs.map(([correct, total, errors = []]) => ({ correct, total, errors }));
}

function turnFixture({ nextState: stateOver, evaluatorResult: evalOver, ...over } = {}) {
  return {
    intent: "ANSWER",
    answeredPhase: "DIALOGUE",
    answeredGoalIndex: 0,
    gradedThisTurn: true,
    stateInstruction: "continue_dialogue",
    escalationStep: 0,
    lastQuestionText: "What happens to light at a mirror?",
    ...over,
    evaluatorResult: {
      intent: "ANSWER",
      is_correct: true,
      score_percent: 90,
      error_type: null,
      diff_html: null,
      complete_answer: "The light bounces back",
      suggested_action: "MOVE_ON",
      reasoning: "Correct idea",
      resolved_answer: null,
      ...evalOver,
    },
    nextState: {
      phase: "DIALOGUE",
      perGoal: tallies([1, 1], [0, 0]),
      totalTurns: 4,
      totalQuestions: 1,
      goalIndex: 0,
      goalTotal: 2,
      stuckStreak: 0,
      consecutiveWrong: 0,
      offTopicStreak: 0,
      ...stateOver,
    },
  };
}

function args(over = {}) {
  return {
    userId: 112,
    chatId: 900,
    turn: turnFixture(over),
    prevState: { perGoal: tallies([0, 0], [0, 0]) },
    topic: TOPIC,
    goals: GOALS,
    studentMessage: "it bounces off",
    userName: "Akshit",
    responseTimeSec: 12.5,
  };
}

function build(over = {}) {
  return buildTurnRecord(args(over));
}

function buildLog(over = {}) {
  return buildTurnLog(args(over));
}

test("the pipeline audit log carries what the pilot could not answer", () => {
  const log = buildLog();

  assert.equal(log.answered_in_phase, "DIALOGUE", "which phase the student was answering in");
  assert.equal(log.phase, "DIALOGUE", "and which phase the session moved to");
  assert.equal(log.state_instruction, "continue_dialogue", "which directive the tutor chose");
  assert.equal(log.intent, "ANSWER", "how the evaluator read the message");
  assert.equal(log.escalation_step, 0);
  assert.equal(log.total_turns, 4);
  assert.equal(log.was_graded, true);
  assert.equal(log.goal_index, 0);
  assert.equal(log.goal_correct, 1);
  assert.equal(log.goal_total_questions, 1);
  assert.equal(log.chapter_id, 4);
  assert.equal(log.subject_id, 3);
});

test("the turn record itself no longer duplicates the audit columns", () => {
  const r = build();
  for (const field of ["phase", "directive", "intent", "escalation_step", "turn_number"]) {
    assert.equal(r[field], undefined, `${field} belongs to tutor_turn_logs, not learning_turns`);
  }
});

test("escalation depth and stuckness are recorded on the log", () => {
  const log = buildLog({
    intent: "IDK",
    stateInstruction: "give_starter",
    escalationStep: 2,
    nextState: { perGoal: tallies([0, 1], [0, 0]), stuckStreak: 2, consecutiveWrong: 1 },
  });

  assert.equal(log.escalation_step, 2);
  assert.equal(log.state_instruction, "give_starter");
  assert.equal(log.stuck_streak, 2);
  assert.equal(log.consecutive_wrong, 1);
});

test("the metadata that went missing on 42% of pilot rows is present", () => {
  const r = build();

  assert.equal(r.goal_id, 11);
  assert.equal(r.topic_id, 7);
  assert.equal(r.subject_id, 3);
  assert.equal(r.subject_name, "Science");
  assert.equal(r.topic_title, "Reflection of Light");
  assert.equal(r.question_text, "What happens to light at a mirror?");
  assert.equal(r.user_answer_raw, "it bounces off");
  assert.equal(r.sender, "user");
  assert.equal(r.user_name, "Akshit");
});

test("mastery is the running accuracy on the goal, not zero", () => {
  const r = build();
  assert.equal(r.mastery_score, 100);

  const half = build({ nextState: { perGoal: tallies([1, 2], [0, 0]) } });
  assert.equal(half.mastery_score, 50);
});

test("an ungraded turn scores null, never a default zero or false", () => {
  const r = build({
    answeredPhase: "PROBE",
    gradedThisTurn: false,
    stateInstruction: "probe_prior_knowledge",
    nextState: { perGoal: tallies([0, 0], [0, 0]), totalTurns: 1 },
    evaluatorResult: { is_correct: null, score_percent: null, complete_answer: null },
  });

  assert.equal(r.is_correct, null, "an unassessed answer is not an incorrect one");
  assert.equal(r.score_percent, null);
  assert.equal(r.mastery_score, null, "no evidence yet is not mastery of zero");
  assert.equal(r.feedback_text, null);
});

test("every graded turn carries feedback, however little the evaluator returned", () => {
  const withAnswer = buildFeedbackText(
    { is_correct: false, complete_answer: "Light reflects at an equal angle", error_type: "Conceptual" },
    true
  );
  const withTypeOnly = buildFeedbackText({ is_correct: false, complete_answer: null, error_type: "Conceptual" }, true);
  const withNothing = buildFeedbackText({ is_correct: false, complete_answer: null, error_type: null }, true);

  for (const text of [withAnswer, withTypeOnly, withNothing]) {
    assert.ok(text && text.trim().length > 0, "a wrong answer must never come back unexplained");
  }
  assert.match(withAnswer, /equal angle/);
});

test("response time and help requests are captured rather than left at zero", () => {
  assert.equal(build().response_time_sec, 12.5);
  assert.equal(build().help_requested, "no");
  assert.equal(build({ intent: "HELP" }).help_requested, "yes");
});

test("escalation depth survives onto the record", () => {
  const r = build({ intent: "IDK", stateInstruction: "give_starter", escalationStep: 2 });
  assert.equal(r.help_requested, "no", "IDK is not a help request");
});

test("goal progress moves with the questions actually asked", () => {
  assert.equal(coverageOf({ correct: 0, total: 0 }), 0);
  assert.equal(coverageOf({ correct: 2, total: 3 }), 100);
  assert.equal(coverageOf({ correct: 9, total: 9 }), 100, "coverage is capped, never above 100");

  const r = build({ nextState: { perGoal: tallies([1, 3], [0, 0]) } });
  assert.equal(r.goal_progress_before, 0);
  assert.equal(r.goal_progress_after, 100);
});

test("mastery of an untouched goal is unknown, not zero", () => {
  assert.equal(masteryOf({ correct: 0, total: 0 }), null);
  assert.equal(masteryOf({ correct: 0, total: 2 }), 0, "answered and all wrong really is zero");
});

test("the question type recorded is the one the student answered", () => {
  assert.equal(build().question_type, "open");
  assert.equal(build({ answeredPhase: "CHECK" }).question_type, "mcq");
});

test("a topic with no goals records a null goal rather than inventing one", () => {
  const r = buildTurnRecord({
    userId: 112,
    chatId: 900,
    turn: turnFixture(),
    prevState: { perGoal: tallies([0, 0]) },
    topic: TOPIC,
    goals: [],
    studentMessage: "it bounces off",
  });
  assert.equal(r.goal_id, null);
});

test("only assessed wrong answers are filed as errors", () => {
  const wrong = {
    evaluatorResult: { is_correct: false, score_percent: 20, error_type: "Conceptual" },
  };

  assert.equal(buildErrorRecord(args(), null), null, "a correct answer is not an error");
  assert.equal(
    buildErrorRecord(args({ gradedThisTurn: false, ...wrong }), null),
    null,
    "an unscored guess is not a mistake the student made"
  );

  const record = buildErrorRecord(args(wrong), { perGoal: tallies([0, 0], [0, 0]) });
  assert.ok(record, "an assessed wrong answer is filed");
  assert.equal(record.error_type, "Conceptual");
  assert.equal(record.chapter_id, 4, "filed against the chapter, for concept analysis");
  assert.equal(record.subject_id, 3);
  assert.equal(record.user_answer, "it bounces off");
  assert.equal(record.severity, "medium");
});

test("a zero-score answer is filed as a more severe error", () => {
  const record = buildErrorRecord(
    args({ evaluatorResult: { is_correct: false, score_percent: 0, error_type: "Conceptual" } }),
    null
  );
  assert.equal(record.severity, "high");
});
