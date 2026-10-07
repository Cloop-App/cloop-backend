/**
 * Load the reconciled curriculum into the catalog.
 *
 *   node tools/curriculum/import.js [--file data/curriculum/knowledge-graph-v10.json]
 *
 * Idempotent: re-running updates in place rather than forking the catalog. It
 * is also deliberately non-destructive — it never deletes generated chapters,
 * because global_topics cascades to tutor_sessions, chat_goal_progress and
 * every learning turn recorded against them. Sourced rows arrive with
 * `verified = true` alongside whatever is already there; switching the app
 * over to serve only verified rows is a separate, reversible decision.
 */

const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");

const VERSION = process.env.CURRICULUM_VERSION || "knowledge-graph-v11.1";

function parseArgs(argv) {
  const i = argv.indexOf("--file");
  return {
    file: i !== -1 ? argv[i + 1] : path.join(__dirname, "../../data/curriculum/knowledge-graph-v11.json"),
  };
}

async function importSubjects(subjects) {
  const byKey = new Map();
  for (const s of subjects) {
    const row = await prisma.global_subjects.upsert({
      where: { board_grade_name: { board: s.board, grade: s.grade, name: s.name } },
      create: {
        board: s.board, grade: s.grade, name: s.name, code: s.code,
        source_authority: s.source_authority, source_year: s.source_year,
        official_source: s.official_source, curriculum_version: VERSION,
        is_test_prep: s.is_test_prep,
      },
      update: {
        code: s.code, source_authority: s.source_authority, source_year: s.source_year,
        official_source: s.official_source, curriculum_version: VERSION,
        is_test_prep: s.is_test_prep, updated_at: new Date(),
      },
    });
    byKey.set(s.key, row.id);
  }
  return byKey;
}

/**
 * Chapters are matched on the workbook's own node id, not on title: a title
 * can be re-worded between syllabus years and must still land on the same row.
 */
async function importChapters(chapters, subjectIds) {
  const byKey = new Map();
  for (const c of chapters) {
    const subject_id = subjectIds.get(c.subject_key);
    if (!subject_id) continue;

    // Matched on (subject, title): chapters are now keyed on title, which is
    // unique within a subject, and the workbook's node ids are many-to-one
    // against a chapter so none of them identifies it on its own.
    const existing = await prisma.global_chapters.findFirst({
      where: { subject_id, title: c.title },
      select: { id: true },
    });

    const data = {
      title: c.title, order: c.order, unit: c.unit,
      reconciliation_status: c.reconciliation_status, verified: c.verified,
    };

    const row = existing
      ? await prisma.global_chapters.update({ where: { id: existing.id }, data })
      : await prisma.global_chapters.create({
          data: { subject_id, source_node_id: (c.node_ids && c.node_ids[0]) || null, ...data },
        });

    byKey.set(c.chapter_key, { id: row.id, subject_id });
  }
  return byKey;
}

async function importTopics(topics, chapterIds) {
  let created = 0, updated = 0, orphaned = 0;
  const ids = new Map();   // `${chapter_key}||${title}` -> global_topics.id
  for (const t of topics) {
    const chapter = chapterIds.get(t.chapter_key);
    if (!chapter) { orphaned++; continue; }

    const existing = await prisma.global_topics.findFirst({
      where: { chapter_id: chapter.id, title: t.title },
      select: { id: true },
    });

    const data = {
      order: t.order, derivation_status: t.derivation_status, verified: t.verified,
    };

    if (existing) {
      await prisma.global_topics.update({ where: { id: existing.id }, data });
      ids.set(`${t.chapter_key}||${t.title}`, existing.id);
      updated++;
    } else {
      const row = await prisma.global_topics.create({
        data: { chapter_id: chapter.id, subject_id: chapter.subject_id, title: t.title, ...data },
      });
      ids.set(`${t.chapter_key}||${t.title}`, row.id);
      created++;
    }
  }
  return { created, updated, orphaned, ids };
}

/**
 * Concepts, prerequisites and misconceptions go to the academic-intelligence
 * tables the mastery engine reads — keyed by code, with no foreign key to the
 * curriculum, so load order does not matter.
 */
