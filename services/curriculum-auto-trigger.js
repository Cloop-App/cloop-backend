const prisma = require("../lib/prisma");

/**
 * Auto-trigger content generation for all of a user's subjects
 * that don't already have a generation job.
 * Called after profile update (e.g., when subjects are selected during onboarding).
 *
 * @param {string} userId
 */
async function autoTriggerContentGeneration(userId) {
  const userSubjects = await prisma.userSubject.findMany({
    where: { user_id: userId },
    select: { subject_id: true },
  });

  for (const { subject_id } of userSubjects) {
    const existing = await prisma.contentGenerationJob.findUnique({
      where: { user_id_subject_id: { user_id: userId, subject_id } },
    });

    if (!existing) {
      await prisma.contentGenerationJob.create({
        data: {
          user_id: userId,
          subject_id,
          status: "pending",
        },
      });
    }
  }
}

module.exports = { autoTriggerContentGeneration };
