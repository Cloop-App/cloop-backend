-- The academic-intelligence layer.
--
-- These ten tables back /api/learning and services/mastery: the verified
-- academic graph (concepts, prerequisites, questions, error types,
-- misconceptions, interventions) and the per-student state the Mastery Engine
-- v8 and the Learning Intelligence Pipeline operate over. Production has none
-- of them, so every route under /api/learning fails against it today.
--
-- Per the schema spec's privacy rule these records are keyed by a pseudonymous
-- `student_key` and are deliberately NOT foreign-keyed to the identity `users`
-- table; entities reference each other by stable `code` strings so ingestion
-- is order-free and a concept can be loaded before its prerequisites.
--
-- Purely additive: nothing here touches an existing table, so it is safe to
-- apply to the live pilot database.

-- CreateTable
CREATE TABLE IF NOT EXISTS "academic_concepts" (
    "concept_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "class_level" INTEGER,
    "description" TEXT,
    "concept_type" TEXT,
    "difficulty_band" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_concepts_pkey" PRIMARY KEY ("concept_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "concept_prerequisites" (
    "id" TEXT NOT NULL,
    "concept_code" TEXT NOT NULL,
    "prerequisite_code" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidence_source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_prerequisites_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "academic_questions" (
    "question_id" TEXT NOT NULL,
    "code" TEXT,
    "subject" TEXT NOT NULL,
    "question_type" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "cognitive_level" TEXT,
    "question_text" TEXT NOT NULL,
    "correct_answer" TEXT,
    "solution" TEXT,
    "concept_codes" TEXT[],
    "verification_status" TEXT NOT NULL DEFAULT 'GENERATED',
    "source_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_questions_pkey" PRIMARY KEY ("question_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "academic_error_types" (
    "error_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subtype" TEXT,
    "description" TEXT,
    "severity" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "academic_error_types_pkey" PRIMARY KEY ("error_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "misconceptions" (
    "misconception_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "concept_code" TEXT,
    "canonical_statement" TEXT,
    "incorrect_belief" TEXT,
    "correct_model" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "misconceptions_pkey" PRIMARY KEY ("misconception_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "interventions" (
    "intervention_id" TEXT NOT NULL,
    "code" TEXT,
    "type" TEXT NOT NULL,
    "instructional_goal" TEXT,
    "content_template" TEXT,
    "difficulty" INTEGER,
    "targets" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("intervention_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "learning_interactions" (
    "interaction_id" TEXT NOT NULL,
    "student_key" TEXT NOT NULL,
    "session_id" TEXT,
    "question_code" TEXT,
    "concept_code" TEXT,
    "interaction_type" TEXT NOT NULL DEFAULT 'QUESTION_RESPONSE',
    "student_response" TEXT,
    "student_reasoning" TEXT,
    "correctness" TEXT,
    "time_taken_seconds" INTEGER,
    "student_confidence" DOUBLE PRECISION,
    "error_labels" JSONB,
    "misconception_candidates" JSONB,
    "pipeline_output" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_interactions_pkey" PRIMARY KEY ("interaction_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "mastery_states" (
    "id" TEXT NOT NULL,
    "student_key" TEXT NOT NULL,
    "concept_code" TEXT NOT NULL,
    "identification_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "explanation_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "representation_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "application_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error_diagnosis_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transfer_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stability_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overall_mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mastery_level" TEXT NOT NULL DEFAULT 'Emerging',
    "uncertainty" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "prerequisite_gate_open" BOOLEAN NOT NULL DEFAULT false,
    "last_assessed_at" TIMESTAMP(3),
    "model_version" TEXT NOT NULL DEFAULT 'mastery-v8',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mastery_states_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "mastery_events" (
    "mastery_event_id" TEXT NOT NULL,
    "student_key" TEXT NOT NULL,
    "concept_code" TEXT NOT NULL,
    "interaction_id" TEXT,
    "mastery_before" DOUBLE PRECISION,
    "mastery_after" DOUBLE PRECISION,
    "dimension_updates" JSONB,
    "evidence" JSONB,
    "diagnosis" JSONB,
    "update_reason" TEXT,
    "model_version" TEXT NOT NULL DEFAULT 'mastery-v8',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_events_pkey" PRIMARY KEY ("mastery_event_id")
);
-- CreateTable
CREATE TABLE IF NOT EXISTS "training_examples" (
    "training_example_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "input_context" JSONB NOT NULL,
    "student_state" JSONB,
    "academic_context" JSONB,
    "expected_reasoning" JSONB,
    "expected_output" JSONB,
    "labels" JSONB,
    "quality_score" DOUBLE PRECISION,
    "annotation_status" TEXT NOT NULL DEFAULT 'SYNTHETIC',
    "split" TEXT NOT NULL DEFAULT 'TRAIN',
    "source_interaction_ids" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_examples_pkey" PRIMARY KEY ("training_example_id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "academic_concepts_code_key" ON "academic_concepts"("code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "academic_concepts_subject_idx" ON "academic_concepts"("subject");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "academic_concepts_canonical_name_idx" ON "academic_concepts"("canonical_name");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "concept_prerequisites_concept_code_idx" ON "concept_prerequisites"("concept_code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "concept_prerequisites_prerequisite_code_idx" ON "concept_prerequisites"("prerequisite_code");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "concept_prerequisites_concept_code_prerequisite_code_key" ON "concept_prerequisites"("concept_code", "prerequisite_code");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "academic_questions_code_key" ON "academic_questions"("code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "academic_questions_subject_difficulty_idx" ON "academic_questions"("subject", "difficulty");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "academic_error_types_code_key" ON "academic_error_types"("code");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "misconceptions_code_key" ON "misconceptions"("code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "misconceptions_concept_code_idx" ON "misconceptions"("concept_code");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "interventions_code_key" ON "interventions"("code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "learning_interactions_student_key_created_at_idx" ON "learning_interactions"("student_key", "created_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "learning_interactions_question_code_idx" ON "learning_interactions"("question_code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "mastery_states_student_key_idx" ON "mastery_states"("student_key");
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mastery_states_student_key_concept_code_key" ON "mastery_states"("student_key", "concept_code");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "mastery_events_student_key_concept_code_created_at_idx" ON "mastery_events"("student_key", "concept_code", "created_at");
-- CreateIndex
CREATE INDEX IF NOT EXISTS "training_examples_task_type_split_annotation_status_idx" ON "training_examples"("task_type", "split", "annotation_status");
