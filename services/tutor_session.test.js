/**
 * End-to-end proof that a student turn reaches the database fully recorded.
 *
 * The pilot's data problems were not visible from any single module: each
 * piece looked fine and the seam between them lost the fields. So this test
 * drives the real session service with the database and both model calls
 * stubbed, and asserts on the row that would actually have been written.
 */

const test = require("node:test");
const assert = require("node:assert");

// ── stubs, installed before the service is loaded ──────────────────────────
const prismaPath = require.resolve("../lib/prisma");
const evaluatorPath = require.resolve("./tutor-core/evaluator");
const generatorPath = require.resolve("./tutor-core/tutor-generator");

const writes = {
  learning_turns: [],
  turn_logs: [],
  errors: [],
  summaries: [],
  goal_progress: [],
  admin_chat: [],
  sessions: [],
  reports: [],
};
let verdict;
let sessionState = null;

const TOPIC = {
  id: 7,
  title: "Reflection of Light",
  content: "Light bounces off surfaces.",
  subject_id: 3,
  chapter: { subject: { id: 3, name: "Science" } },
  goals: [
    { id: 11, title: "Describe reflection", description: "" },
    { id: 12, title: "Apply the law of reflection", description: "" },
  ],
};

let nextId = 1000;

const prismaStub = {
  global_topics: { findUnique: async () => TOPIC },
  users: { findUnique: async () => ({ user_id: 112, name: "Akshit", grade_level: "9", board: "CBSE" }) },
  tutor_sessions: {
    findFirst: async () => sessionState,
    create: async ({ data }) => {
      sessionState = { id: 500, ...data };
      writes.sessions.push(sessionState);
      return sessionState;
    },
    update: async ({ data }) => {
      sessionState = { ...sessionState, ...data };
      writes.sessions.push(data);
      return sessionState;
    },
  },
  admin_chat: {
    findMany: async () => [],
    create: async ({ data }) => {
      const row = { id: nextId++, created_at: new Date(), ...data };
      writes.admin_chat.push(row);
      return row;
    },
    update: async ({ data }) => {
      writes.admin_chat.push({ update: data });
      return data;
    },
  },
  learning_turns: {
    create: async ({ data }) => {
      writes.learning_turns.push(data);
      return { id: nextId++, ...data };
    },
  },
  tutor_turn_logs: {
    create: async ({ data }) => {
      writes.turn_logs.push(data);
      return { id: nextId++, ...data };
    },
  },
  topic_chat_errors: {
    create: async ({ data }) => {
      writes.errors.push(data);
      return { id: nextId++, ...data };
    },
  },
  topic_chat_sessions: {
    create: async ({ data }) => {
      writes.summaries.push(data);
      return { id: nextId++, ...data };
    },
  },
  chat_goal_progress: {
    findMany: async () => [],
    // Keyed like the real unique constraint (chat_id, goal_id, user_id). A
    // stub that just appended could not see the bug this table actually had:
    // keying on the current message makes every turn a new row.
    upsert: async ({ where, create, update }) => {
      const k = Object.values(where.chat_id_goal_id_user_id).join("|");
      const existing = writes.goal_progress.find((r) => r.key === k);
      if (existing) {
        Object.assign(existing.row, update);
        return existing.row;
      }
      const row = { ...create };
      writes.goal_progress.push({ key: k, row });
      return row;
    },
  },
  user_topic_reports: {
    upsert: async (args) => {
      writes.reports.push(args);
      return args.create;
    },
  },
};

require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaStub };
require.cache[evaluatorPath] = {
  id: evaluatorPath,
  filename: evaluatorPath,
  loaded: true,
  exports: {
    evaluateStudentTurn: async () => verdict,
    resolveOptionAnswer: (m) => ({ isOption: false, resolvedText: m, raw: m }),
  },
};
require.cache[generatorPath] = {
  id: generatorPath,
  filename: generatorPath,
  loaded: true,
  exports: {
    generateTutorResponse: async ({ stateInstruction }) => ({
      messages: [{ message: `Reply for ${stateInstruction}?`, message_type: "text" }],
    }),
  },
};

const { processMessage } = require("./tutor_session");

function reset() {
  for (const key of Object.keys(writes)) writes[key] = [];
  sessionState = null;
  verdict = {
    intent: "ANSWER",
    is_correct: true,
    score_percent: 95,
    error_type: null,
    diff_html: null,
    complete_answer: "It bounces back",
    suggested_action: "MOVE_ON",
    reasoning: "correct",
    resolved_answer: null,
  };
}

/** Walk the session far enough to reach a scored DIALOGUE turn. */
async function runTurns(n) {
  for (let i = 0; i < n; i++) await processMessage(7, 112, `answer ${i}`);
  return writes.learning_turns;
}

test("every turn writes an audit log carrying the instrumentation", async () => {
  reset();
  await runTurns(4);

  assert.equal(writes.turn_logs.length, 4, "one log per turn");
  for (const log of writes.turn_logs) {
    assert.ok(log.phase, "phase must be recorded on every turn");
    assert.ok(log.state_instruction, "directive must be recorded on every turn");
    assert.ok(log.intent, "intent must be recorded on every turn");
    assert.equal(typeof log.escalation_step, "number");
    assert.ok(log.total_turns > 0);
  }

  assert.deepEqual(
    writes.turn_logs.map((l) => l.answered_in_phase),
    ["PROBE", "THEORY", "OBJECTIVES", "DIALOGUE"],
    "the session walks the arc instead of sitting in one phase"
  );
  assert.equal(writes.learning_turns.length, 4, "and the student-facing record keeps pace");
});

