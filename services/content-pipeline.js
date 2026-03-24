const prisma = require("../lib/prisma");
const { chatCompletion } = require("./openai");

/**
 * Generate curriculum content (chapters + topics + goals) for a user's subject.
 * This is called by the background processor or directly via API.
 *
 * @param {string} userId
 * @param {number} subjectId
 */
async function generateSubjectContent(userId, subjectId) {
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    include: { grade_level: true, board: true },
  });

  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
  });

  if (!user || !subject) {
    throw new Error("User or subject not found");
  }

  // Update job status
  await prisma.contentGenerationJob.update({
    where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
    data: { status: "processing" },
  });

  try {
    const prompt = `Generate a structured curriculum for a ${user.grade_level?.name || "student"} studying ${subject.name} under the ${user.board?.name || "general"} board.

Return a JSON object with this structure:
{
  "chapters": [
    {
      "title": "Chapter Title",
      "order": 1,
      "topics": [
        {
          "title": "Topic Title",
          "content": "Brief topic overview/content",
          "order": 1,
          "goals": [
            { "title": "Goal 1", "description": "What the student should learn" },
            { "title": "Goal 2", "description": "..." }
          ]
        }
      ]
    }
  ]
}

Generate 5-8 chapters with 3-5 topics each, and 2-4 learning goals per topic.`;

    const response = await chatCompletion(
      [{ role: "system", content: prompt }],
      { jsonMode: true }
    );

    const curriculum = JSON.parse(response);

    // Persist chapters, topics, and goals
    for (const chapter of curriculum.chapters) {
      const savedChapter = await prisma.chapter.create({
        data: {
          title: chapter.title,
          subject_id: subjectId,
          order: chapter.order || 0,
        },
      });

      for (const topic of chapter.topics || []) {
        const savedTopic = await prisma.topic.create({
          data: {
            title: topic.title,
            content: topic.content || null,
            chapter_id: savedChapter.id,
            order: topic.order || 0,
          },
        });

        for (const goal of topic.goals || []) {
          await prisma.topicGoal.create({
            data: {
              topic_id: savedTopic.id,
              title: goal.title,
              description: goal.description || null,
              order: goal.order || 0,
            },
          });
        }
      }
    }

    // Mark job as completed
    await prisma.contentGenerationJob.update({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
      data: { status: "completed" },
    });
  } catch (err) {
    await prisma.contentGenerationJob.update({
      where: { user_id_subject_id: { user_id: userId, subject_id: subjectId } },
      data: { status: "failed", error: err.message },
    });
    throw err;
  }
}

module.exports = { generateSubjectContent };
