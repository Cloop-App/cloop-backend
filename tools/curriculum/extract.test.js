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

const FILE = path.join(__dirname, "../../data/curriculum/knowledge-graph-v10.json");
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
  const prep = data.subjects.filter((s) => s.is_test_prep).map((s) => s.board);
  assert.deepEqual([...new Set(prep)].sort(), ["JEE Main + Advanced", "KCET", "NEET UG"]);
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
  for (const c of data.chapters) {
    assert.equal(c.verified, c.reconciliation_status === "SOURCE-RECONCILED");
  }
  for (const t of data.topics) {
    if (t.verified) {
      assert.match(t.derivation_status, /^Existing/i,
        "a derived topic must never be presented as sourced");
    }
  }
  const verified = data.topics.filter((t) => t.verified).length;
  assert.ok(verified < data.topics.length * 0.4,
    "most topics are derived; if this ever passes, re-check the source");
});

test("provenance survives extraction", () => {
  for (const s of data.subjects) {
    assert.ok(s.source_authority, `${s.key} lost its authority`);
    assert.ok(s.source_year, `${s.key} lost its syllabus year`);
  }
});

test("the gap in Classes 6 and 7 is real, not an extraction artefact", () => {
  const grades = new Set(data.subjects.map((s) => s.grade));
  assert.ok(!grades.has("Class 6"), "workbook has no Class 6");
  assert.ok(!grades.has("Class 7"), "workbook has no Class 7");
  assert.ok(grades.has("Class 9") && grades.has("Class 10"), "VIII-XII must be present");
});
