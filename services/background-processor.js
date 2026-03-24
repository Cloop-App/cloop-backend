const prisma = require("../lib/prisma");
const { generateSubjectContent } = require("./content-pipeline");

const POLL_INTERVAL_MS = 10_000; // 10 seconds
let intervalId = null;

/**
 * Process the next pending content generation job.
 * Picks one job at a time to avoid overloading the OpenAI API.
 */
async function processNextJob() {
  try {
    const job = await prisma.contentGenerationJob.findFirst({
      where: { status: "pending" },
      orderBy: { created_at: "asc" },
    });

    if (!job) return;

    console.log(
      `[BackgroundProcessor] Processing job: user=${job.user_id}, subject=${job.subject_id}`
    );

    await generateSubjectContent(job.user_id, job.subject_id);

    console.log(
      `[BackgroundProcessor] Completed job: user=${job.user_id}, subject=${job.subject_id}`
    );
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
