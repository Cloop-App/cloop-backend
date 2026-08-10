/**
 * Pure tutoring engine — no database, no I/O.
 *
 * Given the chat history (with reconstruction metadata), the topic, its goals
 * and the student's new message, this computes:
 *   - the grade of the previous answer (Stage 1 LLM, grounded in curriculum),
 *   - the next step (deterministic state machine),
 *   - the rendered turn + visual aids (Stage 2 LLM),
 *   - the ordered list of AI rows to persist (with metadata), and
 *   - the rich response object the client renders.
 *
 * Keeping this free of Prisma is what makes the full conversation flow unit
 * testable with mock LLMs (see test/tutor_simulation.js). services/topic_chat.js
 * is a thin adapter that just writes these rows to the database.
 */

const { gradeAnswer } = require("./answer_grader");
const { generateTutorTurn } = require("./tutor_turn");
const {
  reconstructState,
  applyTransition,
  resolveCheckin,
  isMoveOn,
  firstStep,
} = require("./session_state");
const { routeGrader, routeTutor } = require("./model_router");
const { buildWordDiff } = require("./correction_builder");

const GRADE_BAND = "Grades 6-10 (CBSE / ICSE / State board)";

function emojiFor(grade) {
  if (!grade || grade.is_correct === null) return "🙂";
  if (grade.is_no_attempt) return "😓";
  if (grade.is_correct) return "😊";
  if (grade.score_percent >= 55) return "😕";
  return "😔";
}

function buildEvaluation(grade, step) {
  const gradedPhase = step.gradedPhase;
  return {
    question_mode: gradedPhase || step.nextPhase,
    concept_clarity_score:
      gradedPhase === "concept" && grade ? grade.concept_clarity_score : null,
    understanding_status: step.understanding,
    next_step_type: step.nextStepType,
    technique: step.technique || null,
  };
}

/**
 * Run one tutoring turn.
 *
 * @param {object} args
 * @param {Array} args.history       chat messages (chronological, with metadata)
 * @param {object} args.topic        { title, content }
 * @param {Array}  args.goals        [{ id, title, description }]
 * @param {string} args.userMessage
 * @param {string} [args.studentName]
 * @param {string} [args.language]
 * @param {object} [deps]            { grade, tutor } injectable LLM callers
 * @returns {Promise<{ grade, step, aiRows, response, sessionComplete, finalPrediction }>}
 */
