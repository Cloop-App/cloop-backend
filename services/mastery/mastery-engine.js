/**
 * Cloop Mastery Engine v1.0
 * -------------------------------------------------------------------------
 * A transparent, debuggable, deterministic implementation of the mastery
 * scoring specification in "Cloop Mastery Engine v1.0".
 *
 * Design intent (from the spec):
 *   - The mastery engine — NOT the SLM — is authoritative over student state.
 *   - Mastery is concept-specific and multidimensional (R/U/A/N/T/F/D).
 *   - Uncertainty is stored separately from mastery.
 *   - Every update is an auditable, immutable event.
 *
 * This module is intentionally pure (no I/O, no DB, no network). Persistence
 * of mastery_states / mastery_events is the caller's responsibility so the
 * scoring logic stays unit-testable and replayable against a seed dataset.
 *
 * All scores are constrained to [0, 1]. Uncertainty is constrained to
 * [0.05, 0.50].
 */

const MODEL_VERSION = "mastery-v1.0";

// ─── Mastery dimensions ──────────────────────────────────────────
// R U A N T F D  (Retention is keyed "retention"; "D" in the spec label).
const DIMENSIONS = [
  "recall", // R
  "understanding", // U
  "application", // A
  "analysis", // N
  "transfer", // T
  "procedural_fluency", // F
  "retention", // D
];

// §4 Overall Mastery Formula:
// M = 0.10R + 0.15U + 0.20A + 0.15N + 0.20T + 0.10F + 0.10D
// (Starting priors — must be recalibrated against real outcome data.)
const OVERALL_WEIGHTS = {
  recall: 0.1,
  understanding: 0.15,
  application: 0.2,
  analysis: 0.15,
  transfer: 0.2,
  procedural_fluency: 0.1,
  retention: 0.1,
};

// §11 Base mastery update learning rate (calibrate against real data).
const DEFAULT_ALPHA = 0.15;

// §5 Mastery Bands (operational bands, not objective claims).
const BANDS = [
  { max: 0.24, band: "Unmastered", action: "Diagnose + prerequisite scan + foundational remediation." },
  { max: 0.44, band: "Emerging", action: "Target error/misconception + guided practice." },
  { max: 0.64, band: "Developing", action: "Application practice + varied examples." },
  { max: 0.79, band: "Proficient", action: "Transfer + mixed practice + retrieval." },
  { max: 0.89, band: "Strong", action: "Advanced application + retention checks." },
  { max: 1.0, band: "Mastered", action: "Verify sustained transfer and retention." },
];

// §8 Task Strength / Difficulty priors (replace with calibrated item data).
const TASK_STRENGTH = {
  basic_recall: 0.35,
  understanding: 0.5,
  familiar_application: 0.65,
  multi_step_application: 0.75,
  analysis: 0.85,
  transfer: 0.95,
};

// §16 Hint / assistance discount (independence multiplier from help level).
const HINT_DISCOUNT = {
  none: 1.0,
  minor: 0.85,
  multiple: 0.65,
  worked_step: 0.45,
  answer_revealed: 0.2,
};

// §10 / Error Taxonomy — which mastery dimensions an error type primarily
// moves. Used to route the update to the right dimensions rather than
// crudely penalising the whole concept.
const ERROR_DIMENSION_MAP = {
  calculation: ["procedural_fluency", "application"], // F strong, small A
  algebraic: ["procedural_fluency", "application"],
  conceptual: ["understanding", "application", "analysis"],
  misconception: ["understanding", "application", "analysis"],
  diagram: ["understanding", "application", "analysis"],
  representation: ["understanding", "application", "analysis"],
  vector: ["procedural_fluency", "application", "understanding"],
  sign: ["procedural_fluency", "application"],
  interpretation: ["application", "analysis"],
  reasoning: ["analysis"],
  recall: ["recall"],
  transfer: ["transfer", "understanding"],
  prerequisite_gap: [], // route upstream; downstream penalty is limited
};

// ─── small helpers ───────────────────────────────────────────────

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function clamp01(x) {
  return clamp(x, 0, 1);
}

/**
 * §4 Overall (operational) mastery as a weighted sum of dimensions.
 * @param {Record<string, number>} dims
 * @returns {number} overall mastery in [0,1]
 */
function weightedMastery(dims) {
  let m = 0;
  for (const d of DIMENSIONS) {
    m += OVERALL_WEIGHTS[d] * (dims[d] ?? 0);
  }
  return clamp01(m);
}

/**
 * §5 Map an overall score to its operational band + default action.
 * @param {number} overall
 */
