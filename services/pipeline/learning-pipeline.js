/**
 * Cloop Learning Intelligence Pipeline v1.0
 * -------------------------------------------------------------------------
 * Implements the deterministic core of the Cloop learning loop described in
 * "Cloop Learning Intelligence Pipeline v1.0":
 *
 *   STUDENT INPUT → CORRECTNESS → ERROR DETECTION → MISCONCEPTION HYPOTHESES
 *     → PREREQUISITE CHECK → MASTERY UPDATE → GAP PRIORITISATION
 *     → ACTION GENERATION → ACTION SELECTION → (SLM RESPONSE)
 *
 * Architectural rule (from every doc in the set): the SLM is a reasoning /
 * communication component, NOT the source of academic truth. Everything in
 * this module is deterministic and auditable; the SLM is a single, optional,
 * injected stage (`slmResponder`) that turns the structured decision into
 * dialogue. If no responder is injected, the pipeline still produces a
 * complete, machine-readable decision.
 *
 * Pure and I/O-free except for the injected SLM call, so the whole loop can
 * be replayed as a regression test against a seed dataset.
 */

const {
  updateMastery,
  buildSlmStatePacket,
  weightedMastery,
  masteryBand,
} = require("../mastery/mastery-engine");

// ─── Stage D — Error detection (rule-based v1 baseline) ──────────
// Maps observable evidence to an error category. This is the transparent
// baseline the spec asks for before any learned classifier; the SLM may
// later propose categories but the taxonomy here stays authoritative.
const ERROR_TAXONOMY = {
  calculation: "Correct method but arithmetic/sign/transcription slip.",
  algebraic: "Invalid transformation, expansion or simplification.",
  conceptual: "Incorrect understanding of the underlying concept.",
  diagram: "Incorrect/omitted/extra representation element.",
  vector: "Incorrect component, sign or direction.",
  interpretation: "Misread the question or conditions.",
  prerequisite_gap: "Target concept depends on a weak upstream concept.",
  insufficient_evidence: "Response too incomplete to diagnose reliably.",
};

/**
 * Stage D. Classify the observable failure. Prefers an explicit label from a
 * stronger evaluator; otherwise applies simple, inspectable rules.
 *
 * @param {object} ev normalised evidence for one interaction
 *   { correctness: "correct"|"partial"|"incorrect_valid_method"|
 *                  "incorrect_conceptual"|"unknown",
 *     explicitErrorType?, hasValidMethod?, misreadQuestion?,
 *     arithmeticOnly?, prerequisiteWeak? }
 * @returns {{ error_id: string|null, confidence: number, description: string|null }}
 */
function detectError(ev) {
  if (ev.correctness === "correct") {
    return { error_id: null, confidence: 1, description: null };
  }
  if (ev.correctness === "unknown") {
    return {
      error_id: "insufficient_evidence",
      confidence: 0.5,
      description: ERROR_TAXONOMY.insufficient_evidence,
    };
  }
  // Explicit label from a stronger evaluator wins.
  const label =
    ev.explicitErrorType && ERROR_TAXONOMY[ev.explicitErrorType]
      ? ev.explicitErrorType
      : inferErrorType(ev);
  return {
    error_id: label,
    confidence: ev.evaluatorConfidence ?? 0.7,
    description: ERROR_TAXONOMY[label] ?? null,
  };
}

function inferErrorType(ev) {
  if (ev.prerequisiteWeak) return "prerequisite_gap";
  if (ev.misreadQuestion) return "interpretation";
  if (ev.arithmeticOnly || ev.correctness === "incorrect_valid_method") return "calculation";
  if (ev.correctness === "incorrect_conceptual") return "conceptual";
  return "conceptual";
}

