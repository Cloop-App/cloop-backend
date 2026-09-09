-- Tutor-core instrumentation for learning_turns.
--
-- The pilot could report that 70.8% of answers were correct but not which
-- phase of the session arc the student was in, which teaching directive
-- produced the turn, how the evaluator classified the message, or how far
-- down the escalation ladder a stuck student had been taken. These five
-- columns are what makes a session auditable after the fact.
--
-- Additive only: every statement is idempotent and no existing column is
-- altered or dropped, so this applies to the live pilot database without a
-- reset and without touching the 534 rows already there. Existing rows keep
-- NULL for the three text columns, which is the honest value — those turns
-- were produced by the single-prompt tutor, which never computed them.

ALTER TABLE "learning_turns" ADD COLUMN IF NOT EXISTS "phase" VARCHAR(20);
ALTER TABLE "learning_turns" ADD COLUMN IF NOT EXISTS "directive" VARCHAR(50);
ALTER TABLE "learning_turns" ADD COLUMN IF NOT EXISTS "intent" VARCHAR(20);
ALTER TABLE "learning_turns" ADD COLUMN IF NOT EXISTS "escalation_step" INTEGER DEFAULT 0;
ALTER TABLE "learning_turns" ADD COLUMN IF NOT EXISTS "turn_number" INTEGER DEFAULT 0;

-- Indexes for the per-student, per-session and per-goal reads the analytics
-- need. learning_turns carried no indexes at all, so every pilot query was a
-- sequential scan.
CREATE INDEX IF NOT EXISTS "idx_learning_turns_user_created" ON "learning_turns" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_learning_turns_chat_turn" ON "learning_turns" ("chat_id", "turn_number");
CREATE INDEX IF NOT EXISTS "idx_learning_turns_goal" ON "learning_turns" ("goal_id");
CREATE INDEX IF NOT EXISTS "idx_learning_turns_phase" ON "learning_turns" ("phase");
