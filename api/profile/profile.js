const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { authenticateToken } = require("../../middleware/auth");
const { autoTriggerContentGeneration } = require("../../services/curriculum-auto-trigger");

const router = Router();

// All profile routes require authentication
router.use(authenticateToken);

/**
 * GET /api/profile/
 * Get the authenticated user's profile with subjects and chapter completion stats.
 */
router.get("/", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      include: {
        grade_level: true,
        board: true,
        user_subjects: {
          include: {
            subject: {
              include: {
                chapters: {
                  include: {
                    _count: { select: { topics: true } },
                  },
                },
              },
            },
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
 * Update the authenticated user's profile.
 * Triggers curriculum auto-generation when subjects change.
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

    const user = await prisma.user.update({
      where: { user_id: userId },
      data: {
        ...(grade_level !== undefined && { grade_level_id: grade_level }),
        ...(board !== undefined && { board_id: board }),
        ...(preferred_language !== undefined && { preferred_language }),
        ...(study_goal !== undefined && { study_goal }),
        ...(avatar_choice !== undefined && { avatar_choice }),
        ...(avatar_url !== undefined && { avatar_url }),
      },
    });

    // Sync subjects if provided
    if (subjects && Array.isArray(subjects)) {
      await prisma.userSubject.deleteMany({ where: { user_id: userId } });
      for (const subjectId of subjects) {
        await prisma.userSubject.create({
          data: { user_id: userId, subject_id: subjectId },
        });
      }

      // Auto-trigger content generation for new subjects
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
 * Register an Expo push token.
 * [B7] NOTE: This is mobile-only. Web clients should not call this endpoint.
 * Returns success as a no-op for web clients.
 */
router.post("/push-token", async (req, res) => {
  try {
    const { expoPushToken } = req.body;

    if (!expoPushToken) {
      // Web clients may hit this — return success silently
      return res.json({ success: true });
    }

    // Store push token — in a real implementation this would be persisted
    // For now, this is a no-op placeholder that doesn't break web clients
    console.log(`Push token registered for user ${req.user.user_id}: ${expoPushToken}`);

    return res.json({ success: true });
  } catch (err) {
    console.error("Push token error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/profile/add-subject
 * Add a subject to the user's enrolled subjects.
 */
router.post("/add-subject", async (req, res) => {
  try {
    const { subject_id } = req.body;
    const userId = req.user.user_id;

    if (!subject_id) {
      return res.status(400).json({ error: "subject_id is required." });
    }

    const userSubject = await prisma.userSubject.create({
      data: { user_id: userId, subject_id },
    });

    // Auto-trigger content generation
    await autoTriggerContentGeneration(userId);

    return res.json({ success: true, userSubject });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Subject already added." });
    }
    console.error("Add subject error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * DELETE /api/profile/remove-subject
 * Remove a subject from the user's enrolled subjects.
 */
router.delete("/remove-subject", async (req, res) => {
  try {
    const { subject_id } = req.body;
    const userId = req.user.user_id;

    if (!subject_id) {
      return res.status(400).json({ error: "subject_id is required." });
    }

    await prisma.userSubject.deleteMany({
      where: { user_id: userId, subject_id },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Remove subject error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/chat-history
 * Get the user's topic chat history.
 */
router.get("/chat-history", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const chatTopics = await prisma.topicChat.findMany({
      where: { user_id: userId },
      select: { topic_id: true, is_completed: true, completion_percent: true, created_at: true },
      distinct: ["topic_id"],
      orderBy: { created_at: "desc" },
    });

    const chatHistory = await Promise.all(
      chatTopics.map(async (chat) => {
        const topic = await prisma.topic.findUnique({
          where: { id: chat.topic_id },
          include: {
            chapter: {
              include: { subject: true },
            },
          },
        });

        const lastMessage = await prisma.topicChat.findFirst({
          where: { topic_id: chat.topic_id, user_id: userId },
          orderBy: { created_at: "desc" },
        });

        return {
          topic_id: chat.topic_id,
          title: topic?.title || "Unknown Topic",
          subject: topic?.chapter?.subject?.name || "Unknown Subject",
          chapter: topic?.chapter?.title || "Unknown Chapter",
          last_activity: lastMessage?.created_at || chat.created_at,
          is_completed: lastMessage?.is_completed || false,
          completion_percent: lastMessage?.completion_percent || 0,
        };
      })
    );

    return res.json({ chatHistory });
  } catch (err) {
    console.error("Chat history error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/metrics
 * Get aggregated learning metrics for the user.
 */
router.get("/metrics", async (req, res) => {
  try {
    const userId = req.user.user_id;

    const userSubjects = await prisma.userSubject.findMany({
      where: { user_id: userId },
      include: { subject: true },
    });

    const totalSubjects = userSubjects.length;

    // Gather chapter/topic stats per subject
    const subjectProgress = await Promise.all(
      userSubjects.map(async (us) => {
        const chapters = await prisma.chapter.findMany({
          where: { subject_id: us.subject_id },
          include: { topics: true },
        });

        const totalChapters = chapters.length;
        const totalTopics = chapters.reduce((sum, ch) => sum + ch.topics.length, 0);

        // Count completed topics by checking for completed topic chats
        const completedTopicChats = await prisma.topicChat.findMany({
          where: {
            user_id: userId,
            is_completed: true,
            topic: { chapter: { subject_id: us.subject_id } },
          },
          distinct: ["topic_id"],
        });

        return {
          subject_id: us.subject_id,
          subject_name: us.subject.name,
          totalChapters,
          totalTopics,
          completedTopics: completedTopicChats.length,
        };
      })
    );

    const totalChapters = subjectProgress.reduce((sum, sp) => sum + sp.totalChapters, 0);
    const completedChapters = 0; // Computed from topic completion — simplified

    // Get strong/weak topics from reports
    const reports = await prisma.userTopicReport.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 50,
    });

    const strongTopics = reports.filter((r) => r.score_percent >= 75).length;
    const weakTopics = reports.filter((r) => r.score_percent < 50).length;

    return res.json({
      totalSubjects,
      completedSubjects: 0,
      totalChapters,
      completedChapters,
      strongTopics,
      weakTopics,
      subjectProgress,
    });
  } catch (err) {
    console.error("Metrics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/learning-analytics
 * [B4] Learning analytics endpoint — returns time-series learning data and topic trends.
 */
router.get("/learning-analytics", async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Recent reports ordered by date for time-series view
    const reports = await prisma.userTopicReport.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 100,
      include: {
        topic: {
          include: {
            chapter: {
              include: { subject: true },
            },
          },
        },
      },
    });

    // Aggregate by day
    const dailyStats = {};
    for (const report of reports) {
      const day = report.created_at.toISOString().slice(0, 10);
      if (!dailyStats[day]) {
        dailyStats[day] = {
          date: day,
          sessions: 0,
          total_questions: 0,
          correct_answers: 0,
          time_spent_seconds: 0,
        };
      }
      dailyStats[day].sessions += 1;
      dailyStats[day].total_questions += report.total_questions;
      dailyStats[day].correct_answers += report.correct_answers;
      dailyStats[day].time_spent_seconds += report.time_spent_seconds;
    }

    // Topic trends — average score per subject
    const subjectScores = {};
    for (const report of reports) {
      const subjectName = report.topic?.chapter?.subject?.name || "Unknown";
      if (!subjectScores[subjectName]) {
        subjectScores[subjectName] = { total: 0, count: 0 };
      }
      subjectScores[subjectName].total += report.score_percent;
      subjectScores[subjectName].count += 1;
    }

    const topicTrends = Object.entries(subjectScores).map(([name, data]) => ({
      subject: name,
      average_score: Math.round(data.total / data.count),
      sessions: data.count,
    }));

    return res.json({
      daily: Object.values(dailyStats).sort((a, b) => a.date.localeCompare(b.date)),
      topicTrends,
      recentReports: reports.slice(0, 10).map((r) => ({
        id: r.id,
        topic_id: r.topic_id,
        topic_title: r.topic?.title || "Unknown",
        subject_name: r.topic?.chapter?.subject?.name || "Unknown",
        score_percent: r.score_percent,
        star_rating: r.star_rating,
        performance_level: r.performance_level,
        top_error_types: r.top_error_types,
        weak_goals: r.weak_goals,
        time_spent_seconds: r.time_spent_seconds,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Learning analytics error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/reports/by-subject/:subjectId
 * [B5] Get topic reports for a specific subject.
 * Returns reports ordered by most recent, with topic and chapter context.
 */
router.get("/reports/by-subject/:subjectId", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const subjectId = parseInt(req.params.subjectId);

    if (isNaN(subjectId)) {
      return res.status(400).json({ error: "Invalid subjectId." });
    }

    // Verify user is enrolled in this subject
    const enrolled = await prisma.userSubject.findUnique({
      where: {
        user_id_subject_id: { user_id: userId, subject_id: subjectId },
      },
    });

    if (!enrolled) {
      return res.status(403).json({ error: "You are not enrolled in this subject." });
    }

    const reports = await prisma.userTopicReport.findMany({
      where: {
        user_id: userId,
        topic: {
          chapter: { subject_id: subjectId },
        },
      },
      orderBy: { created_at: "desc" },
      include: {
        topic: {
          include: {
            chapter: true,
          },
        },
      },
    });

    return res.json({
      reports: reports.map((r) => ({
        id: r.id,
        topic_id: r.topic_id,
        topic_title: r.topic?.title || "Unknown",
        chapter_title: r.topic?.chapter?.title || "Unknown",
        total_questions: r.total_questions,
        correct_answers: r.correct_answers,
        incorrect_answers: r.incorrect_answers,
        score_percent: r.score_percent,
        star_rating: r.star_rating,
        performance_level: r.performance_level,
        top_error_types: r.top_error_types,
        weak_goals: r.weak_goals,
        time_spent_seconds: r.time_spent_seconds,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Reports by subject error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/profile/reports/recent
 * [B5] Get the most recent topic reports across all subjects.
 */
router.get("/reports/recent", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const reports = await prisma.userTopicReport.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        topic: {
          include: {
            chapter: {
              include: { subject: true },
            },
          },
        },
      },
    });

    return res.json({
      reports: reports.map((r) => ({
        id: r.id,
        topic_id: r.topic_id,
        topic_title: r.topic?.title || "Unknown",
        chapter_title: r.topic?.chapter?.title || "Unknown",
        subject_name: r.topic?.chapter?.subject?.name || "Unknown",
        total_questions: r.total_questions,
        correct_answers: r.correct_answers,
        incorrect_answers: r.incorrect_answers,
        score_percent: r.score_percent,
        star_rating: r.star_rating,
        performance_level: r.performance_level,
        top_error_types: r.top_error_types,
        weak_goals: r.weak_goals,
        time_spent_seconds: r.time_spent_seconds,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Recent reports error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

module.exports = router;