function masteryBand(overall) {
  const o = clamp01(overall);
  for (const b of BANDS) {
    if (o <= b.max) return { band: b.band, action: b.action };
  }
  return { band: BANDS[BANDS.length - 1].band, action: BANDS[BANDS.length - 1].action };
}

/**
 * §7 Correctness signal (C). Maps a qualitative outcome to the target the
 * mastery dimension moves toward. Returns null for UNKNOWN (no update).
 *
 * @param {"correct"|"partial"|"incorrect_valid_method"|"incorrect_conceptual"|"unknown"} outcome
 * @param {number} [partialCredit] required when outcome === "partial", in [0,1]
 * @returns {number|null}
 */
function correctnessSignal(outcome, partialCredit) {
  switch (outcome) {
    case "correct":
      return 1.0;
    case "partial":
      // Rubric-dependent evidence in [0.40, 0.85].
      return clamp(partialCredit ?? 0.6, 0.4, 0.85);
    case "incorrect_valid_method":
      // Often a procedural/calculation issue: [0.20, 0.45].
      return partialCredit != null ? clamp(partialCredit, 0.2, 0.45) : 0.3;
    case "incorrect_conceptual":
      // Strong negative evidence: [0.00, 0.20].
      return partialCredit != null ? clamp(partialCredit, 0.0, 0.2) : 0.05;
    case "unknown":
      return null; // No update; request diagnostic evidence.
    default:
      throw new Error(`Unknown correctness outcome: ${outcome}`);
  }
}

/**
 * §15 Repetition discount — independence factor from the number of recent
 * structurally similar items.
 *   I = max(0.35, 1 - 0.12 * n_similar)
 * @param {number} nSimilar
 */
function independenceFactor(nSimilar = 0) {
  return Math.max(0.35, 1 - 0.12 * nSimilar);
}

/**
 * §16 Hint discount multiplier.
 * @param {keyof typeof HINT_DISCOUNT} level
 */
function hintDiscount(level = "none") {
  return HINT_DISCOUNT[level] ?? 1.0;
}

/**
 * §12 Evidence weight:
 *   W = 0.30 + 0.20D + 0.15K + 0.15S + 0.10I + 0.10V, clamped to [0.20, 1.00]
 * where
 *   D = task difficulty, K = concept relevance, S = task strength,
 *   I = independence, V = evaluator reliability.
 * The spec overlaps difficulty (D) and task strength (S); when S is not
 * supplied separately it defaults to D so the two axes don't double count
 * a value the caller didn't provide.
 *
 * @param {object} e
 * @param {number} [e.difficulty=0.5]
 * @param {number} [e.conceptRelevance=1]
 * @param {number} [e.taskStrength]      defaults to difficulty
 * @param {number} [e.independence=1]
 * @param {number} [e.evaluatorReliability=1]
 * @returns {number} W in [0.20, 1.00]
 */
function evidenceWeight(e = {}) {
  const D = clamp01(e.difficulty ?? 0.5);
  const K = clamp01(e.conceptRelevance ?? 1);
  const S = clamp01(e.taskStrength ?? e.difficulty ?? 0.5);
  const I = clamp01(e.independence ?? 1);
  const V = clamp01(e.evaluatorReliability ?? 1);
  const W = 0.3 + 0.2 * D + 0.15 * K + 0.15 * S + 0.1 * I + 0.1 * V;
  return clamp(W, 0.2, 1.0);
}

/**
 * §11 Base dimension update:
 *   value_new = value_old + alpha * W * (E - value_old)
 * clamped to [0,1].
 *
 * @param {number} oldValue
 * @param {number} E   correctness signal / target (§7)
 * @param {number} W   evidence weight (§12)
 * @param {number} [alpha]
 */
function updateDimensionValue(oldValue, E, W, alpha = DEFAULT_ALPHA) {
  return clamp01(oldValue + alpha * W * (E - oldValue));
}

/**
 * §18 Uncertainty update:
 *   sigma_new = clamp(sigma_old * 0.92 + 0.08 * evidence_novelty, 0.05, 0.50)
 * evidence_novelty ~ how independent/diverse this evidence is (1 = fully
 * novel/independent, 0 = a near-duplicate of prior evidence). Novel evidence
 * does not shrink uncertainty as fast as redundant confirmation.
 *
 * @param {number} sigmaOld
 * @param {number} evidenceNovelty in [0,1]
 */
function updateUncertainty(sigmaOld, evidenceNovelty) {
  const novelty = clamp01(evidenceNovelty ?? 0.5);
  return clamp(sigmaOld * 0.92 + 0.08 * novelty, 0.05, 0.5);
}