async function runTutorTurn(args, deps = {}) {
  const { history, topic, goals, userMessage, studentName, language } = args;
  if (!goals.length) throw new Error("Topic has no learning goals");

  const state = reconstructState(history, goals);

  let grade = null;
  let step;
  const gradedGoalIndex = state.goalIndex;

  if (state.lastTurnWasCheckin) {
    // The previous turn was a struggle check-in — this message is a CHOICE
    // ("practice"/"move on"), NOT an academic answer, so we never grade it.
    step = resolveCheckin(state, isMoveOn(userMessage));
  } else if (!state.started || !state.lastQuestion) {
    step = firstStep(state);
  } else {
    grade = await gradeAnswer(
      {
        answer: userMessage,
        question: state.lastQuestion,
        phase: state.phase,
        topic,
        goal: goals[state.goalIndex],
        gradeBand: GRADE_BAND,
        cache: deps.cache || null, // correction cache (optional)
        model: routeGrader({ phase: state.phase }), // tiered model
      },
      deps.grade
    );
    step = applyTransition(state, grade);
  }

  const turn = await generateTutorTurn(
    {
      topic,
      grade,
      step,
      askedQuestions: state.askedQuestions,
      studentName: studentName || "Student",
      language: language || null,
      model: routeTutor(step, grade), // cheap for routine, better for teaching
    },
    deps.tutor
  );

  // ── Assemble the ordered AI rows to persist ──
  const gradeForPersist = grade
    ? {
        is_correct: grade.is_correct,
        concept_clarity_score: grade.concept_clarity_score,
        score_percent: grade.score_percent,
        error_type: grade.error_type,
        gradedPhase: step.gradedPhase,
        gradedGoalIndex,
      }
    : null;

  const aiRows = [];

  // Correction row.
  let userCorrection = null;
  if (grade) {
    // For a WRONG answer with a known correct term, build the strikethrough
    // correction deterministically (student's wrong word(s) → correct word(s)),
    // so it renders cleanly like the app's CORRECTIONS card and never garbles.
    // For a correct-but-typo'd answer, keep the grader's spelling diff.
    let diffHtml = grade.diff_html;
    if (!grade.is_correct && !grade.is_no_attempt && grade.correct_term) {
      const built = buildWordDiff(userMessage, grade.correct_term);
      if (built) diffHtml = built;
    }
    userCorrection = {
      message_type: "user_correction",
      diff_html: diffHtml,
      complete_answer: grade.complete_answer,
      emoji: emojiFor(grade),
      feedback: {
        is_correct: grade.is_correct,
        bubble_color: grade.is_correct ? "green" : "red",
        error_type: grade.error_type === "None" ? null : grade.error_type,
        score_percent: grade.score_percent,
      },
    };
    aiRows.push({
      message: diffHtml || grade.complete_answer || "",
      message_type: "user_correction",
      feedback_is_correct: grade.is_correct,
      feedback_bubble_color: grade.is_correct ? "green" : "red",
      diff_html: diffHtml || null,
      metadata: { kind: "correction", ...userCorrection },
    });
  }

  // Split bubbles into feedback vs. the trailing question.
  const allBubbles = turn.messages;
  const questionText = turn.next_question;
  let feedbackBubbles = allBubbles;
  let questionBubble = null;
  if (
    questionText &&
    allBubbles.length &&
    allBubbles[allBubbles.length - 1].message === questionText
  ) {
    feedbackBubbles = allBubbles.slice(0, -1);
    questionBubble = allBubbles[allBubbles.length - 1];
  }

  for (const b of feedbackBubbles) {
    aiRows.push({ message: b.message, message_type: b.message_type || "text" });
  }

  if (step.scorePrediction) {
    aiRows.push({
      message: `Predicted score for "${step.scorePrediction.goal_title}": ${step.scorePrediction.predicted_score}%`,
      message_type: "score_prediction",
      metadata: { kind: "score_prediction", ...step.scorePrediction },
    });
  }

  if (turn.mermaid_diagram) {
    aiRows.push({
      message: turn.mermaid_diagram.title || "Diagram",
      message_type: "mermaid_diagram",
      metadata: { kind: "mermaid_diagram", ...turn.mermaid_diagram },
    });
  }
  if (turn.text_diagram) {
    aiRows.push({
      message: turn.text_diagram.title || "Diagram",
      message_type: "text_diagram",
      metadata: { kind: "text_diagram", ...turn.text_diagram },
    });
  }
  if (turn.youtube_video) {
    aiRows.push({
      message: turn.youtube_video.title || "Watch this",
      message_type: "youtube_video",
      metadata: { kind: "youtube_video", ...turn.youtube_video },
    });
  }
  if (turn.google_image) {
    aiRows.push({
      message: turn.google_image.title || "See this",
      message_type: "google_image",
      metadata: { kind: "google_image", ...turn.google_image },
    });
  }
  if (turn.internet_link) {
    aiRows.push({
      message: turn.internet_link.title || "Further reading",
      message_type: "internet_link",
      metadata: { kind: "internet_link", ...turn.internet_link },
    });
  }

  // On a struggle check-in there is no next question — the last bubble is the
  // choice prompt; record it as the "question" so it is not repeated and so the
  // next turn knows to treat the reply as a choice.
  const checkinText =
    step.checkin && turn.messages.length
      ? turn.messages[turn.messages.length - 1].message
      : null;

  const turnMetadata = {
    kind: "turn",
    question: questionText || checkinText || null,
    phase: step.nextPhase,
    goalIndex: step.goalIndex,
    technique: step.technique || null,
    grade: gradeForPersist,
  };
  if (step.checkin) turnMetadata.checkin = true;

  if (questionBubble) {
    aiRows.push({
      message: questionBubble.message,
      message_type: "text",
      metadata: turnMetadata,
    });
  } else if (aiRows.length) {
    // Session-complete or check-in turn: stamp metadata on the last row.
    aiRows[aiRows.length - 1].metadata = {
      ...(aiRows[aiRows.length - 1].metadata || {}),
      ...turnMetadata,
    };
  }

  // ── Rich response ──
  const response = {
    evaluation: buildEvaluation(grade, step),
    messages: turn.messages,
    user_correction: userCorrection,
  };
  if (turn.mermaid_diagram) response.mermaid_diagram = turn.mermaid_diagram;
  if (turn.text_diagram) response.text_diagram = turn.text_diagram;
  if (turn.youtube_video) response.youtube_video = turn.youtube_video;
  if (turn.google_image) response.google_image = turn.google_image;
  if (turn.internet_link) response.internet_link = turn.internet_link;
  if (step.checkin && step.options) response.options = step.options;
  if (step.scorePrediction) response.score_prediction = step.scorePrediction;

  return {
    grade,
    step,
    aiRows,
    response,
    sessionComplete: !!step.sessionComplete,
    finalPrediction: step.sessionComplete ? step.scorePrediction : null,
  };
}

module.exports = { runTutorTurn, GRADE_BAND, emojiFor, buildEvaluation };
