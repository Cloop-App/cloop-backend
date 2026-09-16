-- Indexes for learning_turns.
--
-- The table carried none at all, so every pilot query — per student, per
-- session, per goal — was a sequential scan.
--
-- The pipeline's own audit trail (phase, directive, intent, escalation depth)
-- is not here: it lives in tutor_turn_logs, added later in this migration set.
-- Recording it in both places would give one turn two descriptions that could
-- disagree.
--
-- Additive only: no column is added, altered or dropped, so this applies to
-- the live pilot database without touching the rows already there.

CREATE INDEX IF NOT EXISTS "idx_learning_turns_user_created" ON "learning_turns" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_learning_turns_chat" ON "learning_turns" ("chat_id");
CREATE INDEX IF NOT EXISTS "idx_learning_turns_goal" ON "learning_turns" ("goal_id");
