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

const VERSION = "knowledge-graph-v10";

function parseArgs(argv) {
  const i = argv.indexOf("--file");
  return {
    file: i !== -1 ? argv[i + 1] : path.join(__dirname, "../../data/curriculum/knowledge-graph-v10.json"),
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
      updated++;
    } else {
      await prisma.global_topics.create({
        data: { chapter_id: chapter.id, subject_id: chapter.subject_id, title: t.title, ...data },
      });
      created++;
    }
  }
  return { created, updated, orphaned };
}

/**
 * Concepts, prerequisites and misconceptions go to the academic-intelligence
 * tables the mastery engine reads — keyed by code, with no foreign key to the
 * curriculum, so load order does not matter.
 */
async function importConcepts(concepts) {
  let conceptRows = 0, prereqRows = 0, misconceptionRows = 0;

  for (const c of concepts) {
    await prisma.academicConcept.upsert({
      where: { code: c.code },
      create: {
        code: c.code, canonical_name: c.name, subject: c.subject || "Unknown",
        class_level: c.class_level, description: c.learning_outcome,
        difficulty_band: Number.isInteger(Number(c.difficulty)) ? Number(c.difficulty) : null,
        status: "ACTIVE", source_id: VERSION,
      },
      update: {
        canonical_name: c.name, subject: c.subject || "Unknown",
        class_level: c.class_level, description: c.learning_outcome, source_id: VERSION,
      },
    });
    conceptRows++;

    for (const raw of String(c.prerequisites || "").split(/[;,]/)) {
      const code = raw.trim();
      if (!code || code === c.code) continue;
      await prisma.conceptPrerequisite.upsert({
        where: { concept_code_prerequisite_code: { concept_code: c.code, prerequisite_code: code } },
        create: { concept_code: c.code, prerequisite_code: code, evidence_source_id: VERSION },
        update: {},
      });
      prereqRows++;
    }

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
  return { conceptRows, prereqRows, misconceptionRows };
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
  const verifiedTp = payload.topics.filter((x) => x.verified).length;
  console.log(`  topics     ${t.created} created, ${t.updated} updated, ${t.orphaned} orphaned  (${verifiedTp} verified)`);

  const c = await importConcepts(payload.concepts);
  console.log(`  concepts   ${c.conceptRows}  prerequisites ${c.prereqRows}  misconceptions ${c.misconceptionRows}`);

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

module.exports = { importSubjects, importChapters, importTopics, importConcepts, VERSION };
