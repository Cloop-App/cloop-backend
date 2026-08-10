/**
 * Readable end-to-end trace of the academic model driving the COMPRESSED prompt's
 * ruleset. Runs a full 2-goal session with a tag-driven mock grader + mock tutor
 * and prints the key signal of every turn, hitting each behaviour:
 *   session start → confusion+media → struggle check-in → choice (not graded)
 *   → grammar diff → score prediction → grounded mis-grade caught → session-end.
 *
 *   node test/verify_trace.js
 */
const { runTutorTurn } = require("../services/tutor_engine");
const { makeMockTutor } = require("./mocks");

// Tag-driven grader simulating a grounded, temperature-0 grader.
function grader(messages) {
  const u = messages.find((m) => m.role === "user")?.content || "";
  const a = ((u.match(/STUDENT ANSWER:\s*"([\s\S]*)"/) || [])[1] || u).toLowerCase();
  const mk = (o) => Promise.resolve(JSON.stringify(o));

  if (a.includes("[typo]"))
    return mk({ is_correct: true, correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 90,
      error_type: "Spelling Error", diff_html: "the <del>enviroment</del><ins>environment</ins> is our <del>surrondings</del><ins>surroundings</ins>",
      complete_answer: "The environment is everything around us." });
  if (a.includes("[factwrong]")) // model is agreeably WRONG; the guardrail must flip it
    return mk({ is_correct: true, correctness: 0, reasoning_quality: 0, completeness: 0, score_percent: 25,
      error_type: "Conceptual Error", misconception_guess: "confuses the two", diff_html: null,
      complete_answer: "The correct fact, stated simply." });
  if (a.includes("[correct]"))
    return mk({ is_correct: true, correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 100,
      error_type: "None", diff_html: null, complete_answer: "Correct model answer." });
  // default: wrong / unclear
  return mk({ is_correct: false, correctness: 0, reasoning_quality: 0, completeness: 0, score_percent: 25,
    error_type: "Conceptual Error", misconception_guess: "mixes up the idea", diff_html: null,
    complete_answer: "The correct idea, explained simply." });
}

const topic = { title: "Environment", content: "The environment is all living and non-living things around us." };
const goals = [
  { id: 1, title: "Components of the environment", description: "living & non-living" },
  { id: 2, title: "Human impact & conservation", description: "protecting the environment" },
];

const script = [
  ["[START]", "session start"],
  ["[wrong]", "confusion 1"],
  ["[wrong]", "confusion 2"],
  ["[wrong]", "confusion 3 → check-in"],
  ["Move on", "student picks a choice"],
  ["[typo]", "correct + spelling fix"],
  ["[correct]", "exam 2 → predict G1"],
  ["[factwrong]", "confident wrong fact (G2 concept)"],
  ["[correct]", "clear → exam"],
  ["[correct]", "exam"],
  ["[correct]", "exam → predict G2 → done"],
];

const has = (r) => (r.mermaid_diagram || r.text_diagram || r.youtube_video || r.google_image || r.internet_link) ? "yes" : "—";
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

(async () => {
  const deps = { grade: grader, tutor: makeMockTutor() };
  const history = [];
  console.log(
    "\n" + pad("#", 3) + pad("student", 12) + pad("next_step", 22) +
    pad("correct", 9) + pad("clarity", 9) + pad("media", 7) + pad("extra", 26)
  );
  console.log("─".repeat(98));
  let i = 0;
  for (const [msg, note] of script) {
    const res = await runTutorTurn({ history, topic, goals, userMessage: msg, studentName: "Asha" }, deps);
    history.push({ sender: "user", message: msg, message_type: "text", metadata: null });
    for (const row of res.aiRows) history.push({ sender: "ai", ...row });

    const ev = res.response.evaluation;
    const uc = res.response.user_correction;
    const extra = [];
    if (res.response.options) extra.push("options:[" + res.response.options.join("/") + "]");
    if (uc && uc.diff_html) extra.push("diff✔");
    if (res.response.score_prediction) extra.push("pred=" + res.response.score_prediction.predicted_score + "%");
    if (res.sessionComplete) extra.push("SESSION DONE");
    console.log(
      pad(++i, 3) + pad(msg, 12) + pad(ev.next_step_type, 22) +
      pad(uc ? String(uc.feedback.is_correct) : "—", 9) +
      pad(ev.concept_clarity_score == null ? "—" : ev.concept_clarity_score, 9) +
      pad(has(res.response), 7) + pad(extra.join(" ") || note, 26)
    );
  }
  console.log("");
})();
