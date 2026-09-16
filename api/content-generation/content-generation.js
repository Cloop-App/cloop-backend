const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");
const {
  hasCurriculumContext,
  resolveGlobalSubject,
  queueGeneration,
} = require("../../services/curriculum");
const { autoTriggerContentGeneration } = require("../../services/curriculum-auto-trigger");

const router = Router();

router.use(authenticateToken);

/**
 * Curriculum is generated once per board + grade + subject and shared by
 * everyone studying it, so every route here works from the caller's board and
 * grade. A user who has not chosen those yet has no catalog to generate into.
 */
async function callerContext(req, res) {
  const user = await prisma.users.findUnique({ where: { user_id: req.user.user_id } });

  if (!user) {
    res.status(404).json({ error: "User not found." });
    return null;
  }
  if (!hasCurriculumContext(user)) {
    res.status(400).json({ error: "Set your board and grade before generating curriculum." });
    return null;
  }
  return user;
}

/** Accepts a global_subjects id, or a subject code/name to resolve into one. */
async function resolveSubject(user, body) {
  if (body.subjectId) {
    const byId = await prisma.global_subjects.findUnique({
      where: { id: parseInt(body.subjectId, 10) },
    });
    if (byId) return byId;
  }
  if (body.subject) {
    return resolveGlobalSubject(user.board, user.grade_level, body.subject);
  }
  return null;
}

/**
 * POST /api/content-generation/generate
 * Queue curriculum generation for one subject.
 */
router.post("/generate", async (req, res) => {
  try {
    const user = await callerContext(req, res);
    if (!user) return;

    const subject = await resolveSubject(user, req.body);
    if (!subject) {
      return res.status(400).json({ error: "subjectId or subject is required." });
    }

    const status = await queueGeneration(user.board, user.grade_level, subject.name, subject.id);

    if (status.status === "completed") {
      return res.json({ success: true, message: "Content already generated.", status });
    }

    return res.json({ success: true, status });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/content-generation/generate-all
 * Queue curriculum for every subject the user studies.
 */
router.post("/generate-all", async (req, res) => {
  try {
    const user = await callerContext(req, res);
    if (!user) return;

    const subjects = await autoTriggerContentGeneration(user.user_id);
    return res.json({ success: true, subjects: subjects.map((s) => s.name) });
  } catch (err) {
    console.error("Generate all error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/content-generation/status/:userId/:subjectId
 * Generation status for one subject.
 * The userId in the path is ignored; the caller's own context is used.
 */
router.get("/status/:userId/:subjectId", async (req, res) => {
  try {
    const user = await callerContext(req, res);
    if (!user) return;

    const subject = await prisma.global_subjects.findUnique({
      where: { id: parseInt(req.params.subjectId, 10) },
    });
    if (!subject) return res.json({ exists: false, status: null });

    const status = await prisma.global_curriculum_status.findUnique({
      where: {
        board_grade_subject_name: {
          board: user.board,
          grade: user.grade_level,
          subject_name: subject.name,
        },
      },
    });

    return res.json({ exists: Boolean(status), status: status || null });
  } catch (err) {
    console.error("Status error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/content-generation/all-statuses/:userId
 * Generation status for every subject the user studies.
 */
router.get("/all-statuses/:userId", async (req, res) => {
  try {
    const user = await callerContext(req, res);
    if (!user) return;

    const enrollments = await prisma.user_subject_enrollment.findMany({
      where: { user_id: user.user_id },
      include: { subject: true },
    });

    const statuses = await prisma.global_curriculum_status.findMany({
      where: {
        board: user.board,
        grade: user.grade_level,
        subject_name: { in: enrollments.map((e) => e.subject.name) },
      },
    });

    return res.json({ data: statuses });
  } catch (err) {
    console.error("All statuses error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/content-generation/reset
 * Delete a subject's curriculum and generate it again.
 *
 * The catalog is shared, so this discards the chapters, topics and goals every
 * student on this board and grade is working through. Deleting topics cascades
 * to their in-flight tutoring sessions and goal progress, and nulls the goal_id
 * on the learning_turns already recorded against them — the same hole that left
 * 42% of the pilot's turns unattributable. It therefore needs `confirm: true`
 * said out loud rather than happening because one user tapped "reset"; the
 * previous version deleted shared chapters silently while presenting itself as
 * per-user.
 */
router.post("/reset", async (req, res) => {
  try {
    const user = await callerContext(req, res);
    if (!user) return;

    const subject = await resolveSubject(user, req.body);
    if (!subject) {
      return res.status(400).json({ error: "subjectId or subject is required." });
    }

    if (req.body.confirm !== true) {
      const affected = await prisma.user_subject_enrollment.count({
        where: { subject_id: subject.id },
      });
      return res.status(409).json({
        error: "Resetting regenerates shared curriculum.",
        detail: `This deletes ${subject.name} for ${user.grade_level} / ${user.board}, affecting ${affected} enrolled student(s). Their in-flight sessions and goal progress go with it, and past learning turns lose their goal link. Send confirm: true to proceed.`,
        requires_confirmation: true,
      });
    }

    await prisma.global_chapters.deleteMany({ where: { subject_id: subject.id } });

    await prisma.global_curriculum_status.upsert({
      where: {
        board_grade_subject_name: {
          board: user.board,
          grade: user.grade_level,
          subject_name: subject.name,
        },
      },
      update: {
        status: "pending",
        error_message: null,
        chapters_generated: false,
        topics_generated: false,
        goals_generated: false,
      },
      create: {
        board: user.board,
        grade: user.grade_level,
        subject_name: subject.name,
        global_subject_id: subject.id,
        status: "pending",
      },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Reset error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
