/**
 * Cloop Seed Dataset v1.0 — loader and pipeline adapter.
 * -------------------------------------------------------------------------
 * Loads the vendored synthetic pilot dataset (data/seed/) and maps its
 * records into the input shape the Learning Intelligence Pipeline expects, so
 * the seed interactions can be replayed through the real engine.
 *
 * This is the spec's step 3–6 ("Replay the interaction records → implement
 * mastery updates → error/misconception detection → adaptive next-action")
 * done WITHOUT a database: the JSON is the system of record for the pilot.
 * The same mapping is what a Postgres-backed loader would produce per row.
 */

const fs = require("fs");
const path = require("path");
const { DIMENSIONS } = require("../mastery/mastery-engine");

const SEED_DIR = path.join(__dirname, "..", "..", "data", "seed");

// Seed error `category` → v8 error taxonomy tag (Cloop_Error_Taxonomy_v1).
const CATEGORY_TO_ERROR_TYPE = {
  CONCEPTUAL: "ERR-CON-01",
  ALGEBRAIC: "ERR-PROC-01",
  VECTOR: "ERR-REP-01",
  DIAGRAM: "ERR-REP-01",
  CALCULATION: "ERR-CALC-01",
  INTERPRETATION: "ERR-READ-01",
  PREREQUISITE_GAP: "ERR-PREREQ-01",
};

// Question difficulty is a 1–5 controlled scale (ontology §9.2). Normalise to
// the [0,1] the mastery engine's weight/difficulty factors use.
function normaliseDifficulty(d) {
  if (d == null) return 0.5;
  return Math.min(1, Math.max(0, d / 5));
}

/**
 * Load the seed dataset. Prefers the individual files; falls back to the
 * combined bundle. Returns both the raw collections and lookup indexes.
 *
 * @param {string} [dir] override the seed directory (for tests)
 */
function loadSeed(dir = SEED_DIR) {
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

  let raw;
  try {
    raw = {
      metadata: readJson("metadata.json"),
      concepts: readJson("concepts.json"),
      prerequisites: readJson("prerequisites.json"),
      learning_outcomes: readJson("learning_outcomes.json"),
      misconceptions: readJson("misconceptions.json"),
      errors: readJson("errors.json"),
      interventions: readJson("interventions.json"),
      questions: readJson("questions.json"),
      student_interactions: readJson("student_interactions.json"),
      mastery_states: readJson("mastery_states.json"),
      training_examples: readJson("training_examples.json"),
    };
  } catch {
    raw = readJson("cloop_seed_dataset_v1.0.json");
  }

  const byId = (arr, key = "id") =>
    new Map((arr || []).map((r) => [r[key], r]));

  const index = {
    concepts: byId(raw.concepts),
    questions: byId(raw.questions),
    errors: byId(raw.errors),
    misconceptions: byId(raw.misconceptions),
    interventions: byId(raw.interventions),
    // mastery_states keyed by "student|concept"
    mastery: new Map(
      (raw.mastery_states || []).map((m) => [`${m.student}|${m.concept}`, m])
    ),
    // prerequisites grouped by the concept that HAS the requirement
    prerequisitesOf: groupBy(raw.prerequisites || [], "concept"),
  };

  return { raw, index };
}

