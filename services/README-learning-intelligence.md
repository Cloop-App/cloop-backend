# Cloop Learning Intelligence — implementation notes

This directory now contains the deterministic learning-intelligence core that
Cloop's SLM plugs into, built directly from the Cloop Academic Ontology,
Database Schema, Mastery Engine, and Learning Intelligence Pipeline specs.

## The architectural rule (from every spec document)

> **Cloop should not train the SLM to be the database.** The database /
> knowledge graph represents what is *true* and what is *known about the
> student*. The SLM *reasons over* that state: diagnose, explain, ask, adapt,
> communicate.

So "the Cloop SLM" at MVP is an **orchestrated, constrained model** on top of a
deterministic engine — not a freshly trained neural net. Training a
Cloop-specific SLM is step 10 of the spec's build order, *after* a verified
interaction corpus exists. The corpus is produced by the system below.

```
ACADEMIC GRAPH ─┐
                ├─► LEARNING PIPELINE ─► MASTERY ENGINE ─► state packet ─► SLM ─► dialogue
STUDENT STATE ──┘        (deterministic, auditable)                    (constrained)
```

## What's implemented

| Module | Spec | Responsibility |
|--------|------|----------------|
| `mastery/mastery-engine.js` | Mastery Engine v1.0 | Multidimensional mastery (R/U/A/N/T/F/D), evidence-weighted update, separate uncertainty, retention projection, repetition/hint discounts, prerequisite attribution, immutable mastery events, §29 SLM state packet. Pure/no-I/O. |
| `pipeline/learning-pipeline.js` | Learning Intelligence Pipeline v1.0 | Stages D–I: error detection, misconception confidence (candidate vs promoted), prerequisite diagnosis, gap prioritisation, candidate-action generation + expected-utility selection. Produces the §21 output object. SLM is a single injected, non-fatal stage. |
| `slm/cloop-slm.js` | Ontology §19 / Pipeline §18 | Constrained reasoning/communication layer. Builds guard-railed prompts from the state packet, maps actions to communication goals, guards output against answer leaks. Backed by gpt-4o via `openai.js`; `completion` injectable for offline tests. |
| `seed/seed-loader.js` + `seed/replay.js` | Seed Dataset v1.0 | Loads the vendored pilot dataset (`data/seed/`) and replays every student interaction through the real engine. The specs' step 3–6, done without a DB. |
| `demo-learning-loop.js` | Pipeline §22 | Runnable end-to-end demo (offline). |

## Run it

```bash
npm test                              # 54 offline regression tests (spec worked examples + seed replay)
node services/demo-learning-loop.js   # one full learning-loop turn, offline
node services/seed/replay.js          # replay the whole seed dataset through the engine
```

The tests encode the specs' exact worked numbers — e.g. the mastery update
`0.62 → 0.6713` (positive transfer) and `0.62 → 0.5516` (conceptual error) —
and the §17/§22 decision examples, so any drift from the specification fails
loudly.

## Not yet built (needs decisions — these touch the live DB)

The engine, the seed pilot and its replay are complete and offline. The
remaining layers write to the real Postgres database / ingest the full
knowledge graph, so they were left for an explicit go-ahead:

1. **Prisma schema** for the academic-intelligence tables (concepts,
   prerequisites, questions, errors, misconceptions, interventions,
   interactions, `mastery_states`, `mastery_events`, `training_examples`) — the
   DB Schema spec §4. Adding these means a migration against the live DB.
2. **Knowledge-graph ingestion** of `Cloop_Academic_Knowledge_Graph_v2.0.xlsx`
   (~8,500 concept nodes, CBSE/ICSE/ISC) into those tables.
3. **API endpoints** per the Pipeline §20 contract (`POST /interactions`,
   `POST /diagnose`, `POST /adaptive/next-action`, `GET /students/{id}/mastery`,
   `POST /training/examples`, …) wiring the engine into the Express app.
4. **Training-example capture** — persisting de-identified verified
   interactions as the corpus that a future fine-tuned Cloop SLM trains on.
```
