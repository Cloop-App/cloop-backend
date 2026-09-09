const prisma = require("../lib/prisma");
const { syncEnrollments } = require("./curriculum");

/**
 * Enrol a user in the subjects they have chosen and queue any curriculum that
 * has not been generated yet.
 *
 * Called after onboarding and whenever the subject list changes.
 *
 * @param {number} userId
 * @returns {Promise<Array>} the global subjects the user is enrolled in
 */
async function autoTriggerContentGeneration(userId) {
  const user = await prisma.users.findUnique({ where: { user_id: userId } });
  if (!user) return [];

  return syncEnrollments(user);
}

module.exports = { autoTriggerContentGeneration };
