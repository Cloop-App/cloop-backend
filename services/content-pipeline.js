const prisma = require("../lib/prisma");
const { chatCompletion } = require("./openai");

/**
 * Generate a curriculum — chapters, topics and learning goals — for one
 * board + grade + subject, into the shared catalog.
 *
 * Generation is per board+grade+subject, not per user. Every Class 9 CBSE
 * student studying Science reads the same chapters, so generating them once
 * is both correct and the only way "regenerate" can mean anything: the old
 * per-user job wrote chapters keyed on subject_id alone, so users silently
 * shared rows they each believed were their own.
 *
 * @param {object} status - a global_curriculum_status row
 */
async function generateCurriculum(status) {
  const { board, grade, subject_name: subjectName } = status;

  const key = { board_grade_subject_name: { board, grade, subject_name: subjectName } };

  await prisma.global_curriculum_status.update({
    where: key,
    data: { status: "processing", generation_started_at: new Date(), error_message: null },
  });

  try {
    const subject = await resolveSubject(status);

    const prompt = `Generate a structured curriculum for a ${grade} student studying ${subjectName} under the ${board} board.

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

    const response = await chatCompletion([{ role: "system", content: prompt }], {
      jsonMode: true,
    });

    const curriculum = JSON.parse(response);
    if (!Array.isArray(curriculum.chapters) || curriculum.chapters.length === 0) {
      throw new Error("Model returned no chapters");
    }

    await persistCurriculum(subject.id, curriculum.chapters);

    await prisma.global_curriculum_status.update({
      where: key,
      data: {
        status: "completed",
        chapters_generated: true,
        topics_generated: true,
        goals_generated: true,
        global_subject_id: subject.id,
        generation_completed_at: new Date(),
      },
    });
  } catch (err) {
    await prisma.global_curriculum_status.update({
      where: key,
      data: { status: "failed", error_message: err.message },
    });
    throw err;
  }
}

/** The catalog entry this status row belongs to, created if it is missing. */
async function resolveSubject(status) {
  if (status.global_subject_id) {
    const known = await prisma.global_subjects.findUnique({
      where: { id: status.global_subject_id },
    });
    if (known) return known;
  }

  const { board, grade, subject_name: name } = status;
  const existing = await prisma.global_subjects.findUnique({
    where: { board_grade_name: { board, grade, name } },
  });
  if (existing) return existing;

  return prisma.global_subjects.create({ data: { board, grade, name } });
}

/**
 * Write the generated tree.
 *
 * global_topics carries subject_id as well as chapter_id, so it is set here
 * rather than left to be joined through the chapter — the tutor reads it
 * directly when recording a turn.
 */
async function persistCurriculum(subjectId, chapters) {
  for (const [chapterIndex, chapter] of chapters.entries()) {
    const savedChapter = await prisma.global_chapters.create({
      data: {
        subject_id: subjectId,
        title: chapter.title,
        order: chapter.order || chapterIndex + 1,
      },
    });

    for (const [topicIndex, topic] of (chapter.topics || []).entries()) {
      const savedTopic = await prisma.global_topics.create({
        data: {
          chapter_id: savedChapter.id,
          subject_id: subjectId,
          title: topic.title,
          content: topic.content || null,
          order: topic.order || topicIndex + 1,
        },
      });

      for (const [goalIndex, goal] of (topic.goals || []).entries()) {
        await prisma.global_topic_goals.create({
          data: {
            topic_id: savedTopic.id,
            title: goal.title,
            description: goal.description || null,
            order: goal.order || goalIndex + 1,
          },
        });
      }
    }
  }
}

module.exports = { generateCurriculum, persistCurriculum };
