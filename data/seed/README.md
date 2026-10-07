# Cloop Seed Dataset v1.0

This is a compact synthetic pilot for validating the Cloop ontology/database architecture.

Scope:
- CBSE Classes 10–11
- Mathematics + Physics
- Illustrative JEE Main mapping

It contains concepts, prerequisites, learning outcomes, questions, errors, misconceptions,
interventions, student interactions, mastery states and SLM training examples.

IMPORTANT: This is synthetic pilot data, not an official CBSE/JEE dataset. Production deployment
requires permitted source ingestion, curriculum mapping, human/automated verification and versioning.

Recommended next engineering step:
1. Load these records into PostgreSQL.
2. Build the concept/prerequisite graph.
3. Replay the interaction records.
4. Implement mastery updates.
5. Implement error/misconception detection.
6. Implement adaptive next-action selection.
7. Use verified examples to build the first SLM evaluation set.