/**
 * §20 Retention / forgetting projection: R_t = R_0 * exp(-lambda * dt).
 * Predicted decay should *trigger verification* — observed retention
 * performance carries stronger weight than this theoretical decay.
 *
 * @param {number} r0            retention (or overall) at last assessment
 * @param {number} elapsedDays   dt
 * @param {number} [lambda]      global forgetting rate (calibrate per student×concept)
 */
function projectRetention(r0, elapsedDays, lambda = 0.05) {
  return clamp01(r0 * Math.exp(-lambda * Math.max(0, elapsedDays)));
}

/**
 * §17 Overconfidence signal: O = max(0, student_confidence - correctness_signal).
 * Used diagnostically (flag), NOT as a fixed subtraction from mastery.
 */
function overconfidence(studentConfidence, correctness) {
  if (studentConfidence == null || correctness == null) return 0;
  return Math.max(0, studentConfidence - correctness);
}

/**
 * §22 Prerequisite propagation. When a downstream concept fails but the
 * cause is attributable upstream, limit the downstream penalty:
 *   downstream_penalty = base_penalty * (1 - prerequisite_attribution)
 * Returns an adjusted target that pulls the applied change toward the old
 * value in proportion to how much blame sits upstream.
 *
 * @param {number} E                    raw target (correctness signal)
 * @param {number} oldValue             current dimension value
 * @param {number} prerequisiteAttribution in [0,1]
 */
function attributeUpstream(E, oldValue, prerequisiteAttribution = 0) {
  const a = clamp01(prerequisiteAttribution);
  // Only dampen *negative* (penalty) moves; positive evidence is unaffected.
  if (E >= oldValue) return E;
  return oldValue + (E - oldValue) * (1 - a);
}

/**
 * Which dimensions this evidence should move (§10 / error taxonomy). Falls
 * back to a broad conceptual set when the error type is unknown but the
 * answer was wrong, and to application/transfer when correct.
 *
 * @param {object} evidence
 * @returns {string[]}
 */
function affectedDimensions(evidence) {
  if (evidence.errorType && ERROR_DIMENSION_MAP[evidence.errorType]) {
    const mapped = ERROR_DIMENSION_MAP[evidence.errorType];
    if (mapped.length) return mapped;
  }
  // Positive evidence: reward the capabilities the task actually exercised.
  if (evidence.taskType && TASK_STRENGTH[evidence.taskType] != null) {
    if (evidence.taskType === "transfer") return ["transfer", "understanding", "application"];
    if (evidence.taskType === "analysis") return ["analysis", "application"];
    if (evidence.taskType === "basic_recall") return ["recall"];
    return ["application", "understanding"];
  }
  return ["application", "understanding"];
}

/**
 * §28 Engine pseudocode — the top-level update.
 *
 * Consumes a current mastery state and a single piece of structured
 * evidence, returns { state, event } where `state` is the new materialised
 * mastery and `event` is the immutable audit record to persist.
 *
 * @param {object} state  current mastery for one student×concept
 *   { dimensions: {recall,understanding,...}, uncertainty, evidence_count,
 *     last_assessed_at }
 * @param {object} evidence
 *   {
 *     outcome, partialCredit,        // §7 correctness
 *     errorType, taskType,           // routing + task strength
 *     difficulty, conceptRelevance,  // §12 weight factors
 *     evaluatorReliability,
 *     nSimilar, hintLevel,           // §15/§16 independence
 *     evidenceNovelty,               // §18 uncertainty
 *     prerequisiteAttribution,       // §22
 *     studentConfidence,             // §17 (diagnostic only)
 *     interactionId, timestamp,
 *   }
 * @param {object} [opts] { alpha }
 * @returns {{ state: object, event: object|null }}
 */
