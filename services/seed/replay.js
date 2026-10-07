/**
 * Replay the Cloop Seed Dataset through the learning-intelligence engine.
 *
 * For every seed student_interaction it runs the full deterministic pipeline
 * (error → misconception → prerequisite → mastery update → gap → adaptive
 * action) and prints what the engine decided next to the dataset's label.
 *
 * Offline — no DB, no API key. This is the spec's "replay the interaction
 * records" step and the basis for the mastery-calibration / diagnosis-accuracy
 * metrics.
 *
 *   node services/seed/replay.js
 */

const { loadSeed, interactionToPipelineInput } = require("./seed-loader");
const { runPipeline } = require("../pipeline/learning-pipeline");

async function replay() {
  const loaded = loadSeed();
  const results = [];
  for (const interaction of loaded.raw.student_interactions) {
    const input = interactionToPipelineInput(interaction, loaded);
    const out = await runPipeline(input); // no SLM stage — decision only
    results.push({ interaction, input, out });
  }
  return { loaded, results };
}

function summarise(results) {
  const rows = results.map(({ interaction, out }) => ({
    id: interaction.id,
    concept: out.concept_evidence?.[0]?.concept_id || "—",
    correct: interaction.correct,
    error: out.errors?.[0]?.error_id || "—",
    misc: out.misconceptions?.[0]
      ? `${out.misconceptions[0].confidence.toFixed(2)}${out.misconceptions[0].promote ? " (promoted)" : ""}`
      : "—",
    mastery: `${out.mastery_update.before.toFixed(2)}→${out.mastery_update.after.toFixed(2)}`,
    action: out.adaptive_plan.selected_action,
  }));
  return rows;
}

if (require.main === module) {
  replay()
    .then(({ results }) => {
      const rows = summarise(results);
      console.log("\n=== Cloop Seed Dataset — engine replay ===\n");
      const head = ["interaction", "concept", "ok", "error", "misc", "mastery", "next action"];
      const widths = [12, 13, 3, 16, 16, 12, 24];
      const line = (cells) =>
        cells.map((c, i) => String(c).padEnd(widths[i])).join(" ");
      console.log(line(head));
      console.log(line(widths.map((w) => "-".repeat(w))));
      for (const r of rows) {
        console.log(
          line([r.id, r.concept, r.correct ? "✓" : "✗", r.error, r.misc, r.mastery, r.action])
        );
      }
      console.log("");
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { replay, summarise };
