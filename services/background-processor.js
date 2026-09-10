const prisma = require("../lib/prisma");
const { generateCurriculum } = require("./content-pipeline");

const POLL_INTERVAL_MS = 10_000; // 10 seconds
let intervalId = null;

/**
 * Generate the next pending curriculum.
 *
 * One at a time, to avoid overloading the model provider. Jobs are per
 * board+grade+subject now, so a cohort of students signing up together
 * produces one job between them rather than one each.
 */
async function processNextJob() {
  try {
    const job = await prisma.global_curriculum_status.findFirst({
      where: { status: "pending" },
      orderBy: { created_at: "asc" },
    });

    if (!job) return;

    const label = `${job.board} / ${job.grade} / ${job.subject_name}`;
    console.log(`[BackgroundProcessor] Generating curriculum: ${label}`);

    await generateCurriculum(job);

    console.log(`[BackgroundProcessor] Completed curriculum: ${label}`);
  } catch (err) {
    console.error("[BackgroundProcessor] Job failed:", err.message);
  }
}

/**
 * Start the background processor loop.
 */
function startBackgroundProcessor() {
  if (intervalId) {
    console.warn("[BackgroundProcessor] Already running");
    return;
  }

  console.log("[BackgroundProcessor] Started");
  intervalId = setInterval(processNextJob, POLL_INTERVAL_MS);

  // Process immediately on start
  processNextJob();
}

/**
 * Stop the background processor loop.
 */
function stopBackgroundProcessor() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[BackgroundProcessor] Stopped");
  }
}

module.exports = { startBackgroundProcessor, stopBackgroundProcessor };