function groupBy(arr, key) {
  const m = new Map();
  for (const r of arr) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Materialise a mastery state for (student, concept). The seed only stores an
 * overall_mastery, so dimensions are initialised to that value (the engine's
 * weighted sum of equal dimensions equals the overall — a faithful, neutral
 * starting point). Unknown pairs start mid-scale with high uncertainty.
 */
function masteryStateFor(index, student, conceptId) {
  const seed = index.mastery.get(`${student}|${conceptId}`);
  const overall = seed?.overall_mastery ?? 0.5;
  // Seed stores only an overall score; initialise every v8 stage to it (the
  // weighted sum of equal stages equals the overall — a neutral start point).
  const dims = DIMENSIONS.reduce((a, d) => ((a[d] = overall), a), {});
  return {
    student_id: student,
    concept_id: conceptId,
    dimensions: dims,
    uncertainty: seed?.uncertainty ?? 0.4,
    evidence_count: seed?.evidence_count ?? 0,
  };
}

/**
 * Convert one seed student_interaction into a full pipeline input object.
 *
 * @param {object} interaction seed record
 * @param {object} loaded      result of loadSeed()
 * @returns {object} runPipeline() input
 */
function interactionToPipelineInput(interaction, loaded) {
  const { index } = loaded;
  const question = index.questions.get(interaction.question) || {};
  const conceptIds = question.concepts || [];
  const primaryConcept = conceptIds[0] || null;

  // Concept evidence weights: primary carries most of the diagnostic weight
  // when a question spans two concepts (mirrors the spec's 0.75/0.25 example).
  const conceptEvidence = conceptIds.map((cid, i) => ({
    concept_id: cid,
    weight: conceptIds.length === 1 ? 1 : i === 0 ? 0.75 : 0.25 / (conceptIds.length - 1),
  }));

  const errorRec = interaction.error ? index.errors.get(interaction.error) : null;
  const errorType = errorRec ? CATEGORY_TO_ERROR_TYPE[errorRec.category] || "conceptual" : null;

  // Prerequisites of the primary concept, annotated with the student's mastery
  // of each prerequisite so Stage F can attribute blame upstream.
  const prereqs = (index.prerequisitesOf.get(primaryConcept) || []).map((p) => {
    const pmState = index.mastery.get(`${interaction.student}|${p.requires}`);
    return {
      concept_id: p.requires,
      mastery: pmState?.overall_mastery ?? 0.5,
      edgeStrength: p.strength ?? 0.5,
    };
  });

  const outcome = interaction.correct
    ? "correct"
    : errorRec?.category === "ALGEBRAIC" || errorRec?.category === "CALCULATION"
      ? "incorrect_valid_method"
      : "incorrect_conceptual";

  return {
    interactionId: interaction.id,
    studentId: interaction.student,
    timestamp: interaction.timestamp,
    evaluation: {
      correctness: interaction.correct,
      confidence: 0.95, // evaluator confidence (seed items are verified)
      studentConfidence: interaction.confidence,
    },
    conceptEvidence,
    masteryState: masteryStateFor(index, interaction.student, primaryConcept),
    errorSignals: {
      explicitErrorType: errorType,
      difficulty: normaliseDifficulty(question.difficulty),
      taskType: taskTypeForQuestion(question),
      nSimilar: 0,
      hintLevel: "none",
    },
    misconceptionFactors: interaction.misconception
      ? {
          misconceptionId: interaction.misconception,
          evidenceStrength: interaction.confidence ?? 0.6,
          patternConsistency: 0.5, // single interaction → not yet consistent
          conceptAlignment: 0.9,
          historySupport: 0.4,
          evaluatorConfidence: 0.95,
          evidenceCount: 1,
        }
      : {},
    prerequisites: prereqs,
    gap: {
      conceptImportance: 0.8,
      prerequisiteLeverage: prereqs.length ? 0.7 : 0.3,
      examRelevance: 0.75,
      expectedGain: 0.6,
    },
    // Ground-truth label carried alongside for replay assertions/eval sets.
    _label: {
      correct: interaction.correct,
      error: interaction.error,
      misconception: interaction.misconception,
      intervention: interaction.intervention,
    },
  };
}

function taskTypeForQuestion(q) {
  const t = (q.type || "").toUpperCase();
  if (t === "MCQ") return "understanding";
  if (t === "NUMERICAL" || t === "SHORT_ANSWER") return "familiar_application";
  if (t === "LONG_ANSWER" || t === "PROOF") return "analysis";
  return "familiar_application";
}

module.exports = {
  SEED_DIR,
  CATEGORY_TO_ERROR_TYPE,
  loadSeed,
  masteryStateFor,
  interactionToPipelineInput,
  normaliseDifficulty,
};
