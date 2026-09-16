/**
 * Cloop Mastery Engine v8
 * -------------------------------------------------------------------------
 * Deterministic, transparent, debuggable mastery scoring.
 *
 * v8 change: the mastery state is now the 7-stage model defined in the
 * Cloop_Academic_Knowledge_Graph v8 workbook (Cloop_Mastery_Engine_v1):
 *
 *   identification · explanation · representation · application
 *   · error_diagnosis · transfer · stability
 *
 *   overall = sum(stage_score × weight)   (weights sum to 1.0)
 *   mastered iff overall >= 0.80 AND no critical prerequisite unresolved
 *
 * The stage set, weights, bands, threshold and error taxonomy come from
 * ./cloop-config-v8 (vendored from the workbook). The evidence-weighted update
 * mechanics (learning rate, evidence weight, separate uncertainty, retention
 * projection, hint/repetition discounts, prerequisite attribution, immutable
 * events) are retained from the Mastery Engine spec and applied per stage.
 *
 * Pure module: no I/O, no DB, no network — so scoring stays replayable.
 * Persistence lives in ./mastery-store.js.
 */

const cfg = require("./cloop-config-v8");

const MODEL_VERSION = "mastery-v8";

// v8 mastery stages, in workbook order.
const DIMENSIONS = cfg.STAGES;
// overall = sum(stage × weight)
const OVERALL_WEIGHTS = cfg.WEIGHTS;
// v8 mastery bands (4 levels) + 0.80 threshold + prerequisite gate.
const BANDS = cfg.BANDS;
const MASTERY_THRESHOLD = cfg.MASTERY_THRESHOLD;

// §11 base mastery update learning rate (calibrate against real data).
const DEFAULT_ALPHA = 0.15;

// Task strength / difficulty priors (replace with calibrated item data).
const TASK_STRENGTH = {
  basic_recall: 0.35,
  understanding: 0.5,
  familiar_application: 0.65,
  multi_step_application: 0.75,
  analysis: 0.85,
  transfer: 0.95,
};

// Hint / assistance discount (independence multiplier from help level).
const HINT_DISCOUNT = {
  none: 1.0,
  minor: 0.85,
  multiple: 0.65,
  worked_step: 0.45,
  answer_revealed: 0.2,
};

// ─── small helpers ───────────────────────────────────────────────
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
function clamp01(x) {
  return clamp(x, 0, 1);
}

/** overall (operational) mastery as a weighted sum of v8 stages. */
function weightedMastery(dims) {
  let m = 0;
  for (const d of DIMENSIONS) m += OVERALL_WEIGHTS[d] * (dims[d] ?? 0);
  return clamp01(m);
}

/**
 * v8 band + mastery gate for an overall score.
 * @param {number} overall
 * @param {object} [opts] { prerequisiteGateOpen }
 */
function masteryBand(overall, opts = {}) {
  const level = cfg.bandFor(overall);
  return {
    band: level,
    mastered: cfg.isMastered(clamp01(overall), Boolean(opts.prerequisiteGateOpen)),
  };
}

/**
 * Correctness signal (C). Maps a qualitative outcome to the target the mastery
 * stage moves toward. Returns null for UNKNOWN (no update).
 */
function correctnessSignal(outcome, partialCredit) {
  switch (outcome) {
    case "correct":
      return 1.0;
    case "partial":
      return clamp(partialCredit ?? 0.6, 0.4, 0.85);
    case "incorrect_valid_method":
      return partialCredit != null ? clamp(partialCredit, 0.2, 0.45) : 0.3;
    case "incorrect_conceptual":
      return partialCredit != null ? clamp(partialCredit, 0.0, 0.2) : 0.05;
    case "unknown":
      return null;
    default:
      throw new Error(`Unknown correctness outcome: ${outcome}`);
  }
}

/** Repetition discount — independence from recent similar items. */
function independenceFactor(nSimilar = 0) {
  return Math.max(0.35, 1 - 0.12 * nSimilar);
}

/** Hint discount multiplier. */
function hintDiscount(level = "none") {
  return HINT_DISCOUNT[level] ?? 1.0;
}

/**
 * Evidence weight:
 *   W = 0.30 + 0.20D + 0.15K + 0.15S + 0.10I + 0.10V, clamped to [0.20, 1.00]
 * D=difficulty, K=concept relevance, S=task strength, I=independence,
 * V=evaluator reliability. S defaults to D when not supplied.
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

/** Base stage update: value += alpha * W * (E - value), clamped to [0,1]. */
function updateDimensionValue(oldValue, E, W, alpha = DEFAULT_ALPHA) {
  return clamp01(oldValue + alpha * W * (E - oldValue));
}

/** Uncertainty update: sigma = clamp(sigma*0.92 + 0.08*novelty, 0.05, 0.50). */
function updateUncertainty(sigmaOld, evidenceNovelty) {
  const novelty = clamp01(evidenceNovelty ?? 0.5);
  return clamp(sigmaOld * 0.92 + 0.08 * novelty, 0.05, 0.5);
}

/** Retention/forgetting projection: R_t = R_0 * exp(-lambda * dt). */
function projectRetention(r0, elapsedDays, lambda = 0.05) {
  return clamp01(r0 * Math.exp(-lambda * Math.max(0, elapsedDays)));
}

/** Overconfidence signal: O = max(0, confidence - correctness). Diagnostic only. */
function overconfidence(studentConfidence, correctness) {
  if (studentConfidence == null || correctness == null) return 0;
  return Math.max(0, studentConfidence - correctness);
}

/**
 * Prerequisite propagation — limit a downstream penalty when the cause is
 * attributable upstream:  downstream_penalty = base_penalty * (1 - attribution).
 * Only dampens negative (penalty) moves; positive evidence is unaffected.
 */