test("the metadata that was null on 42% of pilot rows is always present", async () => {
  reset();
  const rows = await runTurns(4);

  for (const row of rows) {
    assert.equal(row.goal_id, 11);
    assert.equal(row.topic_id, 7);
    assert.equal(row.subject_id, 3);
    assert.equal(row.subject_name, "Science");
    assert.equal(row.topic_title, "Reflection of Light");
    assert.equal(row.sender, "user");
    assert.ok(row.question_text, "the question the student answered is recorded");
    assert.ok(row.user_answer_raw, "the answer itself is recorded");
  }
});

test("scored turns carry mastery and feedback; unscored ones carry neither", async () => {
  reset();
  const rows = await runTurns(4);

  const [probe, , , dialogue] = rows;

  assert.equal(probe.is_correct, null, "a PROBE answer is not graded");
  assert.equal(probe.mastery_score, null, "and so has no mastery, rather than zero");

  assert.equal(dialogue.is_correct, true);
  assert.equal(dialogue.mastery_score, 100, "mastery is the running accuracy, not zero");
  assert.ok(dialogue.feedback_text, "a graded turn always explains itself");
});

test("a wrong answer is never recorded without feedback", async () => {
  reset();
  await runTurns(3);

  verdict = {
    intent: "ANSWER",
    is_correct: false,
    score_percent: 20,
    error_type: "Conceptual",
    diff_html: "<del>absorbs</del><ins>reflects</ins>",
    complete_answer: "Light reflects at an equal angle",
    suggested_action: "RETEACH_NEW_ANGLE",
    reasoning: "wrong",
    resolved_answer: null,
  };
  await processMessage(7, 112, "it absorbs");

  const row = writes.learning_turns.at(-1);
  assert.equal(row.is_correct, false);
  assert.ok(row.feedback_text && row.feedback_text.trim().length > 0);
  assert.equal(row.diff_html, "<del>absorbs</del><ins>reflects</ins>");
  assert.equal(row.error_type, "Conceptual");
  assert.equal(row.mastery_score, 0, "answered and wrong is a real zero");
});

test("goal progress is written once per goal, not once per message", async () => {
  reset();
  await runTurns(4);

  // Four turns, but only the DIALOGUE one was assessed.
  assert.equal(writes.goal_progress.length, 1, "unscored turns must not touch the tally");
  assert.equal(writes.goal_progress[0].row.goal_id, 11);
  assert.equal(writes.goal_progress[0].row.num_questions, 1);
  assert.equal(writes.goal_progress[0].row.num_correct, 1);
});

test("a second answer on the same goal updates its row rather than adding one", async () => {
  reset();
  await runTurns(6); // PROBE, THEORY, OBJECTIVES, then several DIALOGUE turns

  assert.equal(
    writes.goal_progress.length,
    1,
    "keying progress on the current message is what gave the pilot 2,209 rows for 137 goals"
  );

  const { row } = writes.goal_progress[0];
  assert.equal(row.goal_id, 11);
  assert.ok(row.num_questions >= 2, "the tally accumulates across turns");
  assert.equal(row.num_questions, row.num_correct, "all answers were correct in this run");
});

test("goal progress is anchored to the session, not the turn", async () => {
  reset();
  await runTurns(6);

  const anchor = writes.admin_chat.find((m) => m.sender === "user").id;
  const [chatId] = writes.goal_progress[0].key.split("|");
  assert.equal(Number(chatId), anchor, "the session's first message is its stable id");
});

test("session state is persisted so a restart cannot reset the student to PROBE", async () => {
  reset();
  await processMessage(7, 112, "some water");

  const saved = writes.sessions.at(-1);
  assert.equal(saved.state.phase, "THEORY", "the advanced state is stored, not the initial one");
  assert.equal(saved.state.totalTurns, 1);
});

test("the student's message is stored before the model runs", async () => {
  reset();
  await processMessage(7, 112, "light bounces");

  const first = writes.admin_chat[0];
  assert.equal(first.sender, "user");
  assert.equal(first.message, "light bounces");
  assert.equal(first.session_id, 500, "and is scoped to the session");
});

test("a wrong answer marks the student's own message with the correction", async () => {
  reset();
  await runTurns(3);
  verdict = {
    intent: "ANSWER",
    is_correct: false,
    score_percent: 0,
    error_type: "Conceptual",
    diff_html: "<del>a</del><ins>b</ins>",
    complete_answer: "b",
    suggested_action: "REASK",
    reasoning: "",
    resolved_answer: null,
  };
  await processMessage(7, 112, "a");

  const correction = writes.admin_chat.find((w) => w.update?.message_type === "user_correction");
  assert.ok(correction, "the strikethrough goes on the student's message");
  assert.equal(correction.update.diff_html, "<del>a</del><ins>b</ins>");
});
