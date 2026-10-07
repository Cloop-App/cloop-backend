-- Link a concept to the curriculum topic it belongs to.
--
-- The academic tables are keyed by stable code strings and carry no foreign
-- keys, so they can be ingested in any order. That decoupling is deliberate and
-- kept — this is a plain nullable id, not a relation. But without it there is
-- no way to ask "what is this topic meant to teach", so the 1,055 concepts,
-- their objectives and their difficulties could not reach a student.
--
-- Additive and idempotent.

ALTER TABLE "academic_concepts" ADD COLUMN IF NOT EXISTS "curriculum_topic_id" INTEGER;
CREATE INDEX IF NOT EXISTS "idx_academic_concepts_topic" ON "academic_concepts" ("curriculum_topic_id");