// ─── Stage E — Misconception inference ───────────────────────────
/**
 * Recommended confidence model (Stage E):
 *   confidence = evidence_strength × pattern_consistency × concept_alignment
 *                × history_support × evaluator_confidence
 * A single weak signal yields a *candidate*, not a permanent label. A
 * successful transfer question should later reduce this confidence.
 *
 * @param {object} f factors, each in [0,1]
 * @returns {{ candidate: boolean, confidence: number, promote: boolean }}
 */
function misconceptionConfidence(f = {}) {
  const strength = clamp01(f.evidenceStrength ?? 0.5);
  const consistency = clamp01(f.patternConsistency ?? 0.5);
  const alignment = clamp01(f.conceptAlignment ?? 0.5);
  const history = clamp01(f.historySupport ?? 0.5);
  const evaluator = clamp01(f.evaluatorConfidence ?? 0.8);
  const confidence = strength * consistency * alignment * history * evaluator;
  return {
    candidate: confidence > 0,
    confidence,
    // Only promote to a high-confidence label with repeated, aligned evidence.
    promote: confidence >= 0.7 && (f.evidenceCount ?? 1) >= 2,
  };
}

// ─── Stage F — Prerequisite diagnosis ────────────────────────────
/**
 * Decide whether an upstream prerequisite plausibly explains a failure.
 * Prioritise a prerequisite when: its mastery is low, the edge strength is
 * high, the error is compatible, and repairing it is likely to help.
 *
 * @param {object[]} prerequisites [{ concept_id, mastery, edgeStrength }]
 * @param {object} [opts] { errorCompatible?: boolean, threshold?: number }
 * @returns {{ concept_id, mastery, needs_review, attribution }|null}
 */
function prerequisiteCheck(prerequisites = [], opts = {}) {
  const threshold = opts.threshold ?? 0.55;
  const compatible = opts.errorCompatible !== false;
  const ranked = prerequisites
    .filter((p) => p.mastery != null)
    .map((p) => ({
      ...p,
      // Blame concentrates where mastery is low AND the edge is strong.
      attribution: clamp01((1 - p.mastery) * (p.edgeStrength ?? 0.5) * (compatible ? 1 : 0.3)),
    }))
    .sort((a, b) => b.attribution - a.attribution);

  const top = ranked[0];
  if (!top) return null;
  return {
    concept_id: top.concept_id,
    mastery: top.mastery,
    needs_review: top.mastery < threshold && compatible,
    attribution: top.attribution,
  };
}

// ─── Stage H — Learning-gap prioritisation ───────────────────────
/**
 *   priority = weakness × concept_importance × prerequisite_leverage
 *              × exam_relevance × evidence_confidence × expected_gain
 * (Multiplicative so a near-zero factor correctly suppresses a gap; e.g. low
 * evidence confidence should stop Cloop from overreacting.)
 *
 * @param {object} g
 * @returns {{ priority: number, factors: object }}
 */
function gapPriority(g = {}) {
  const weakness = clamp01(1 - (g.mastery ?? 0.5));
  const importance = clamp01(g.conceptImportance ?? 0.5);
  const leverage = clamp01(g.prerequisiteLeverage ?? 0.5);
  const examRelevance = clamp01(g.examRelevance ?? 0.5);
  const evidenceConfidence = clamp01(g.evidenceConfidence ?? 0.5);
  const expectedGain = clamp01(g.expectedGain ?? 0.5);
  const priority =
    weakness * importance * leverage * examRelevance * evidenceConfidence * expectedGain;
  return {
    priority,
    factors: { weakness, importance, leverage, examRelevance, evidenceConfidence, expectedGain },
  };
}

