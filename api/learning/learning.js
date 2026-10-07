/**
 * Learning Intelligence API
 * -------------------------------------------------------------------------
 * Wires the deterministic learning pipeline + mastery engine into the Express
 * app, following the Pipeline spec §20 API contract. The SLM is invoked only
 * as the final, optional dialogue stage; the structured decision is produced
 * and persisted regardless.
 *
 *   POST /api/learning/interactions      ingest a response → diagnose + update
 *   POST /api/learning/adaptive/next-action   candidate actions for a concept
 *   GET  /api/learning/mastery           current mastery by concept
 *   POST /api/learning/training/examples persist a candidate training example
 *
 * Academic records are keyed by a pseudonymous `student_key` (spec §14). We
 * derive it deterministically from the authenticated user id so identity and
 * academic behaviour stay logically separable while still being linkable by an
 * authorised service.
 */

const { Router } = require("express");
const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");
const { runPipeline } = require("../../services/pipeline/learning-pipeline");
const { planAction } = require("../../services/pipeline/learning-pipeline");
const { loadState, saveStateAndEvent, listStates } = require("../../services/mastery/mastery-store");
const { slmResponderFor } = require("../../services/slm/cloop-slm");

const router = Router();
router.use(authenticateToken);

/** Deterministic pseudonymous key for academic records (spec §14). */
function studentKeyFor(userId) {
  const salt = process.env.STUDENT_KEY_SALT || "cloop-academic";
  return "stu_" + crypto.createHash("sha256").update(`${salt}:${userId}`).digest("hex").slice(0, 24);
}

/**
 * POST /api/learning/interactions
 * Body: {
 *   question_code?, concept_evidence?: [{concept_id, weight}],
 *   correctness: bool|"partial"|"unknown", student_response?, student_reasoning?,
 *   student_confidence?, time_taken_seconds?,
 *   error_signals?, misconception_factors?, prerequisites?, gap?,
 *   with_dialogue?: bool
 * }
 * Runs the pipeline, persists the interaction + mastery event + materialised
 * state, and returns the §21 output object.
 */
router.post("/interactions", async (req, res) => {
  try {
    const studentKey = studentKeyFor(req.user.user_id);
    const body = req.body || {};

    const conceptEvidence = Array.isArray(body.concept_evidence) ? body.concept_evidence : [];
    const primaryConcept = conceptEvidence[0]?.concept_id || body.concept_code || null;
    if (!primaryConcept) {
      return res.status(400).json({ error: "A concept (concept_evidence or concept_code) is required." });
    }

    // Stage G reads the current authoritative state from the DB.
    const masteryState = await loadState(studentKey, primaryConcept);

    const input = {
      interactionId: undefined,
      studentId: studentKey,
      evaluation: {
        correctness: body.correctness,
        confidence: body.evaluator_confidence ?? 0.9,
        studentConfidence: body.student_confidence,
      },
      conceptEvidence: conceptEvidence.length
        ? conceptEvidence
        : [{ concept_id: primaryConcept, weight: 1 }],
      masteryState,
      errorSignals: body.error_signals || {},
      misconceptionFactors: body.misconception_factors || {},
      prerequisites: body.prerequisites || [],
      gap: body.gap || {},
      planningContext: body.planning_context || {},
    };

    // Optional dialogue stage — only when explicitly requested.
    const deps = {};
    if (body.with_dialogue) {
      deps.slmResponder = slmResponderFor({
        subject: body.subject,
        gradeLevel: body.grade_level,
        studentMessage: body.student_response,
        questionText: body.question_text,
        correctAnswer: body.correct_answer,
      });
    }

    const out = await runPipeline(input, deps);

    // Persist the interaction row.
    const interaction = await prisma.learningInteraction.create({
      data: {
        student_key: studentKey,
        session_id: body.session_id ?? null,
        question_code: body.question_code ?? null,
        concept_code: primaryConcept,
        student_response: body.student_response ?? null,
        student_reasoning: body.student_reasoning ?? null,
        correctness: typeof body.correctness === "boolean"
          ? body.correctness ? "correct" : "incorrect"
          : String(body.correctness ?? "unknown"),
        time_taken_seconds: body.time_taken_seconds ?? null,
        student_confidence: body.student_confidence ?? null,
        error_labels: out.errors ?? undefined,
        misconception_candidates: out.misconceptions ?? undefined,
        pipeline_output: stripInternal(out),
      },
    });

    // Persist mastery (materialised state + immutable event).
    if (out._mastery_state) {
      const event = out._mastery_event
        ? { ...out._mastery_event, interaction_id: interaction.interaction_id }
        : null;
      await saveStateAndEvent(studentKey, primaryConcept, out._mastery_state, event);
    }

    return res.json({ interaction_id: interaction.interaction_id, ...stripInternal(out) });
  } catch (err) {
    console.error("POST /learning/interactions error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/learning/adaptive/next-action
 * Body: { concept_code, prerequisites?, gap?, planning_context? }
 * Returns candidate actions + the selected action for the student's CURRENT
 * state, without recording a new interaction.
 */
router.post("/adaptive/next-action", async (req, res) => {
  try {
    const studentKey = studentKeyFor(req.user.user_id);
    const conceptCode = req.body?.concept_code;
    if (!conceptCode) return res.status(400).json({ error: "concept_code is required." });

    const state = await loadState(studentKey, conceptCode);
    const overall = state.overall_mastery ?? undefined;

    const plan = planAction({
      mastery: overall,
      uncertainty: state.uncertainty,
      correct: null,
      prerequisite: req.body?.prerequisite || {},
      examRelevance: req.body?.gap?.examRelevance,
      ...(req.body?.planning_context || {}),
    });

    return res.json({
      concept_code: conceptCode,
      mastery_overall: overall ?? null,
      selected_action: plan.selected?.type ?? null,
      reason: plan.selected?.reason ?? null,
      candidates: plan.candidates,
    });
  } catch (err) {
    console.error("POST /learning/adaptive/next-action error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/learning/mastery
 * Returns the authenticated student's mastery states (weakest first).
 */
router.get("/mastery", async (req, res) => {
  try {
    const studentKey = studentKeyFor(req.user.user_id);
    const states = await listStates(studentKey);
    return res.json({ mastery: states });
  } catch (err) {
    console.error("GET /learning/mastery error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/learning/training/examples
 * Persist a de-identified candidate training example (spec §21 / DB §11).
 */
router.post("/training/examples", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.task_type || !b.input_context) {
      return res.status(400).json({ error: "task_type and input_context are required." });
    }
    const created = await prisma.trainingExample.create({
      data: {
        task_type: b.task_type,
        input_context: b.input_context,
        student_state: b.student_state ?? undefined,
        academic_context: b.academic_context ?? undefined,
        expected_reasoning: b.expected_reasoning ?? undefined,
        expected_output: b.expected_output ?? undefined,
        labels: b.labels ?? undefined,
        quality_score: b.quality_score ?? null,
        annotation_status: b.annotation_status || "SYNTHETIC",
        split: b.split || "TRAIN",
        source_interaction_ids: b.source_interaction_ids ?? undefined,
      },
    });
    return res.status(201).json({ training_example_id: created.training_example_id });
  } catch (err) {
    console.error("POST /learning/training/examples error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// Drop internal (underscore-prefixed) keys before returning/persisting output.
function stripInternal(out) {
  const clean = {};
  for (const [k, v] of Object.entries(out)) {
    if (!k.startsWith("_")) clean[k] = v;
  }
  return clean;
}

module.exports = router;
