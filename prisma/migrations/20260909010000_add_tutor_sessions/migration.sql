-- A session entity for the tutoring loop.
--
-- Production had none. Nothing tied a run of admin_chat messages to a topic,
-- and there was nowhere to keep the state machine between turns, so `chat_id`
-- came to mean "one chat message": chat_goal_progress holds 2,209 rows
-- covering 137 goals, one per message, 32% of them recording no question at
-- all. Read on the real (user, goal) grain the pilot had 187 pairs and 67%
-- completion, not the 41% those rows suggested.
--
-- Additive: admin_chat gains one nullable column, so the 2,076 existing rows
-- keep NULL and nothing that reads them changes behaviour.

CREATE TABLE IF NOT EXISTS "tutor_sessions" (
    "id"           SERIAL       NOT NULL,
    "user_id"      INTEGER      NOT NULL,
    "topic_id"     INTEGER      NOT NULL,
    "state"        JSONB        NOT NULL,
    "is_active"    BOOLEAN      NOT NULL DEFAULT true,
    "ended_reason" VARCHAR(30),
    "started_at"   TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "ended_at"     TIMESTAMP(6),
    "updated_at"   TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "tutor_sessions_user_id_topic_id_idx" ON "tutor_sessions" ("user_id", "topic_id");
CREATE INDEX IF NOT EXISTS "tutor_sessions_user_id_is_active_idx" ON "tutor_sessions" ("user_id", "is_active");

ALTER TABLE "tutor_sessions" DROP CONSTRAINT IF EXISTS "fk_tutor_sessions_user";
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "fk_tutor_sessions_user"
    FOREIGN KEY ("user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "tutor_sessions" DROP CONSTRAINT IF EXISTS "fk_tutor_sessions_topic";
ALTER TABLE "tutor_sessions" ADD CONSTRAINT "fk_tutor_sessions_topic"
    FOREIGN KEY ("topic_id") REFERENCES "global_topics" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Scope a chat message to its session.
ALTER TABLE "admin_chat" ADD COLUMN IF NOT EXISTS "session_id" INTEGER;

ALTER TABLE "admin_chat" DROP CONSTRAINT IF EXISTS "fk_admin_chat_session";
ALTER TABLE "admin_chat" ADD CONSTRAINT "fk_admin_chat_session"
    FOREIGN KEY ("session_id") REFERENCES "tutor_sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "idx_admin_chat_session" ON "admin_chat" ("session_id");