function attributeUpstream(E, oldValue, prerequisiteAttribution = 0) {
  const a = clamp01(prerequisiteAttribution);
  if (E >= oldValue) return E;
  return oldValue + (E - oldValue) * (1 - a);
}

/**
 * Which v8 stage(s) this evidence should move.
 *  - On an error: the tag→stage routing from the v8 taxonomy.
 *  - On correct evidence: reward the stages the task actually exercised.
 * Accepts either a v8 error tag (ERR-CON-01) or a legacy family name.
 */
function affectedDimensions(evidence) {
  const tag = normaliseErrorTag(evidence.errorType);
  if (tag && cfg.ERROR_STAGE_ROUTING[tag]) {
    const mapped = cfg.ERROR_STAGE_ROUTING[tag];
    if (mapped.length) return mapped;
    return []; // e.g. prerequisite gap → route upstream, no downstream stage
  }
  if (evidence.taskType && TASK_STRENGTH[evidence.taskType] != null) {
    if (evidence.taskType === "transfer") return ["transfer", "explanation", "application"];
    if (evidence.taskType === "analysis") return ["application", "error_diagnosis"];
    if (evidence.taskType === "basic_recall") return ["identification"];
    return ["application", "explanation"];
  }
  return ["application", "explanation"];
}

// Accept v8 tags directly; map a few legacy/aliased names to v8 tags so older
// callers and the seed dataset keep working.
const LEGACY_ERROR_ALIASES = {
  conceptual: "ERR-CON-01",
  misconception: "ERR-CON-01",
  prerequisite_gap: "ERR-PREREQ-01",
  procedural: "ERR-PROC-01",
  algebraic: "ERR-PROC-01",
  representation: "ERR-REP-01",
  diagram: "ERR-REP-01",
  calculation: "ERR-CALC-01",
  sign: "ERR-CALC-01",
  vector: "ERR-REP-01",
  interpretation: "ERR-READ-01",
  transfer: "ERR-TRANSFER-01",
  careless: "ERR-CARELESS-01",
  recall: "ERR-CON-01",
};
function normaliseErrorTag(errorType) {
  if (!errorType) return null;
  if (cfg.ERROR_STAGE_ROUTING[errorType]) return errorType; // already a v8 tag
  return LEGACY_ERROR_ALIASES[errorType] || null;
}

/**
 * Top-level update. Consumes current mastery state + one piece of structured
 * evidence; returns { state, event }. `state` is the materialised mastery,
 * `event` is the immutable audit record to persist.
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

  const tag = normaliseErrorTag(evidence.errorType);
  const gentle = tag && cfg.GENTLE_ERROR_TAGS.has(tag);

  const independence = clamp01(
    independenceFactor(evidence.nSimilar ?? 0) * hintDiscount(evidence.hintLevel ?? "none")
  );

  let W = evidenceWeight({
    difficulty: evidence.difficulty ?? (evidence.taskType ? TASK_STRENGTH[evidence.taskType] : 0.5),
    conceptRelevance: evidence.conceptRelevance ?? 1,
    taskStrength: evidence.taskStrength ?? (evidence.taskType ? TASK_STRENGTH[evidence.taskType] : undefined),
    independence,
    evaluatorReliability: evidence.evaluatorReliability ?? 1,
  });
  // Gentle errors (calculation/careless slips) move mastery less — do not let a
  // transient execution slip collapse conceptual stages.
  if (gentle) W *= 0.5;

  const targetDims = affectedDimensions(evidence);
  const dimensionUpdates = {};
  for (const d of targetDims) {
    const oldVal = dims[d];
    const target = attributeUpstream(E, oldVal, evidence.prerequisiteAttribution ?? 0);
    const newVal = updateDimensionValue(oldVal, target, W, alpha);
    dimensionUpdates[d] = +(newVal - oldVal).toFixed(6);
    dims[d] = newVal;
  }

  const overall = weightedMastery(dims);
  const uncertainty = updateUncertainty(before.uncertainty, evidence.evidenceNovelty ?? independence);

  const newState = {
    ...state,
    dimensions: dims,
    overall_mastery: overall,
    uncertainty,
    evidence_count: (state.evidence_count ?? 0) + 1,
    last_assessed_at: evidence.timestamp ?? new Date().toISOString(),
    band: masteryBand(overall, { prerequisiteGateOpen: evidence.prerequisiteGateOpen }),
    model_version: MODEL_VERSION,
  };

  const event = {
    mastery_event_id: null,
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
      error_tag: tag,
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
 * Build the structured state packet handed to the SLM. The SLM generates
 * dialogue; it must not infer or overwrite mastery.
 */
function buildSlmStatePacket(state, context = {}) {
  const dims = state.dimensions || {};
  const weak = DIMENSIONS.filter((d) => (dims[d] ?? 0) < 0.5).sort(
    (a, b) => (dims[a] ?? 0) - (dims[b] ?? 0)
  );
  return {
    target_concept: state.concept_id ?? null,
    mastery_overall: state.overall_mastery ?? weightedMastery(dims),
    mastery_band: masteryBand(state.overall_mastery ?? weightedMastery(dims)).band,
    weak_dimensions: weak.slice(0, 3),
    uncertainty: state.uncertainty ?? null,
    suspected_misconception: context.suspectedMisconception ?? null,
    confidence: context.confidence ?? null,
    prerequisite_gap: context.prerequisiteGap ?? null,
    selected_action: context.selectedAction ?? null,
    difficulty_target: context.difficultyTarget ?? null,
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
  BANDS,
  MASTERY_THRESHOLD,
  DEFAULT_ALPHA,
  TASK_STRENGTH,
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
  normaliseErrorTag,
  updateMastery,
  buildSlmStatePacket,
};