// ─── Stage I — Candidate actions + selection ─────────────────────
const ACTIONS = {
  DIAGNOSTIC_QUESTION: "Need more evidence before choosing an intervention.",
  PREREQUISITE_REMEDIATION: "Upstream concept is blocking target performance.",
  MICRO_EXPLANATION: "Student needs a concise conceptual clarification.",
  SOCRATIC_DIALOGUE: "Mental model is uncertain; probe reasoning.",
  COUNTEREXAMPLE: "False rule or misconception needs disconfirmation.",
  VISUAL_REPRESENTATION: "A diagram/graph/spatial model will improve understanding.",
  WORKED_EXAMPLE: "Student needs a model of the procedure.",
  GUIDED_PRACTICE: "Student can solve with scaffolded support.",
  INDEPENDENT_PRACTICE: "Mastery is sufficient for practice without scaffolding.",
  RETRIEVAL_PRACTICE: "Recall/retention needs strengthening.",
  TRANSFER_PROBLEM: "Test whether understanding generalises.",
  RETEST: "Verify that an intervention produced durable change.",
};

/**
 * Generate candidate adaptive actions from the current diagnosis, then score
 * each by expected utility (Stage I / "Action Selection"):
 *   utility = expected_learning_gain + diagnostic_value + prerequisite_leverage
 *             + exam_value − repetition_penalty − difficulty_penalty
 *             − uncertainty_penalty
 * The selected action carries a machine-readable reason so the decision is
 * inspectable and the SLM is easy to constrain.
 *
 * @param {object} ctx
 *   { mastery, uncertainty, prerequisite: {needs_review, attribution},
 *     misconception: {confidence}, examRelevance, nSimilar }
 * @returns {{ candidates: object[], selected: object }}
 */
function planAction(ctx = {}) {
  const mastery = clamp01(ctx.mastery ?? 0.5);
  const uncertainty = clamp01(ctx.uncertainty ?? 0.3);
  const prereqNeedsReview = ctx.prerequisite?.needs_review;
  const prereqLeverage = clamp01(ctx.prerequisite?.attribution ?? 0);
  const misConf = clamp01(ctx.misconception?.confidence ?? 0);
  const examRelevance = clamp01(ctx.examRelevance ?? 0.5);
  const repetitionPenalty = clamp01(0.1 * (ctx.nSimilar ?? 0));

  // "One response is not enough to establish a stable misconception." Until a
  // diagnosis is confirmed (promoted, or backed by ≥2 pieces of evidence), the
  // engine should prefer probing over committing to an intervention — unless a
  // prerequisite is very strongly implicated.
  const confirmed = Boolean(ctx.misconceptionPromoted) || (ctx.evidenceCount ?? 1) >= 2;

  /** @type {Array<{type:string, utility:number, reason:string}>} */
  const candidates = [];
  const add = (type, utility, reason) =>
    candidates.push({ type, utility: +utility.toFixed(4), reason, use_when: ACTIONS[type] });

  // Diagnostic question — high value when the source of error is uncertain or
  // the current diagnosis is not yet confirmed by independent evidence.
  add(
    "DIAGNOSTIC_QUESTION",
    0.2 +
      0.6 * uncertainty +
      0.2 * (misConf > 0 && misConf < 0.7 ? 1 : 0) +
      (confirmed ? 0 : 0.15) -
      repetitionPenalty,
    "Uncertain/unconfirmed diagnosis has high information value; distinguish competing causes."
  );

  // Prerequisite remediation — when upstream weakness plausibly blocks target.
  // Committing here is discounted while the diagnosis is unconfirmed and while
  // uncertainty is high (§ Action Selection: − uncertainty_penalty).
  add(
    "PREREQUISITE_REMEDIATION",
    (prereqNeedsReview ? (confirmed ? 0.5 : 0.28) : 0.1) +
      0.4 * prereqLeverage +
      0.1 * examRelevance -
      0.3 * uncertainty,
    "Repair the upstream cause rather than the downstream symptom."
  );

  // Counterexample — when a confident misconception needs disconfirmation.
  add(
    "COUNTEREXAMPLE",
    0.2 + 0.6 * misConf - 0.3 * uncertainty,
    "A confident misconception is best disconfirmed with a counterexample."
  );

  // Socratic dialogue — probe an uncertain mental model.
  add(
    "SOCRATIC_DIALOGUE",
    0.25 + 0.4 * uncertainty + 0.2 * misConf,
    "Probe the student's reasoning to expose the mental model."
  );

  // Micro-explanation — low mastery, low uncertainty (cause is clear).
  add(
    "MICRO_EXPLANATION",
    0.3 + 0.3 * (1 - mastery) - 0.4 * uncertainty,
    "Cause is clear; a concise clarification is the efficient move."
  );

  // Transfer problem — verify generalisation once mastery is decent.
  add(
    "TRANSFER_PROBLEM",
    0.2 + 0.6 * mastery - 0.3 * uncertainty + 0.1 * examRelevance,
    "Mastery looks solid; verify it generalises to a novel context."
  );

  // Retrieval practice — strengthen recall/retention.
  add(
    "RETRIEVAL_PRACTICE",
    0.15 + 0.4 * mastery,
    "Strengthen durable recall/retention with spaced retrieval."
  );

  candidates.sort((a, b) => b.utility - a.utility);
  return { candidates, selected: candidates[0] };
}