async function importConcepts(concepts, topicIds = new Map(), chapterKeyOf = new Map()) {
  let conceptRows = 0, misconceptionRows = 0, linked = 0;

  for (const c of concepts) {
    const description = c.learning_objective || c.learning_outcome || null;
    const difficulty = Number.isInteger(c.difficulty) ? c.difficulty : null;
    // node -> chapter -> the topic of the same name. Exact match only: a
    // near-miss here would file a concept under the wrong lesson.
    const chapterKey = chapterKeyOf.get(c.node_id);
    const topicId = chapterKey ? topicIds.get(`${chapterKey}||${c.topic}`) ?? null : null;
    if (topicId) linked++;

    await prisma.academicConcept.upsert({
      where: { code: c.code },
      create: {
        code: c.code, canonical_name: c.name, subject: c.subject || "Unknown",
        class_level: c.class_level, description, difficulty_band: difficulty,
        concept_type: c.bloom || null, status: "ACTIVE",
        source_id: c.source_url || VERSION, curriculum_topic_id: topicId,
      },
      update: {
        canonical_name: c.name, subject: c.subject || "Unknown",
        class_level: c.class_level, description, difficulty_band: difficulty,
        concept_type: c.bloom || null, source_id: c.source_url || VERSION,
        curriculum_topic_id: topicId,
      },
    });
    conceptRows++;

    if (c.misconception) {
      await prisma.misconception.upsert({
        where: { code: `${c.code}-MIS` },
        create: {
          code: `${c.code}-MIS`, concept_code: c.code,
          incorrect_belief: c.misconception, status: "CANDIDATE",
        },
        update: { incorrect_belief: c.misconception },
      });
      misconceptionRows++;
    }
  }
  return { conceptRows, misconceptionRows, linked };
}

/**
 * The prerequisite graph.
 *
 * Legacy v10 edges are excluded by the extractor, because the workbook's own
 * validation queue marks them P0 with the production rule "DO NOT ENFORCE
 * LEGACY HARD GATING". What remains lands at candidate strength until an SME
 * signs it off: an unvalidated edge in a gating graph sends a student
 * backwards through material they already know.
 */
async function importPrerequisites(edges = []) {
  let rows = 0;
  for (const e of edges) {
    const validated = /validated|confirmed/i.test(e.validation_status || "");
    const evidence = `${e.graph_version || VERSION}:${e.validation_status || "UNVALIDATED"}`;
    await prisma.conceptPrerequisite.upsert({
      where: {
        concept_code_prerequisite_code: {
          concept_code: e.dependent_code, prerequisite_code: e.prerequisite_code,
        },
      },
      create: {
        concept_code: e.dependent_code, prerequisite_code: e.prerequisite_code,
        strength: validated ? 0.8 : 0.3, evidence_source_id: evidence,
      },
      update: { strength: validated ? 0.8 : 0.3, evidence_source_id: evidence },
    });
    rows++;
  }
  return rows;
}

async function main() {
  const { file } = parseArgs(process.argv);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`importing ${path.basename(file)} as ${VERSION}\n`);

  const subjectIds = await importSubjects(payload.subjects);
  console.log(`  subjects   ${subjectIds.size}`);

  const chapterIds = await importChapters(payload.chapters, subjectIds);
  const verifiedCh = payload.chapters.filter((c) => c.verified).length;
  console.log(`  chapters   ${chapterIds.size}  (${verifiedCh} source-reconciled)`);

  const t = await importTopics(payload.topics, chapterIds);
  const chapterKeyOf = new Map();
  for (const c of payload.chapters) {
    for (const node of c.node_ids || []) chapterKeyOf.set(node, c.chapter_key);
  }
  const verifiedTp = payload.topics.filter((x) => x.verified).length;
  console.log(`  topics     ${t.created} created, ${t.updated} updated, ${t.orphaned} orphaned  (${verifiedTp} verified)`);

  const c = await importConcepts(payload.concepts, t.ids, chapterKeyOf);
  const edges = await importPrerequisites(payload.prerequisites);
  console.log(`  concepts   ${c.conceptRows}  misconceptions ${c.misconceptionRows}  linked to a topic ${c.linked}`);
  console.log(`  prereq edges ${edges}`);

  const generated = await prisma.global_chapters.count({ where: { verified: false } });
  console.log(`\n  chapters still unverified in the catalog: ${generated}`);
  console.log("  (generated rows are left in place; cutting over is a separate decision)");

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error("import failed:", err.message);
    await prisma.$disconnect();
    process.exit(1);
  });
}

module.exports = { importSubjects, importChapters, importTopics, importConcepts, importPrerequisites, VERSION };
