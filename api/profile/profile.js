const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");
const { autoTriggerContentGeneration } = require("../../services/curriculum-auto-trigger");

const router = Router();

// All profile routes require authentication
router.use(authenticateToken);

/**
 * GET /api/profile/
 * The user's profile, with the subjects they are enrolled in.
 */
router.get("/", async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { user_id: req.user.user_id },
      include: {
        subject_enrollments: {
          include: {
            subject: { include: { chapters: { select: { id: true } } } },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user });
  } catch (err) {
    console.error("Get profile error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * PUT /api/profile/update
 * Update the profile. Subjects are short codes ("SCI"), and board and grade
 * are text, since that is how the shared curriculum catalog is keyed.
 */
router.put("/update", async (req, res) => {
  try {
    const {
      grade_level,
      board,
      subjects,
      preferred_language,
      study_goal,
      avatar_choice,
      avatar_url,
    } = req.body;

    const userId = req.user.user_id;

    const user = await prisma.users.update({
      where: { user_id: userId },
      data: {
        ...(grade_level !== undefined && { grade_level }),
        ...(board !== undefined && { board }),
        ...(preferred_language !== undefined && { preferred_language }),
        ...(study_goal !== undefined && { study_goal }),
        ...(avatar_choice !== undefined && { avatar_choice }),
        ...(avatar_url !== undefined && { avatar_url }),
        ...(Array.isArray(subjects) && { subjects }),
      },
    });

    // Board and grade select the catalog, so a change to either re-points the
    // student's subjects at a different one.
    if (subjects !== undefined || grade_level !== undefined || board !== undefined) {
      await autoTriggerContentGeneration(userId);
    }

    return res.json({ success: true, user });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/profile/push-token
 * Register an Expo push token. Mobile-only; web clients may post nothing and
 * get a success back.
 */
router.post("/push-token", async (req, res) => {
  try {
    const { expoPushToken } = req.body;

    if (!expoPushToken) {
      return res.json({ success: true });
    }

    await prisma.users.update({
      where: { user_id: req.user.user_id },
      data: { expo_push_token: expoPushToken },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Push token error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/profile/add-subject
 * Add a subject and queue its curriculum if nobody has generated it yet.
 */
router.post("/add-subject", async (req, res) => {
  try {
    const { subject } = req.body;
    const userId = req.user.user_id;

    if (!subject) {
      return res.status(400).json({ error: "subject is required." });
    }

    const user = await prisma.users.findUnique({ where: { user_id: userId } });
    const code = String(subject).trim().toUpperCase();

    if (user.subjects.includes(code)) {
      return res.status(409).json({ error: "Subject already added." });
    }

    await prisma.users.update({
      where: { user_id: userId },
      data: { subjects: [...user.subjects, code] },
    });

    const subjects = await autoTriggerContentGeneration(userId);
    return res.json({ success: true, subjects: subjects.map((s) => s.name) });
  } catch (err) {
    console.error("Add subject error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/profile/remove-subject
 * Stop studying a subject. Progress already recorded in it is kept.
 */
router.delete("/remove-subject", async (req, res) => {
  try {
    const { subject } = req.body;
    const userId = req.user.user_id;

    if (!subject) {
      return res.status(400).json({ error: "subject is required." });
    }

    const user = await prisma.users.findUnique({ where: { user_id: userId } });
    const code = String(subject).trim().toUpperCase();

    await prisma.users.update({
      where: { user_id: userId },
      data: { subjects: user.subjects.filter((s) => s.toUpperCase() !== code) },
    });

    await autoTriggerContentGeneration(userId);
    return res.json({ success: true });
  } catch (err) {
    console.error("Remove subject error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/chat-history
 * Topics the user has tutoring sessions for, most recent first.
 */
router.get("/chat-history", async (req, res) => {
  try {
    const sessions = await prisma.tutor_sessions.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { updated_at: "desc" },
      include: {
        topic: { include: { chapter: { include: { subject: true } } } },
      },
    });

    const progress = await prisma.user_topic_progress.findMany({
      where: { user_id: req.user.user_id, topic_id: { in: sessions.map((s) => s.topic_id) } },
    });
    const byTopic = new Map(progress.map((p) => [p.topic_id, p]));

    return res.json({
      chatHistory: sessions.map((session) => {
        const seen = byTopic.get(session.topic_id);
        return {
          topic_id: session.topic_id,
          title: session.topic?.title || "Unknown Topic",
          subject: session.topic?.chapter?.subject?.name || "Unknown Subject",
          chapter: session.topic?.chapter?.title || "Unknown Chapter",
          last_activity: session.updated_at || session.started_at,
          phase: session.state?.phase || null,
          is_completed: seen?.is_completed ?? !session.is_active,
          completion_percent: Number(seen?.completion_percent ?? 0),
        };
      }),
    });
  } catch (err) {
    console.error("Chat history error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/metrics
 * Aggregate progress across the subjects the user studies.
 */
router.get("/metrics", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const enrollments = await prisma.user_subject_enrollment.findMany({
      where: { user_id: userId },
      include: { subject: { include: { chapters: { include: { topics: { select: { id: true } } } } } } },
    });

    const chapterProgress = await prisma.user_chapter_progress.findMany({ where: { user_id: userId } });
    const completedByChapter = new Map(chapterProgress.map((p) => [p.chapter_id, p]));

    const subjectProgress = enrollments.map((enrollment) => {
      const chapters = enrollment.subject.chapters;
      const totalTopics = chapters.reduce((sum, ch) => sum + ch.topics.length, 0);
      const completedTopics = chapters.reduce(
        (sum, ch) => sum + (completedByChapter.get(ch.id)?.completed_topics ?? 0),
        0
      );

      return {
        subject_id: enrollment.subject_id,
        subject_name: enrollment.subject.name,
        totalChapters: chapters.length,
        totalTopics,
        completedTopics,
      };
    });

    const reports = await prisma.user_topic_reports.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    });

    return res.json({
      totalSubjects: enrollments.length,
      completedSubjects: subjectProgress.filter(
        (s) => s.totalTopics > 0 && s.completedTopics >= s.totalTopics
      ).length,
      totalChapters: subjectProgress.reduce((sum, s) => sum + s.totalChapters, 0),
      completedChapters: chapterProgress.filter(
        (p) => p.total_topics > 0 && p.completed_topics >= p.total_topics
      ).length,
      strongTopics: reports.filter((r) => r.score_percent >= 75).length,
      weakTopics: reports.filter((r) => r.score_percent < 50).length,
      subjectProgress,
    });
  } catch (err) {
    console.error("Metrics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/learning-analytics
 * Time-series learning data and per-subject trends.
 */
router.get("/learning-analytics", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const reports = await prisma.user_topic_reports.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 100,
      include: { topic: { include: { chapter: { include: { subject: true } } } } },
    });

    // Time comes from study_sessions, which is the only place it is measured.
    const sessions = await prisma.study_sessions.findMany({
      where: { user_id: userId },
      orderBy: { start_time: "desc" },
      take: 500,
    });

    const dailyStats = {};
    const dayOf = (date) => new Date(date).toISOString().slice(0, 10);
    const dayBucket = (day) =>
      (dailyStats[day] ??= {
        date: day,
        sessions: 0,
        total_questions: 0,
        correct_answers: 0,
        time_spent_seconds: 0,
      });

    for (const report of reports) {
      const bucket = dayBucket(dayOf(report.created_at));
      bucket.sessions += 1;
      bucket.total_questions += report.total_questions;
      bucket.correct_answers += report.correct_answers;
    }
    for (const session of sessions) {
      dayBucket(dayOf(session.start_time)).time_spent_seconds += session.duration_seconds || 0;
    }

    const subjectScores = {};
    for (const report of reports) {
      const name = report.topic?.chapter?.subject?.name || "Unknown";
      subjectScores[name] ??= { total: 0, count: 0 };
      subjectScores[name].total += report.score_percent;
      subjectScores[name].count += 1;
    }

    return res.json({
      daily: Object.values(dailyStats).sort((a, b) => a.date.localeCompare(b.date)),
      topicTrends: Object.entries(subjectScores).map(([subject, data]) => ({
        subject,
        average_score: Math.round(data.total / data.count),
        sessions: data.count,
      })),
      recentReports: reports.slice(0, 10).map((r) => ({
        id: r.id,
        topic_id: r.topic_id,
        topic_title: r.topic?.title || "Unknown",
        subject_name: r.topic?.chapter?.subject?.name || "Unknown",
        score_percent: r.score_percent,
        star_rating: r.star_rating,
        performance_level: r.performance_level,
        // The report's detail moved into metrics_json when the mastery report
        // started being computed from the session's own tallies.
        top_error_types: r.metrics_json?.top_error_types ?? [],
        weak_goals: r.metrics_json?.weak_goals ?? [],
        goals_covered: r.metrics_json?.goals_covered ?? null,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Learning analytics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
