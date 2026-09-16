/**
 * The catalog bridge decides when curriculum gets generated, and generation is
 * an expensive model call that writes content every student on a board and
 * grade will read. The rules about when NOT to queue matter as much as the
 * rules about when to.
 */

const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../lib/prisma");

const db = { subjects: [], statuses: [], enrollments: [] };
let nextId = 1;

const prismaStub = {
  global_subjects: {
    findUnique: async ({ where }) => {
      const { board, grade, name } = where.board_grade_name || {};
      return db.subjects.find((s) => s.board === board && s.grade === grade && s.name === name) || null;
    },
    create: async ({ data }) => {
      const row = { id: nextId++, ...data };
      db.subjects.push(row);
      return row;
    },
  },
  global_curriculum_status: {
    findUnique: async ({ where }) => {
      const { board, grade, subject_name } = where.board_grade_subject_name;
      return (
        db.statuses.find(
          (s) => s.board === board && s.grade === grade && s.subject_name === subject_name
        ) || null
      );
    },
    create: async ({ data }) => {
      const row = { id: nextId++, ...data };
      db.statuses.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const { board, grade, subject_name } = where.board_grade_subject_name;
      const row = db.statuses.find(
        (s) => s.board === board && s.grade === grade && s.subject_name === subject_name
      );
      Object.assign(row, data);
      return row;
    },
  },
  user_subject_enrollment: {
    upsert: async ({ where }) => {
      const { user_id, subject_id } = where.user_id_subject_id;
      if (!db.enrollments.some((e) => e.user_id === user_id && e.subject_id === subject_id)) {
        db.enrollments.push({ user_id, subject_id });
      }
      return { user_id, subject_id };
    },
    deleteMany: async ({ where }) => {
      const keep = where.subject_id.notIn;
      db.enrollments = db.enrollments.filter(
        (e) => e.user_id !== where.user_id || keep.includes(e.subject_id)
      );
      return { count: 0 };
    },
  },
};

require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaStub };

const C = require("./curriculum");

function reset() {
  db.subjects = [];
  db.statuses = [];
  db.enrollments = [];
  nextId = 1;
}

const STUDENT = {
  user_id: 112,
  board: "Central Board of Secondary Education",
  grade_level: "Class 9",
  subjects: ["SCI", "MATH"],
};

test("subject codes resolve to catalog names, unknown ones pass through", () => {
  assert.equal(C.subjectNameFor("SCI"), "Science");
  assert.equal(C.subjectNameFor("math"), "Mathematics");
  assert.equal(C.subjectNameFor("CMP"), "Computer Science");
  assert.equal(C.subjectNameFor("ASTRONOMY"), "ASTRONOMY", "an unmapped code still gets a curriculum");
  assert.equal(C.subjectNameFor(null), null);
});

test("a student without a board or grade has no catalog to match", () => {
  assert.equal(C.hasCurriculumContext(STUDENT), true);
  assert.equal(C.hasCurriculumContext({ board: "CBSE" }), false);
  assert.equal(C.hasCurriculumContext({ grade_level: "Class 9" }), false);
  assert.equal(C.hasCurriculumContext(null), false);
});

test("a catalog entry is created once and reused", async () => {
  reset();
  const first = await C.resolveGlobalSubject(STUDENT.board, STUDENT.grade_level, "SCI");
  const second = await C.resolveGlobalSubject(STUDENT.board, STUDENT.grade_level, "Science");

  assert.equal(first.id, second.id, "the code and the name are the same subject");
  assert.equal(db.subjects.length, 1);
  assert.equal(first.name, "Science");
});

test("generation is not re-queued while it is already done or running", async () => {
  reset();
  const args = [STUDENT.board, STUDENT.grade_level, "Science", 1];

  const queued = await C.queueGeneration(...args);
  assert.equal(queued.status, "pending");

  queued.status = "processing";
  assert.equal((await C.queueGeneration(...args)).status, "processing", "a running job is left alone");

  queued.status = "completed";
  assert.equal((await C.queueGeneration(...args)).status, "completed", "a finished job is not redone");

  queued.status = "failed";
  assert.equal((await C.queueGeneration(...args)).status, "pending", "a failed job is retried");
  assert.equal(db.statuses.length, 1, "and never duplicated");
});

test("a cohort on the same board and grade shares one generation job", async () => {
  reset();
  await C.syncEnrollments(STUDENT);
  await C.syncEnrollments({ ...STUDENT, user_id: 113 });

  assert.equal(db.statuses.length, 2, "two subjects, not four jobs");
  assert.deepEqual(db.statuses.map((s) => s.subject_name).sort(), ["Mathematics", "Science"]);
  assert.equal(db.enrollments.length, 4, "but both students are enrolled in both");
});

test("dropping a subject removes the enrolment and leaves the catalog alone", async () => {
  reset();
  await C.syncEnrollments(STUDENT);
  assert.equal(db.enrollments.length, 2);

  await C.syncEnrollments({ ...STUDENT, subjects: ["SCI"] });

  assert.equal(db.enrollments.length, 1);
  assert.equal(db.subjects.length, 2, "the shared catalog is not deleted for one student");
});

test("dropping every subject removes every enrolment", async () => {
  reset();
  await C.syncEnrollments(STUDENT);
  await C.syncEnrollments({ ...STUDENT, subjects: [] });

  assert.equal(db.enrollments.length, 0, "an empty keep-list must not be read as keep-everything");
});