// ─── Full pipeline orchestration ─────────────────────────────────
/**
 * Run one full turn of the learning loop and return the §21 pipeline output
 * object. Optionally calls an injected SLM responder to turn the structured
 * decision into dialogue — but the decision itself is fully determined before
 * the SLM is consulted.
 *
 * @param {object} input
 *   {
 *     interactionId, studentId,
 *     evaluation: { correctness, confidence },        // Stage C (upstream)
 *     conceptEvidence: [{ concept_id, weight }],       // Stage B (upstream)
 *     masteryState,                                    // current student×concept state
 *     errorSignals,                                    // for Stage D
 *     misconceptionFactors,                            // for Stage E
 *     prerequisites,                                   // for Stage F
 *     gap,                                             // for Stage H factors
 *     planningContext,                                 // extra Stage I context
 *   }
 * @param {object} [deps] { slmResponder?: async (packet) => object }
 * @returns {Promise<object>} full pipeline output (§21) + updated mastery/event
 */
async function runPipeline(input, deps = {}) {
  const {
    interactionId = null,
    evaluation = {},
    conceptEvidence = [],
    masteryState = { dimensions: {}, uncertainty: 0.3 },
  } = input;

  // Stage D — error detection.
  const error = detectError({
    correctness: mapCorrectness(evaluation.correctness),
    explicitErrorType: input.errorSignals?.explicitErrorType,
    evaluatorConfidence: evaluation.confidence,
    ...input.errorSignals,
  });

  // Stage E — misconception hypotheses.
  const mis = misconceptionConfidence(input.misconceptionFactors || {});

  // Stage F — prerequisite diagnosis.
  const prereq = prerequisiteCheck(input.prerequisites || [], {
    errorCompatible: error.error_id === "prerequisite_gap" || input.prerequisites?.length > 0,
  });

  // Stage G — mastery update (authoritative; SLM never writes this).
  const primaryConcept = conceptEvidence[0] || {};
  const { state: newState, event } = updateMastery(masteryState, {
    outcome: mapCorrectness(evaluation.correctness),
    partialCredit: input.errorSignals?.partialCredit,
    errorType: error.error_id === "insufficient_evidence" ? null : error.error_id,
    misconceptionId: input.misconceptionFactors?.misconceptionId,
    diagnosisConfidence: mis.confidence,
    conceptRelevance: primaryConcept.weight ?? 1,
    difficulty: input.errorSignals?.difficulty,
    taskType: input.errorSignals?.taskType,
    nSimilar: input.errorSignals?.nSimilar,
    hintLevel: input.errorSignals?.hintLevel,
    prerequisiteAttribution: prereq?.needs_review ? prereq.attribution : 0,
    studentConfidence: evaluation.studentConfidence,
    interactionId,
    timestamp: input.timestamp,
  });

  const overall = newState.overall_mastery ?? weightedMastery(newState.dimensions);

  // Stage H — learning-gap prioritisation.
  const gap = gapPriority({
    mastery: overall,
    evidenceConfidence: evaluation.confidence ?? 0.7,
    ...(input.gap || {}),
  });

  // Stage I — candidate actions + selection.
  const plan = planAction({
    mastery: overall,
    uncertainty: newState.uncertainty,
    prerequisite: prereq,
    misconception: mis,
    misconceptionPromoted: mis.promote,
    evidenceCount: input.misconceptionFactors?.evidenceCount ?? masteryState.evidence_count,
    examRelevance: input.gap?.examRelevance,
    nSimilar: input.errorSignals?.nSimilar,
    ...(input.planningContext || {}),
  });

  // §29 SLM state packet — the constrained contract handed to the model.
  const slmPacket = buildSlmStatePacket(
    { ...newState, concept_id: primaryConcept.concept_id ?? newState.concept_id },
    {
      suspectedMisconception: input.misconceptionFactors?.misconceptionId ?? null,
      confidence: mis.confidence,
      prerequisiteGap: prereq?.needs_review ? prereq.concept_id : null,
      selectedAction: plan.selected?.type,
      difficultyTarget: input.planningContext?.difficultyTarget ?? null,
    }
  );

  // Optional SLM stage — dialogue only. Failures are non-fatal: the
  // structured decision stands on its own.
  let slmResponse = null;
  if (typeof deps.slmResponder === "function") {
    try {
      slmResponse = await deps.slmResponder(slmPacket);
    } catch (err) {
      slmResponse = { error: String(err?.message || err) };
    }
  }

  // §21 full pipeline output object.
  return {
    interaction_id: interactionId,
    evaluation: {
      correctness: evaluation.correctness ?? null,
      confidence: evaluation.confidence ?? null,
    },
    concept_evidence: conceptEvidence,
    errors: error.error_id ? [{ error_id: error.error_id, confidence: error.confidence }] : [],
    misconceptions: mis.confidence
      ? [
          {
            misconception_id: input.misconceptionFactors?.misconceptionId ?? null,
            confidence: mis.confidence,
            candidate: mis.candidate,
            promote: mis.promote,
          },
        ]
      : [],
    prerequisite_check: prereq,
    mastery_update: {
      before: event ? event.before.overall : overall,
      after: overall,
      uncertainty: newState.uncertainty,
      band: masteryBand(overall).band,
    },
    learning_gap: {
      priority: gap.priority,
      factors: gap.factors,
    },
    adaptive_plan: {
      selected_action: plan.selected?.type ?? null,
      reason: plan.selected?.reason ?? null,
      candidates: plan.candidates,
      confidence: clamp01(1 - newState.uncertainty),
    },
    slm_state_packet: slmPacket,
    slm_response: slmResponse,
    // Carried through for persistence by the caller.
    _mastery_state: newState,
    _mastery_event: event,
  };
}

// ─── helpers ─────────────────────────────────────────────────────
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// Accepts either the engine's outcome vocabulary or the pipeline's
// TRUE/FALSE/PARTIAL/UNKNOWN and normalises to the engine vocabulary.
function mapCorrectness(c) {
  if (c === true || c === "correct" || c === "TRUE" || c === "true") return "correct";
  if (c === "partial" || c === "PARTIAL") return "partial";
  if (c === "unknown" || c === "UNKNOWN" || c == null) return "unknown";
  if (c === "incorrect_valid_method") return "incorrect_valid_method";
  if (c === "incorrect_conceptual") return "incorrect_conceptual";
  // Bare FALSE with no error detail → treat as conceptual (strongest signal),
  // but the error engine may refine this via explicitErrorType.
  if (c === false || c === "FALSE" || c === "false") return "incorrect_conceptual";
  return "unknown";
}

module.exports = {
  ERROR_TAXONOMY,
  ACTIONS,
  detectError,
  misconceptionConfidence,
  prerequisiteCheck,
  gapPriority,
  planAction,
  runPipeline,
  mapCorrectness,
};
