-- Provenance for the curriculum catalog.
--
-- The catalog had no way to say where a chapter came from, so an LLM-generated
-- syllabus and one reconciled against a board document were indistinguishable
-- in the database. These columns make that difference queryable: `verified` is
-- true only where the source was actually reconciled, and NULL provenance
-- means generated.
--
-- Additive and idempotent.

ALTER TABLE "global_subjects" ADD COLUMN IF NOT EXISTS "source_authority"   VARCHAR(150);
ALTER TABLE "global_subjects" ADD COLUMN IF NOT EXISTS "source_year"        VARCHAR(50);
ALTER TABLE "global_subjects" ADD COLUMN IF NOT EXISTS "official_source"    TEXT;
ALTER TABLE "global_subjects" ADD COLUMN IF NOT EXISTS "curriculum_version" VARCHAR(30);
ALTER TABLE "global_subjects" ADD COLUMN IF NOT EXISTS "is_test_prep"       BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "global_chapters" ADD COLUMN IF NOT EXISTS "unit"                  VARCHAR(200);
ALTER TABLE "global_chapters" ADD COLUMN IF NOT EXISTS "source_node_id"        VARCHAR(60);
ALTER TABLE "global_chapters" ADD COLUMN IF NOT EXISTS "reconciliation_status" VARCHAR(40);
ALTER TABLE "global_chapters" ADD COLUMN IF NOT EXISTS "verified"              BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "global_topics" ADD COLUMN IF NOT EXISTS "derivation_status" VARCHAR(80);
ALTER TABLE "global_topics" ADD COLUMN IF NOT EXISTS "verified"          BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_global_subjects_test_prep" ON "global_subjects" ("is_test_prep");
CREATE INDEX IF NOT EXISTS "idx_global_chapters_verified" ON "global_chapters" ("verified");
CREATE INDEX IF NOT EXISTS "idx_global_topics_verified"   ON "global_topics" ("verified");
