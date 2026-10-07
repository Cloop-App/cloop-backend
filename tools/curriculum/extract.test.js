/**
 * Guards on the extracted curriculum.
 *
 * The normaliser is the risky part: the workbook says "CBSE" and "IX" while a
 * student's record says "Central Board of Secondary Education" and "Class 9".
 * Get that wrong and the import builds a second catalog nobody is enrolled in
 * — which is precisely how the generated data forked into 26 redundant
 * subjects over a colon versus an em dash.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "../../data/curriculum/knowledge-graph-v11.json");
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));

test("boards are spelled the way a student record spells them", () => {
  const boards = new Set(data.subjects.map((s) => s.board));
  assert.ok(boards.has("Central Board of Secondary Education"), "CBSE must be expanded");
  assert.ok(boards.has("Indian Certificate of Secondary Education"), "ICSE must be expanded");
  for (const b of boards) {
    assert.ok(b !== "CBSE" && b !== "ICSE", `${b} left in workbook shorthand`);
    assert.ok(b.length <= 50, `${b} exceeds users.board VarChar(50)`);
  }
});

test("grades are Class N, never roman numerals", () => {
  for (const s of data.subjects) {
    assert.match(s.grade, /^Class \d+(-\d+)?$/, `bad grade: ${s.grade}`);
  }
});

test("entrance exams are marked as test prep, school boards are not", () => {
  const prep = [...new Set(data.subjects.filter((s) => s.is_test_prep).map((s) => s.board))];
  // v11.1 carries both the legacy combined JEE system and the new split into
  // Main and Advanced, so a JEE student matches three catalogs rather than one.
  assert.deepEqual(prep.sort(),
    ["JEE Advanced", "JEE Main", "JEE Main + Advanced", "KCET", "NEET UG"]);
  for (const s of data.subjects.filter((x) => !x.is_test_prep)) {
    assert.ok(s.grade.indexOf("-") === -1, "a school grade spans one class");
  }
});

test("every chapter and topic hangs off something that exists", () => {
  const subjectKeys = new Set(data.subjects.map((s) => s.key));
  const chapterKeys = new Set(data.chapters.map((c) => c.chapter_key));

  for (const c of data.chapters) {
    assert.ok(subjectKeys.has(c.subject_key), `orphan chapter: ${c.title}`);
  }
  for (const t of data.topics) {
    assert.ok(chapterKeys.has(t.chapter_key), `orphan topic: ${t.title}`);
  }
});

test("a chapter title appears once per subject", () => {
  const seen = new Set();
  for (const c of data.chapters) {
    assert.ok(!seen.has(c.chapter_key), `duplicate chapter: ${c.chapter_key}`);
    seen.add(c.chapter_key);
  }
});

test("a topic title appears once per chapter", () => {
  const seen = new Set();
  for (const t of data.topics) {
    const k = `${t.chapter_key}||${t.title}`;
    assert.ok(!seen.has(k), `duplicate topic: ${k}`);
    seen.add(k);
  }
});

test("only rows the workbook calls sourced are marked verified", () => {
  const SOURCED = /^(PRIMARY_|SOURCE-RECONCILED)/;
  for (const c of data.chapters) {
    assert.equal(c.verified, SOURCED.test(c.reconciliation_status || ""),
      `${c.title}: verified must track the workbook's authority status`);
    if (c.verified) {
      assert.ok(!/SCOPE-QUALIFIED|SCHOOL_SELECTED/.test(c.reconciliation_status),
        "school-level or school-chosen content is not a board syllabus");
    }
  }
  assert.ok(data.topics.some((t) => t.verified), "some topics must be sourced");
});

test("provenance survives extraction", () => {
  for (const s of data.subjects) {
    assert.ok(s.source_authority, `${s.key} lost its authority`);
    assert.ok(s.source_year, `${s.key} lost its syllabus year`);
  }
});

test("Classes 6 to 12 are all covered", () => {
  const grades = new Set(data.subjects.map((s) => s.grade));
  for (let n = 6; n <= 12; n++) {
    assert.ok(grades.has(`Class ${n}`), `Class ${n} missing — v11.1 closed this gap`);
  }
});

test("test prep is present and marked as such", () => {
  const prep = data.subjects.filter((s) => s.is_test_prep);
  assert.ok(prep.length > 0, "entrance exams must be covered");
  assert.ok(prep.every((s) => s.grade === "Class 11-12"));
});

test("every concept resolves to a topic, or it cannot reach a student", () => {
  assert.ok(data.concepts.length > 0);
  for (const c of data.concepts) {
    assert.ok(c.topic, `${c.code} is not attached to any topic`);
    assert.ok(c.chapter_key, `${c.code} has no chapter`);
  }
});

test("the two concept pools are kept honestly apart", () => {
  const derived = data.concepts.filter((c) => /PEDAGOGICALLY_DERIVED/.test(c.provenance || ""));
  const legacy = data.concepts.filter((c) => c.provenance === "LEGACY_V10_NAMES_ONLY");
  assert.ok(derived.length > 0 && legacy.length > 0, "both pools must be present");

  // The v11 pool carries a difficulty and an objective.
  for (const c of derived) {
    assert.ok(Number.isInteger(c.difficulty), `${c.code} lost its difficulty`);
    assert.ok(c.learning_objective, `${c.code} lost its objective`);
  }
  // The legacy pool carries a name and nothing else. Those fields must stay
  // null: a fabricated difficulty would be indistinguishable from a real one.
  for (const c of legacy) {
    assert.equal(c.difficulty, null, `${c.code} invented a difficulty`);
    assert.equal(c.learning_objective, null, `${c.code} invented an objective`);
    assert.equal(c.misconception, null, `${c.code} invented a misconception`);
  }
});

test("no misconception is invented for the classes that have none", () => {
  const withMis = data.concepts.filter((c) => c.misconception);
  // Only the v11 Class 6-7 pool has any, and even those are generic.
  assert.ok(withMis.every((c) => /PEDAGOGICALLY_DERIVED/.test(c.provenance || "")));
  assert.ok(withMis.length < data.concepts.length * 0.2,
    "most concepts have no misconception, and must not acquire one by generation");
});

test("no legacy prerequisite edge is imported", () => {
  assert.ok(data.prerequisites.length > 0, "the graph must not be empty");
  for (const e of data.prerequisites) {
    assert.ok(!/legacy/i.test(e.graph_version || ""),
      "the workbook's own rule is DO NOT ENFORCE LEGACY HARD GATING");
    assert.notEqual(e.prerequisite_code, e.dependent_code, "a concept cannot precede itself");
  }
});
