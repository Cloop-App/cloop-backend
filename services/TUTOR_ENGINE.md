# Cloop Tutoring Engine

A mastery-driven academic tutor that delivers the learning experience described
in *Closing the Learning Gap*: it converses through everyday examples, corrects
errors against the curriculum, explains concepts, proactively surfaces diagrams /
videos / images, and predicts a score per learning goal.

## Why the previous prompt drifted

The earlier implementation asked a single `gpt-4o` call at `temperature 0.7` to
**grade and converse at the same time**. LLMs are agreeable, so it:

- affirmed wrong answers ("Correct!") and "corrected" answers that were already right,
- re-asked questions and produced fuzzy, non-reproducible scores,
- never surfaced any diagram / video / image (the schema didn't carry them).

## The fix: separate *judging*, *flow*, and *talking*

```
student answer
      │
      ▼
┌──────────────────────┐   Stage 1 — grounded grading (low temperature)
│  answer_grader.js     │   judges the answer against the topic's curriculum
│  + cloop_prompt.js    │   content; normalizeGrade() enforces is_correct from
└──────────┬───────────┘   the sub-scores so "Correct!" can't be faked.
           ▼
┌──────────────────────┐   Deterministic state machine (plain JS, no LLM)
│  session_state.js     │   owns phase (concept→exam), per-goal scoring, the
│                       │   concept→exam→predict_score→next-goal flow, technique
└──────────┬───────────┘   rotation, and the no-repeat question list.
           ▼
┌──────────────────────┐   Stage 2 — render the turn
│  tutor_turn.js        │   given the grade + the decided next step, produces the
│  + media_resolver.js  │   chat bubbles, the next question, and ONE proactive
└──────────┬───────────┘   visual aid. It cannot change the score or the flow.
           ▼
   tutor_engine.runTutorTurn()  ── pure, returns rows-to-persist + rich response
           ▼
   topic_chat.js  ── thin Prisma adapter (the only file that touches the DB)
```

### Guarantees this produces

- **Grounded grading.** Correctness is decided against curriculum text and then
  reconciled in JS (`normalizeGrade`), so a wrong answer is never affirmed.
- **Auto-continue.** Every non-final turn ends with a question; the engine
  synthesises one if the model forgets.
- **No repeats.** Asked questions are reconstructed from history and passed to
  Stage 2, with a normalisation backstop.
- **Mastery flow.** Concept questions repeat until clarity ≥ 0.80 (cap 3), then
  2–3 exam questions, then `predicted_score = concept*50 + exam*50`.
- **Proactive, teacher-driven media.** The student never asks for visuals. Media
  appears in exactly two situations and is stripped everywhere else (openers,
  correct answers, the exam phase, goal hops):
  - **Confusion** (a wrong/unclear answer → a `recheck_understanding` turn): a
    teaching diagram and/or short explainer video/image to make the idea click.
  - **Session complete:** optional *further-learning* resources — a YouTube
    video plus an `internet_link` (notes/article) for the topic and weak goals.
    No diagram at the wrap-up.
  The tutor prompt forbids "I can't share…" phrasing and forbids telling the
  student to ask — the tutor decides and provides.

## Files

| File | Responsibility |
|------|----------------|
| `cloop_prompt.js` | Stage-1 grader & Stage-2 tutor system prompts |
| `answer_grader.js` | Stage 1: grade + normalise (academic guardrails) |
| `session_state.js` | Deterministic flow, scoring, technique rotation |
| `tutor_turn.js` | Stage 2: render bubbles + next question + media |
| `media_resolver.js` | `search_query` → working YouTube/Google URLs |
| `tutor_engine.js` | Pure orchestration (no DB) — fully unit-testable |
| `topic_chat.js` | Prisma persistence adapter + HTTP shaping |
| `topic_chat_metrics.js` | Aggregate per-goal predictions into a report |

## Response shape (per turn)

```jsonc
{
  "evaluation": { "question_mode", "concept_clarity_score", "understanding_status",
                  "next_step_type", "technique" },
  "messages": [ { "message", "message_type" } ],
  "user_correction": { "diff_html", "complete_answer", "emoji", "feedback": {…} } | null,
  "mermaid_diagram"?: {…}, "text_diagram"?: {…},
  "youtube_video"?: {…}, "google_image"?: {…},
  "score_prediction"?: { "goal_id", "concept_score", "exam_score", "predicted_score" }
}
```

## Testing

The engine is provider-agnostic — `openai.js` is the single seam, and the grader
and tutor accept injectable LLM callers. The suite runs fully offline with mock
LLMs (no DB, no API key):

```bash
npm test   # 24 checks: grounded grading, auto-continue, no-repeats,
           # media gating, mastery flow, score consistency
```