function updateMastery(state, evidence, opts = {}) {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;

  const dims = { ...defaultDimensions(), ...(state.dimensions || {}) };
  const before = {
    overall: weightedMastery(dims),
    dimensions: { ...dims },
    uncertainty: state.uncertainty ?? 0.5,
  };

  const E = correctnessSignal(evidence.outcome, evidence.partialCredit);

  // §7: UNKNOWN / insufficient evidence → no mastery update, request a
  // diagnostic instead. We still return the (unchanged) state and no event.
  if (E === null) {
    return {
      state: {
        ...state,
        dimensions: dims,
        overall_mastery: before.overall,
        uncertainty: before.uncertainty,
        band: masteryBand(before.overall),
        model_version: MODEL_VERSION,
      },
      event: null,
    };
  }

  // Independence combines repetition discount (§15) and hint discount (§16).
  const independence = clamp01(
    independenceFactor(evidence.nSimilar ?? 0) * hintDiscount(evidence.hintLevel ?? "none")
  );

  const W = evidenceWeight({
    difficulty: evidence.difficulty ?? (evidence.taskType ? TASK_STRENGTH[evidence.taskType] : 0.5),
    conceptRelevance: evidence.conceptRelevance ?? 1,
    taskStrength: evidence.taskStrength ?? (evidence.taskType ? TASK_STRENGTH[evidence.taskType] : undefined),
    independence,
    evaluatorReliability: evidence.evaluatorReliability ?? 1,
  });

  const targetDims = affectedDimensions(evidence);
  const dimensionUpdates = {};
  for (const d of targetDims) {
    const oldVal = dims[d];
    // §22 limit downstream penalty when blame is upstream.
    const target = attributeUpstream(E, oldVal, evidence.prerequisiteAttribution ?? 0);
    const newVal = updateDimensionValue(oldVal, target, W, alpha);
    dimensionUpdates[d] = +(newVal - oldVal).toFixed(6);
    dims[d] = newVal;
  }

  const overall = weightedMastery(dims);

  // §18 uncertainty — novelty defaults to the independence of this evidence.
  const uncertainty = updateUncertainty(
    before.uncertainty,
    evidence.evidenceNovelty ?? independence
  );

  const newState = {
    ...state,
    dimensions: dims,
    overall_mastery: overall,
    uncertainty,
    evidence_count: (state.evidence_count ?? 0) + 1,
    last_assessed_at: evidence.timestamp ?? new Date().toISOString(),
    band: masteryBand(overall),
    model_version: MODEL_VERSION,
  };

  // §26 Immutable mastery event (materialised state derives from these).
  const event = {
    mastery_event_id: null, // assigned on persistence
    student_id: state.student_id ?? null,
    concept_id: state.concept_id ?? null,
    interaction_id: evidence.interactionId ?? null,
    model_version: MODEL_VERSION,
    before: { overall: before.overall, ...pick(before.dimensions, targetDims) },
    evidence: {
      correctness: E,
      difficulty: evidence.difficulty ?? null,
      concept_relevance: evidence.conceptRelevance ?? 1,
      independence,
      evaluator_reliability: evidence.evaluatorReliability ?? 1,
      weight: W,
    },
    dimension_updates: dimensionUpdates,
    diagnosis: {
      error_type: evidence.errorType ?? null,
      misconception_id: evidence.misconceptionId ?? null,
      confidence: evidence.diagnosisConfidence ?? null,
      overconfidence: overconfidence(evidence.studentConfidence, E),
    },
    after: { overall, uncertainty },
    reason: evidence.reason ?? null,
    timestamp: newState.last_assessed_at,
  };

  return { state: newState, event };
}

/**
 * §29 Build the structured state packet handed to the SLM. The SLM
 * generates dialogue; it must not infer or overwrite mastery. This packet is
 * the contract that keeps the model grounded.
 *
 * @param {object} state       a materialised mastery state (post-update)
 * @param {object} [context]   { suspectedMisconception, prerequisiteGap,
 *                               selectedAction, difficultyTarget, confidence }
 */
function buildSlmStatePacket(state, context = {}) {
  const dims = state.dimensions || {};
  const weak = DIMENSIONS.filter((d) => (dims[d] ?? 0) < 0.5).sort(
    (a, b) => (dims[a] ?? 0) - (dims[b] ?? 0)
  );
  return {
    target_concept: state.concept_id ?? null,
    mastery_overall: state.overall_mastery ?? weightedMastery(dims),
    weak_dimensions: weak.slice(0, 3),
    uncertainty: state.uncertainty ?? null,
    suspected_misconception: context.suspectedMisconception ?? null,
    confidence: context.confidence ?? null,
    prerequisite_gap: context.prerequisiteGap ?? null,
    selected_action: context.selectedAction ?? null,
    difficulty_target: context.difficultyTarget ?? null,
    // Hard guardrails — the mastery engine, not the SLM, owns truth/state.
    do_not_do: ["give_final_answer", "invent_unverified_content", "overwrite_mastery_state"],
  };
}

function defaultDimensions() {
  return DIMENSIONS.reduce((acc, d) => ((acc[d] = 0), acc), {});
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] != null) out[k] = obj[k];
  return out;
}

module.exports = {
  MODEL_VERSION,
  DIMENSIONS,
  OVERALL_WEIGHTS,
  DEFAULT_ALPHA,
  TASK_STRENGTH,
  // scoring primitives
  clamp,
  clamp01,
  weightedMastery,
  masteryBand,
  correctnessSignal,
  independenceFactor,
  hintDiscount,
  evidenceWeight,
  updateDimensionValue,
  updateUncertainty,
  projectRetention,
  overconfidence,
  attributeUpstream,
  affectedDimensions,
  // top-level
  updateMastery,
  buildSlmStatePacket,
};
