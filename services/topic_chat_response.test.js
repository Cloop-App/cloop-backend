const test = require("node:test");
const assert = require("node:assert");
const { parseTutorResponse } = require("./topic_chat_response");

const turn = (o) => JSON.stringify(o);

test("parses a well-formed turn", () => {
  const r = parseTutorResponse(
    turn({
      ai_messages: [{ message_type: "text", message: "Faster or slower?" }],
      feedback: { is_correct: true, bubble_color: "green" },
    })
  );
  assert.strictEqual(r.parseOk, true);
  assert.strictEqual(r.hasMessages, true);
  assert.strictEqual(r.response.ai_messages.length, 1);
  assert.strictEqual(r.response.feedback.is_correct, true);
});

test('normalises the legacy "messages" key to "ai_messages"', () => {
  // Prompt revisions before v5 told the model to emit `messages`, while the
  // app reads `ai_messages`. The mismatch reached students as blank bubbles.
  const r = parseTutorResponse(turn({ messages: [{ message: "Iron or copper?" }] }));
  assert.strictEqual(r.hasMessages, true);
  assert.strictEqual(r.response.ai_messages[0].message, "Iron or copper?");
  assert.match(r.note, /normalised/);
});

test("drops blank and whitespace-only messages", () => {
  const r = parseTutorResponse(
    turn({ ai_messages: [{ message: "   " }, { message: "" }, { message: "Why?" }] })
  );
  assert.strictEqual(r.response.ai_messages.length, 1);
  assert.strictEqual(r.response.ai_messages[0].message, "Why?");
});

test("reports nothing renderable rather than emitting an empty bubble", () => {
  const r = parseTutorResponse(turn({ ai_messages: [{ message: "  " }] }));
  assert.strictEqual(r.hasMessages, false, "caller must retry, not persist");
  assert.strictEqual(r.response.ai_messages.length, 0);
});

test("unwraps a markdown code fence around the JSON", () => {
  const r = parseTutorResponse("```json\n" + turn({ ai_messages: [{ message: "Hi?" }] }) + "\n```");
  assert.strictEqual(r.parseOk, true);
  assert.strictEqual(r.response.ai_messages[0].message, "Hi?");
});

test("recovers a JSON object surrounded by prose", () => {
  const r = parseTutorResponse(
    "Sure! Here you go:\n" + turn({ ai_messages: [{ message: "Why?" }] }) + "\nHope that helps."
  );
  assert.strictEqual(r.parseOk, true);
  assert.strictEqual(r.response.ai_messages[0].message, "Why?");
});

test("keeps prose rather than losing the turn, and flags it", () => {
  const r = parseTutorResponse("Exactly right.\n```mermaid\ngraph LR\nA-->B\n```\nNext: why?");
  assert.strictEqual(r.parseOk, false);
  assert.strictEqual(r.hasMessages, true);
  assert.match(r.note, /did not return JSON/);
});

test("an empty reply is never renderable", () => {
  for (const raw of ["", "   ", null, undefined]) {
    const r = parseTutorResponse(raw);
    assert.strictEqual(r.hasMessages, false, `empty reply ${JSON.stringify(raw)}`);
    assert.strictEqual(r.response.ai_messages.length, 0);
  }
});

test("always returns the six top-level keys the app reads", () => {
  const r = parseTutorResponse("not json at all");
  for (const k of [
    "ai_messages",
    "feedback",
    "user_correction",
    "goals_update",
    "session_summary",
    "evaluation",
  ]) {
    assert.ok(k in r.response, `missing key: ${k}`);
  }
  assert.ok(Array.isArray(r.response.goals_update));
});

test("passes through the phase blocks the prompt emits", () => {
  const r = parseTutorResponse(
    turn({
      ai_messages: [{ message: "Why?" }],
      exam_definition: { term: "Friction", render_as: "link_pill" },
      text_diagram: { title: "Forces", code: "A\n+-- B" },
    })
  );
  assert.strictEqual(r.response.exam_definition.term, "Friction");
  assert.strictEqual(r.response.text_diagram.title, "Forces");
});
