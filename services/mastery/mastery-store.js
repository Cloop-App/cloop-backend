/**
 * Persistence adapter for mastery state + events.
 * -------------------------------------------------------------------------
 * Bridges the pure mastery engine (which owns the math) and Postgres (which
 * owns durability + the immutable audit trail). Keeps the engine I/O-free:
 * this module is the only place mastery touches the database.
 *
 * Mastery events are append-only; the mastery_states row is the materialised
 * current view derived from them (DB Schema spec §12: "Mastery updates are
 * immutable events; current mastery is a materialized state").
 */

const prisma = require("../../lib/prisma");
const { DIMENSIONS, weightedMastery, masteryBand } = require("./mastery-engine");

// v8 engine stage key ↔ mastery_states column
const DIM_COLUMN = {
  identification: "identification_score",
  explanation: "explanation_score",
  representation: "representation_score",
  application: "application_score",
  error_diagnosis: "error_diagnosis_score",
  transfer: "transfer_score",
  stability: "stability_score",
};

/**
 * Load a mastery state as the engine's in-memory shape. Returns a fresh
 * zeroed state (high uncertainty) when none exists yet.
 */
async function loadState(studentKey, conceptCode) {
  const row = await prisma.masteryState.findUnique({
    where: { student_key_concept_code: { student_key: studentKey, concept_code: conceptCode } },
  });
  if (!row) {
    const dims = DIMENSIONS.reduce((a, d) => ((a[d] = 0), a), {});
    return {
      student_id: studentKey,
      concept_id: conceptCode,
      dimensions: dims,
      uncertainty: 0.4,
      evidence_count: 0,
    };
  }
  const dims = {};
  for (const d of DIMENSIONS) dims[d] = row[DIM_COLUMN[d]];
  return {
    student_id: studentKey,
    concept_id: conceptCode,
    dimensions: dims,
    overall_mastery: row.overall_mastery,
    uncertainty: row.uncertainty,
    evidence_count: row.evidence_count,
    last_assessed_at: row.last_assessed_at,
  };
}

/**
 * Persist a post-update engine state (upsert materialised view) and append the
 * immutable mastery event in a single transaction.
 *
 * @param {string} studentKey
 * @param {string} conceptCode
 * @param {object} state  engine state returned by updateMastery()
 * @param {object|null} event engine event returned by updateMastery()
 */
async function saveStateAndEvent(studentKey, conceptCode, state, event) {
  const dims = state.dimensions || {};
  const overall = state.overall_mastery ?? weightedMastery(dims);
  const columns = {
    identification_score: dims.identification ?? 0,
    explanation_score: dims.explanation ?? 0,
    representation_score: dims.representation ?? 0,
    application_score: dims.application ?? 0,
    error_diagnosis_score: dims.error_diagnosis ?? 0,
    transfer_score: dims.transfer ?? 0,
    stability_score: dims.stability ?? 0,
    overall_mastery: overall,
    mastery_level: masteryBand(overall).band,
    uncertainty: state.uncertainty ?? 0.4,
    evidence_count: state.evidence_count ?? 0,
    prerequisite_gate_open: Boolean(state.prerequisite_gate_open),
    last_assessed_at: state.last_assessed_at ? new Date(state.last_assessed_at) : new Date(),
    model_version: state.model_version || "mastery-v8",
  };

  const ops = [
    prisma.masteryState.upsert({
      where: { student_key_concept_code: { student_key: studentKey, concept_code: conceptCode } },
      create: { student_key: studentKey, concept_code: conceptCode, ...columns },
      update: columns,
    }),
  ];

  if (event) {
    ops.push(
      prisma.masteryEvent.create({
        data: {
          student_key: studentKey,
          concept_code: conceptCode,
          interaction_id: event.interaction_id ?? null,
          mastery_before: event.before?.overall ?? null,
          mastery_after: event.after?.overall ?? null,
          dimension_updates: event.dimension_updates ?? undefined,
          evidence: event.evidence ?? undefined,
          diagnosis: event.diagnosis ?? undefined,
          update_reason: event.reason ?? null,
          model_version: event.model_version || "mastery-v1.0",
        },
      })
    );
  }

  const [savedState] = await prisma.$transaction(ops);
  return { savedState, band: masteryBand(overall) };
}

/** Return all mastery states for a student, most-uncertain/weakest first. */
async function listStates(studentKey) {
  const rows = await prisma.masteryState.findMany({
    where: { student_key: studentKey },
    orderBy: [{ overall_mastery: "asc" }],
  });
  return rows.map((row) => {
    const dims = {};
    for (const d of DIMENSIONS) dims[d] = row[DIM_COLUMN[d]];
    return {
      concept_code: row.concept_code,
      dimensions: dims,
      overall_mastery: row.overall_mastery,
      uncertainty: row.uncertainty,
      evidence_count: row.evidence_count,
      band: masteryBand(row.overall_mastery).band,
      last_assessed_at: row.last_assessed_at,
    };
  });
}

module.exports = { loadState, saveStateAndEvent, listStates, DIM_COLUMN };
