/**
 * Cloop Mastery Engine v8 — canonical configuration.
 * -------------------------------------------------------------------------
 * Loads the vendored v8 workbook config (data/knowledge-graph-v8/) and exposes
 * it as the single source of truth for:
 *   - the 7 mastery STAGES and their weights (Cloop_Mastery_Engine_v1)
 *   - the 4 mastery BANDS + the 0.80 mastery threshold + prerequisite gate
 *   - the 8-tag ERROR TAXONOMY (Cloop_Error_Taxonomy_v1)
 *   - the 6 REMEDIATION rules (Remediation_Policy_v8)
 *   - error-tag → mastery-stage routing (which stages an error moves)
 *
 * The v8 workbook replaces the earlier docx R/U/A/N/T/F/D dimension set. The
 * evidence-weighted update mechanics (learning rate, evidence weight,
 * uncertainty, retention, hint/repetition discounts, prerequisite attribution)
 * are retained from the Mastery Engine spec and applied per v8 stage.
 */

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "..", "data", "knowledge-graph-v8");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

const ENGINE = read("mastery_engine.json");
const ERROR_TAXONOMY = read("error_taxonomy.json");
const REMEDIATION_POLICY = read("remediation_policy.json");

// Ordered stage keys and their weights, straight from the workbook.
const STAGES = ENGINE.stages.map((s) => s.key);
const STAGE_META = Object.fromEntries(ENGINE.stages.map((s) => [s.key, s]));
const WEIGHTS = Object.fromEntries(ENGINE.stages.map((s) => [s.key, s.weight]));

const BANDS = ENGINE.bands; // [{min,max,level}]
const MASTERY_THRESHOLD = ENGINE.mastery_threshold; // 0.80
const THRESHOLD_RULE = ENGINE.threshold_rule;

// Error-tag → which mastery stage(s) the error moves. Derived from each tag's
// family + definition. Prerequisite gaps route upstream (no downstream stage).
const ERROR_STAGE_ROUTING = {
  "ERR-CON-01": ["explanation", "application", "error_diagnosis"], // misconception
  "ERR-PREREQ-01": [], // route upstream; limit downstream penalty
  "ERR-PROC-01": ["application"], // procedure/algorithm execution
  "ERR-REP-01": ["representation"], // representation translation
  "ERR-CALC-01": ["application"], // execution slip (small)
  "ERR-READ-01": ["explanation", "application"], // question interpretation
  "ERR-TRANSFER-01": ["transfer", "explanation"],
  "ERR-CARELESS-01": ["application"], // transient slip; diagnostic only, gentle
};

// Errors that should be treated gently (transient/execution) — a small update,
// not a conceptual hit. Mirrors the spec's "do not over-penalise conceptual
// mastery for a calculation slip".
const GENTLE_ERROR_TAGS = new Set(["ERR-CALC-01", "ERR-CARELESS-01"]);

// Remediation rule lookup by the situation it triggers on.
const REMEDIATION_BY_TRIGGER = Object.fromEntries(
  REMEDIATION_POLICY.map((r) => [r.trigger, r])
);

/** Map an overall score to its v8 band level. */
function bandFor(overall) {
  const o = Math.min(1, Math.max(0, overall));
  for (const b of BANDS) {
    if (o <= b.max) return b.level;
  }
  return BANDS[BANDS.length - 1].level;
}

/**
 * Is the concept "mastered" per v8? Requires overall ≥ threshold AND no
 * unresolved critical prerequisite (the prerequisite gate).
 */
function isMastered(overall, prerequisiteGateOpen = false) {
  return overall >= MASTERY_THRESHOLD && !prerequisiteGateOpen;
}

module.exports = {
  ENGINE,
  STAGES,
  STAGE_META,
  WEIGHTS,
  BANDS,
  MASTERY_THRESHOLD,
  THRESHOLD_RULE,
  ERROR_TAXONOMY,
  ERROR_STAGE_ROUTING,
  GENTLE_ERROR_TAGS,
  REMEDIATION_POLICY,
  REMEDIATION_BY_TRIGGER,
  bandFor,
  isMastered,
};
