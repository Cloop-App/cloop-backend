-- User analytics and the tutor pipeline audit trail.
--
-- tutor_turn_logs is the important one: the full evaluator + state machine
-- output for every turn. The pilot could report that 70.8% of answers were
-- correct but not which phase the student was in, which directive the tutor
-- chose, or how far down the escalation ladder a stuck student was taken --
-- because the pipeline that computes those values was never deployed.
--
-- topic_chat_sessions is the closing summary of a session; live state between
-- turns stays on tutor_sessions, which is the only one with is_active.
--
-- Purely additive: no existing table is touched.

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_activity_sessions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "session_token" VARCHAR(100),
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(6),
    "duration_seconds" INTEGER DEFAULT 0,
    "device_type" VARCHAR(30),
    "app_version" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_activity_sessions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "user_daily_stats" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "total_wall_time_seconds" INTEGER NOT NULL DEFAULT 0,
    "total_study_time_seconds" INTEGER NOT NULL DEFAULT 0,
    "topics_studied" INTEGER NOT NULL DEFAULT 0,
    "topics_completed" INTEGER NOT NULL DEFAULT 0,
    "questions_answered" INTEGER NOT NULL DEFAULT 0,
    "questions_correct" INTEGER NOT NULL DEFAULT 0,
    "sessions_count" INTEGER NOT NULL DEFAULT 0,
    "messages_sent" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_daily_stats_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "user_streaks" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "longest_streak" INTEGER NOT NULL DEFAULT 0,
    "last_active_date" DATE,
    "streak_start_date" DATE,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_streaks_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "user_curriculum_summary" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "board" VARCHAR(100) NOT NULL,
    "grade" VARCHAR(50) NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "subject_name" VARCHAR(100) NOT NULL,
    "total_chapters" INTEGER NOT NULL DEFAULT 0,
    "completed_chapters" INTEGER NOT NULL DEFAULT 0,
    "total_topics" INTEGER NOT NULL DEFAULT 0,
    "completed_topics" INTEGER NOT NULL DEFAULT 0,
    "completion_percent" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "avg_score_percent" DECIMAL(5,2) DEFAULT 0.00,
    "total_time_spent_seconds" INTEGER NOT NULL DEFAULT 0,
    "last_activity_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_curriculum_summary_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "tutor_turn_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "topic_id" INTEGER NOT NULL,
    "chapter_id" INTEGER,
    "subject_id" INTEGER,
    "goal_id" INTEGER,
    "chat_id" INTEGER,
    "intent" VARCHAR(30) NOT NULL,
    "is_correct" BOOLEAN,
    "score_percent" DOUBLE PRECISION,
    "error_type" VARCHAR(50),
    "diff_html" TEXT,
    "complete_answer" TEXT,
    "suggested_action" VARCHAR(50),
    "evaluator_reasoning" TEXT,
    "phase" VARCHAR(30) NOT NULL,
    "answered_in_phase" VARCHAR(30),
    "state_instruction" VARCHAR(50),
    "question_type" VARCHAR(20),
    "goal_index" INTEGER DEFAULT 0,
    "goal_total" INTEGER DEFAULT 0,
    "escalation_step" INTEGER DEFAULT 0,
    "goal_correct" INTEGER DEFAULT 0,
    "goal_total_questions" INTEGER DEFAULT 0,
    "goal_errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_turns" INTEGER DEFAULT 0,
    "total_questions" INTEGER DEFAULT 0,
    "consecutive_wrong" INTEGER DEFAULT 0,
    "off_topic_streak" INTEGER DEFAULT 0,
    "stuck_streak" INTEGER DEFAULT 0,
    "reteach_pending" BOOLEAN DEFAULT false,
    "reveal_pending" BOOLEAN DEFAULT false,
    "user_message" TEXT,
    "ai_response_preview" VARCHAR(500),
    "ai_bubble_count" INTEGER DEFAULT 0,
    "mastery_score_percent" DOUBLE PRECISION,
    "performance_level" VARCHAR(30),
    "star_rating" INTEGER,
    "end_reason" VARCHAR(30),
    "was_graded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_turn_logs_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "topic_chat_errors" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "topic_id" INTEGER NOT NULL,
    "chapter_id" INTEGER NOT NULL,
    "subject_id" INTEGER NOT NULL,
    "goal_id" INTEGER,
    "chat_id" INTEGER,
    "turn_log_id" INTEGER,
    "error_type" VARCHAR(50) NOT NULL,
    "error_subtype" VARCHAR(50),
    "severity" VARCHAR(20) NOT NULL DEFAULT 'medium',
    "question_text" TEXT,
    "user_answer" TEXT NOT NULL,
    "correct_answer" TEXT,
    "diff_html" TEXT,
    "score_percent" DOUBLE PRECISION DEFAULT 0,
    "phase" VARCHAR(30),
    "attempt_number" INTEGER DEFAULT 1,
    "was_retaught" BOOLEAN NOT NULL DEFAULT false,
    "mastery_before" DOUBLE PRECISION DEFAULT 0,
    "mastery_after" DOUBLE PRECISION DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_chat_errors_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "topic_chat_sessions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "topic_id" INTEGER NOT NULL,
    "subject_id" INTEGER,
    "chapter_id" INTEGER,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(6),
    "duration_seconds" INTEGER DEFAULT 0,
    "total_turns" INTEGER NOT NULL DEFAULT 0,
    "total_questions" INTEGER NOT NULL DEFAULT 0,
    "correct_answers" INTEGER NOT NULL DEFAULT 0,
    "incorrect_answers" INTEGER NOT NULL DEFAULT 0,
    "score_percent" DOUBLE PRECISION DEFAULT 0,
    "goals_completed" INTEGER NOT NULL DEFAULT 0,
    "goals_total" INTEGER NOT NULL DEFAULT 0,
    "end_reason" VARCHAR(30),
    "performance_level" VARCHAR(30),
    "star_rating" INTEGER DEFAULT 0,
    "final_state_json" JSONB,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_activity_sessions_user_id_is_active_idx" ON "user_activity_sessions"("user_id", "is_active");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_activity_sessions_user_id_started_at_idx" ON "user_activity_sessions"("user_id", "started_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_activity_sessions_is_active_idx" ON "user_activity_sessions"("is_active");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_daily_stats_user_id_date_idx" ON "user_daily_stats"("user_id", "date");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_daily_stats_date_idx" ON "user_daily_stats"("date");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_daily_stats_user_id_date_key" ON "user_daily_stats"("user_id", "date");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_streaks_user_id_key" ON "user_streaks"("user_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_curriculum_summary_user_id_board_grade_idx" ON "user_curriculum_summary"("user_id", "board", "grade");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_curriculum_summary_board_grade_idx" ON "user_curriculum_summary"("board", "grade");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_curriculum_summary_user_id_subject_id_key" ON "user_curriculum_summary"("user_id", "subject_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_user_id_topic_id_idx" ON "tutor_turn_logs"("user_id", "topic_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_user_id_created_at_idx" ON "tutor_turn_logs"("user_id", "created_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_topic_id_phase_idx" ON "tutor_turn_logs"("topic_id", "phase");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_phase_idx" ON "tutor_turn_logs"("phase");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_intent_idx" ON "tutor_turn_logs"("intent");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_error_type_idx" ON "tutor_turn_logs"("error_type");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "tutor_turn_logs_created_at_idx" ON "tutor_turn_logs"("created_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_user_id_topic_id_idx" ON "topic_chat_errors"("user_id", "topic_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_user_id_chapter_id_idx" ON "topic_chat_errors"("user_id", "chapter_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_user_id_subject_id_idx" ON "topic_chat_errors"("user_id", "subject_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_error_type_idx" ON "topic_chat_errors"("error_type");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_topic_id_error_type_idx" ON "topic_chat_errors"("topic_id", "error_type");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_chapter_id_error_type_idx" ON "topic_chat_errors"("chapter_id", "error_type");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_errors_created_at_idx" ON "topic_chat_errors"("created_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_sessions_user_id_topic_id_idx" ON "topic_chat_sessions"("user_id", "topic_id");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_sessions_user_id_started_at_idx" ON "topic_chat_sessions"("user_id", "started_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "topic_chat_sessions_topic_id_idx" ON "topic_chat_sessions"("topic_id");

-- AddForeignKey
ALTER TABLE "user_activity_sessions" DROP CONSTRAINT IF EXISTS "user_activity_sessions_user_id_fkey";
ALTER TABLE "user_activity_sessions" ADD CONSTRAINT "user_activity_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_daily_stats" DROP CONSTRAINT IF EXISTS "user_daily_stats_user_id_fkey";
ALTER TABLE "user_daily_stats" ADD CONSTRAINT "user_daily_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_streaks" DROP CONSTRAINT IF EXISTS "user_streaks_user_id_fkey";
ALTER TABLE "user_streaks" ADD CONSTRAINT "user_streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_curriculum_summary" DROP CONSTRAINT IF EXISTS "user_curriculum_summary_user_id_fkey";
ALTER TABLE "user_curriculum_summary" ADD CONSTRAINT "user_curriculum_summary_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_curriculum_summary" DROP CONSTRAINT IF EXISTS "user_curriculum_summary_subject_id_fkey";
ALTER TABLE "user_curriculum_summary" ADD CONSTRAINT "user_curriculum_summary_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "global_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "tutor_turn_logs" DROP CONSTRAINT IF EXISTS "tutor_turn_logs_user_id_fkey";
ALTER TABLE "tutor_turn_logs" ADD CONSTRAINT "tutor_turn_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "tutor_turn_logs" DROP CONSTRAINT IF EXISTS "tutor_turn_logs_topic_id_fkey";
ALTER TABLE "tutor_turn_logs" ADD CONSTRAINT "tutor_turn_logs_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "global_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "topic_chat_errors" DROP CONSTRAINT IF EXISTS "topic_chat_errors_user_id_fkey";
ALTER TABLE "topic_chat_errors" ADD CONSTRAINT "topic_chat_errors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "topic_chat_errors" DROP CONSTRAINT IF EXISTS "topic_chat_errors_topic_id_fkey";
ALTER TABLE "topic_chat_errors" ADD CONSTRAINT "topic_chat_errors_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "global_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "topic_chat_errors" DROP CONSTRAINT IF EXISTS "topic_chat_errors_chapter_id_fkey";
ALTER TABLE "topic_chat_errors" ADD CONSTRAINT "topic_chat_errors_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "global_chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "topic_chat_sessions" DROP CONSTRAINT IF EXISTS "topic_chat_sessions_user_id_fkey";
ALTER TABLE "topic_chat_sessions" ADD CONSTRAINT "topic_chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "topic_chat_sessions" DROP CONSTRAINT IF EXISTS "topic_chat_sessions_topic_id_fkey";
ALTER TABLE "topic_chat_sessions" ADD CONSTRAINT "topic_chat_sessions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "global_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
