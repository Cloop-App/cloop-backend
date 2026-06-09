/**
 * Mock LLM callers for the tutoring engine tests.
 *
 * These let us exercise the REAL engine (grading normalisation, deterministic
 * state machine, turn normalisation, media gating) without any network calls,
 * so the full conversation flow is verifiable offline and reproducibly.
 */

/**
 * Mock grader. Reads the scripted tag embedded in the student's answer and
 * returns a curriculum-style grade JSON. Tags:
 *   [correct] -> full marks   [partial] -> half   [wrong] -> mostly wrong
 *   [typo]    -> correct but with a spelling slip (exercises diff_html)
 * No-attempts ("idk" etc.) are caught by the grader's own fast-path before
 * this mock is ever called.
 */
function mockGrader(messages /*, opts */) {
  const userMsg = messages.find((m) => m.role === "user")?.content || "";
  const answer = (userMsg.match(/STUDENT ANSWER:\s*"([\s\S]*)"/) || [])[1] || userMsg;

  let g;
  if (/\[correct\]/i.test(answer)) {
    g = { correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 100, error_type: "None", is_correct: true };
  } else if (/\[typo\]/i.test(answer)) {
    g = {
      correctness: 1, reasoning_quality: 1, completeness: 1, score_percent: 90,
      error_type: "Spelling Error", is_correct: true,
      diff_html: "coal is a non <del>renewble</del><ins>renewable</ins> source of energy",
    };
  } else if (/\[partial\]/i.test(answer)) {
    g = { correctness: 0.5, reasoning_quality: 0.5, completeness: 0.5, score_percent: 60, error_type: "Partially Correct", is_correct: false };
  } else {
    g = {
      correctness: 0, reasoning_quality: 0, completeness: 0, score_percent: 25,
      error_type: "Conceptual Error", is_correct: false,
      misconception_guess: "confuses renewable with recyclable",
    };
  }
  g.is_no_attempt = false;
  g.concept_clarity_score =
    Math.round(((g.correctness + g.reasoning_quality + g.completeness) / 3) * 100) / 100;
  g.complete_answer = "Sustainable development meets present needs without harming future generations.";
  return Promise.resolve(JSON.stringify(g));
}

/**
 * Mock tutor. Emits a unique question each call (so repeat-avoidance is real),
 * a short feedback bubble, and ALWAYS attaches a diagram + a video. The engine
 * is responsible for stripping media when the step doesn't allow it — that
 * gating is exactly what the tests check.
 */
function makeMockTutor() {
  let n = 0;
  return function mockTutor(/* messages, opts */) {
    n++;
    const payload = {
      messages: [{ message: `Here is some feedback for turn ${n}.`, message_type: "text" }],
      next_question: `Auto-generated unique question number ${n}?`,
      technique: "Contrast",
      mermaid_diagram: {
        title: "Energy sources",
        code: "graph TD\\n  A[Energy] --> B[Renewable]\\n  A --> C[Non-Renewable]",
        trigger: "teaching",
      },
      youtube_video: {
        search_query: "sustainable development explained for students",
        title: "Watch: Sustainable Development",
        trigger: "teaching",
      },
      internet_link: {
        search_query: "sustainable development class 8 notes",
        title: "Further reading: Sustainable Development",
        trigger: "extension",
      },
    };
    return Promise.resolve(JSON.stringify(payload));
  };
}

module.exports = { mockGrader, makeMockTutor };
