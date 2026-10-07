/**
 * The bridge between what a student picked and the shared curriculum catalog.
 *
 * A user carries `subjects` as short codes ("SCI", "MATH"), while the catalog
 * is keyed by board + grade + subject name. Curriculum is generated once per
 * board+grade+subject and shared by everyone studying it, rather than once per
 * user — which is what the old per-user tables attempted and got wrong: they
 * wrote chapters keyed only by subject_id, so two users of the same subject
 * shared rows anyway and a "reset" for one deleted the other's curriculum.
 */

const prisma = require("../lib/prisma");

/**
 * Codes as they appear in users.subjects, mapped to catalog names.
 * An unknown code is used as its own name rather than dropped: a student who
 * picked something we have no mapping for should still get a curriculum.
 */
const SUBJECT_NAMES = {
  SCI: "Science",
  SOC: "Social Studies",
  MATH: "Mathematics",
  ENG: "English",
  HIN: "Hindi",
  CMP: "Computer Science",
  EVS: "Environmental Studies",
  ART: "Art",
};

function subjectNameFor(code) {
  if (!code) return null;
  return SUBJECT_NAMES[String(code).trim().toUpperCase()] || String(code).trim();
}

/** A user without both of these cannot be matched to a catalog. */
function hasCurriculumContext(user) {
  return Boolean(user?.board && user?.grade_level);
}

/**
 * The catalog entry for this board, grade and subject, created if new.
 *
 * @param {string} board
 * @param {string} grade
 * @param {string} codeOrName - "SCI" or "Science"
 */
async function resolveGlobalSubject(board, grade, codeOrName) {
  const name = subjectNameFor(codeOrName);
  if (!name) return null;

  const existing = await prisma.global_subjects.findUnique({
    where: { board_grade_name: { board, grade, name } },
  });
  if (existing) return existing;

  return prisma.global_subjects.create({
    data: {
      board,
      grade,
      name,
      code: String(codeOrName).trim().toUpperCase(),
    },
  });
}

/**
 * Queue curriculum generation for a catalog entry, unless it is already done
 * or already running. Returns the status row.
 */
async function queueGeneration(board, grade, subjectName, globalSubjectId) {
  const existing = await prisma.global_curriculum_status.findUnique({
    where: { board_grade_subject_name: { board, grade, subject_name: subjectName } },
  });

  if (existing) {
    // Already generated, or in flight — leave it alone. Re-queueing a running
    // job is how you get two writers building the same catalog at once.
    if (existing.status === "completed" || existing.status === "processing") return existing;

    return prisma.global_curriculum_status.update({
      where: { board_grade_subject_name: { board, grade, subject_name: subjectName } },
      data: { status: "pending", error_message: null, global_subject_id: globalSubjectId },
    });
  }

  return prisma.global_curriculum_status.create({
    data: {
      board,
      grade,
      subject_name: subjectName,
      global_subject_id: globalSubjectId,
      status: "pending",
    },
  });
}

/**
 * Enrol a user in one subject and make sure its curriculum is on its way.
 * @returns {Promise<object|null>} the global subject, or null if unresolvable
 */
async function enrolInSubject(user, codeOrName) {
  if (!hasCurriculumContext(user)) return null;

  const subject = await resolveGlobalSubject(user.board, user.grade_level, codeOrName);
  if (!subject) return null;

  await prisma.user_subject_enrollment.upsert({
    where: { user_id_subject_id: { user_id: user.user_id, subject_id: subject.id } },
    create: { user_id: user.user_id, subject_id: subject.id },
    update: {},
  });

  await queueGeneration(user.board, user.grade_level, subject.name, subject.id);
  return subject;
}

/**
 * Bring a user's enrolments in line with their chosen subject codes, and queue
 * curriculum for anything not yet generated.
 *
 * @returns {Promise<Array>} the global subjects the user is now enrolled in
 */
async function syncEnrollments(user) {
  if (!hasCurriculumContext(user) || !Array.isArray(user.subjects)) return [];

  const subjects = [];
  for (const code of user.subjects) {
    const subject = await enrolInSubject(user, code);
    if (subject) subjects.push(subject);
  }

  // Drop enrolments for subjects the student no longer studies. Their progress
  // rows are left untouched — deselecting a subject is not a request to erase
  // the work already done in it.
  const keep = subjects.map((s) => s.id);
  await prisma.user_subject_enrollment.deleteMany({
    where: { user_id: user.user_id, subject_id: { notIn: keep.length > 0 ? keep : [-1] } },
  });

  return subjects;
}

module.exports = {
  SUBJECT_NAMES,
  subjectNameFor,
  hasCurriculumContext,
  resolveGlobalSubject,
  queueGeneration,
  enrolInSubject,
  syncEnrollments,
};
