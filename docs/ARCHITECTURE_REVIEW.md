# Cloop Backend — Architecture Review

**Scope:** Failure points and latency in the **writing (normal-chat)** and **topic-chat** features, plus the shared services they depend on.
**Repo:** `Cloop-App/cloop-backend` · **Reviewed:** 2026-09-22
**Audience:** Vivek & Ninad — engineering triage.

Severity: **P0** = user-visible failures / data loss · **P1** = latency & reliability · **P2** = correctness/cleanup.

---

## TL;DR — the five things to fix first

1. **LLM calls are blocking and non-streaming** — every chat turn waits for the *entire* model response before the user sees anything. This is the single biggest latency cause. → stream tokens. **(P0/P1)**
2. **Full chat history is reloaded and re-sent every turn** — unbounded for topic-chat, 50 msgs for normal-chat. Prompts (and latency, and cost) grow forever. → window + summarize. **(P1)**
3. **JSON-mode fallback silently drops the correction/feedback** — when GPT-4o returns non-JSON, the learner gets plain text with no error tagging or goals. This is very likely the "topic chat doesn't talk about errors / fails" report. → schema validate + retry. **(P0)**
4. **No timeouts or retries on OpenAI calls** — a slow/hung API call blocks the request thread and surfaces as a generic 500. → AbortController timeout + one retry. **(P0/P1)**
5. **Background job processor has no locking / stuck-job recovery** — races on multi-instance, and jobs stuck in `processing` are never retried. → status transition guard + requeue. **(P1)**

---

## 1. Latency

### 1.1 Blocking, non-streaming completions **(P0/P1)**
`services/openai.js` awaits the full response; routes then `await chatCompletion(...)` before replying.
- `services/topic_chat.js:110` (`processMessage`), `:207` (`processOption`)
- `api/normal-chat/normal-chat.js:76`
- `services/topic_chat_learn_more.js`

**Effect:** the user stares at a spinner for the whole generation (often 3–8s on GPT-4o). Perceived latency ≈ full completion time.
**Fix:** stream via SSE or WebSocket (`stream: true`), flush tokens as they arrive. For the JSON topic-chat contract, stream the human-visible `ai_messages` text and send the structured fields (feedback/correction/goals) at the end.

### 1.2 Whole history reloaded & re-sent every turn **(P1)**
- `services/topic_chat.js:75` loads **all** messages for the topic/user (no `take`), maps them all into the prompt (`:102`).
- `api/normal-chat/normal-chat.js:53` loads `take: 50` and re-sends every turn.

**Effect:** prompt size grows with the conversation → slower + more expensive on every single turn; eventually hits context limits and errors. This compounds 1.1.
**Fix:** cap to the last N turns (e.g. 10–15), and/or keep a rolling summary of older turns. Persist a `summary` per session and prepend it instead of raw history.

### 1.3 Sequential DB round-trips that could be parallel/batched **(P1)**
In `services/topic_chat.js`:
- `processMessage` does `findUnique(topic)` → `findUnique(user)` → `findMany(history)` **serially** (`:63`, `:72`, `:75`); the topic + user + history are independent and could be `Promise.all`.
- AI messages are inserted **one await at a time in a loop** (`:127-138`); use `createMany` (or a single transaction).
- `trackGoalProgress` (`learning_turns_tracker.js`) then issues **two more** queries (`findMany` goals + `findFirst` latest chat + `update`).

**Effect:** ~6–8 serial DB round-trips per message on top of the LLM call.
**Fix:** parallelize independent reads, `createMany` the AI messages, fold goal tracking into the same transaction.

### 1.4 No timeout / retry / cancellation on OpenAI **(P0/P1)**
`services/openai.js` has no `timeout`, no `AbortController`, no retry. A hung upstream call blocks the request until the socket dies and returns a generic 500 (see §2.1).
**Fix:** pass a timeout (e.g. 20–30s) + `maxRetries`, and abort if the client disconnects.

### 1.5 Missing indexes for the hot query **(P1)**
Every turn filters `topicChat` by `{ topic_id, user_id }` ordered by `created_at`. Confirm a **composite index `(topic_id, user_id, created_at)`** exists in `prisma/schema.prisma` (and `(user_id, created_at)` for normal-chat); without it these are full scans that worsen as history grows.

---

## 2. Failure points — writing (normal-chat) & topic-chat

### 2.1 Errors collapse into an opaque 500 **(P0)**
Route `catch` blocks log and return `{ error: "Internal server error." }` (e.g. `normal-chat.js:88`, `topic-chats` route). OpenAI failures, JSON parse issues, and DB errors all look identical to the client → "the chat just failed."
**Fix:** distinguish upstream-timeout / rate-limit / validation from server errors; return a retriable status and a user-facing "try again" where safe.

### 2.2 JSON-mode fallback silently degrades the turn **(P0)**
`services/topic_chat.js:112-123`: if `JSON.parse` fails, it wraps the raw text and sets `feedback:null`, `user_correction:null`, `goals_update:[]`, `session_summary:null`.
**Effect:** the learner gets a plain reply with **no correction, no feedback, no goal progress** — exactly the "tutor doesn't point out errors" complaint, and it fails invisibly.
**Fix:** validate against the expected schema; on failure, **retry once** with a "return valid JSON only" nudge before falling back. Log parse failures with the raw output to measure how often this fires.

### 2.3 User turn persisted before the AI call — dangling turns on failure **(P0/P2)**
`topic_chat.js:81` saves the user message, then calls OpenAI (`:110`). If the call throws, the user message is **already committed** with no AI reply. Next request reloads history with a dangling user turn → the model may double-answer or get confused.
**Fix:** save the user message and AI reply in one transaction after a successful generation, or mark/clean up orphaned user turns.

### 2.4 Goal completion math is wrong **(P2, correctness)**
`learning_turns_tracker.js:22-25`: `completionPercent` = `completedGoals.length / totalGoals`, where `completedGoals` is only **this turn's** updates — not cumulative across the session. Completion % therefore reflects one message, not real progress, and can jump/reset.
Also `loadTopicChat` (`topic_chat.js:48-53`) hardcodes every goal `completed:false` with a comment "will be computed from chat history" — it never is. Goals always render incomplete on load.
**Fix:** track goal state cumulatively (persist per-goal completion), and compute load-time status from it.

### 2.5 Session-summary path trusts model-supplied fields **(P2)**
`topic_chat.js:146-161` + `topic_chat_metrics.js`: metrics (score, stars, error types) come straight from the model's `session_summary`. If the model omits/!miscomputes them, the report is wrong or zeroed. Add server-side validation/derivation for the numeric fields.

### 2.6 No per-user concurrency guard **(P2)**
Two quick messages from the same user interleave history reads/writes; the second call may not see the first's AI reply. Consider a per-(user,topic) lock or optimistic ordering.

---

## 3. Background content generation

`services/background-processor.js` + `content-pipeline.js` + `curriculum-auto-trigger.js`.

### 3.1 No locking / at-least-once races **(P1)**
`processNextJob` `findFirst({status:'pending'})` then later sets `processing` **inside** `generateSubjectContent` (`content-pipeline.js:26`). Between the poll and the status write there's a window where a second worker (or the immediate `processNextJob()` on start plus the interval) can pick the **same** job. There's no atomic claim.
**Fix:** atomically claim with a conditional update (`updateMany where status='pending' ... set 'processing'` and check count), or a DB advisory lock / queue.

### 3.2 Stuck jobs are never retried **(P1)**
If the process restarts mid-job, the job is left in `processing` forever — the poller only looks for `pending`. No visibility timeout.
**Fix:** requeue `processing` jobs older than N minutes; add an attempts counter and a dead-letter state.

### 3.3 Whole curriculum is one giant LLM call **(P1)**
`content-pipeline.js:32-62` asks for 5–8 chapters × topics × goals in a single completion, then persists in nested loops (`:65-95`, another N+1 of `create`s). This is slow, prone to truncation/timeout, and all-or-nothing.
**Fix:** generate per-chapter (smaller calls, resumable), and `createMany`/transaction the writes.

### 3.4 Polling every 10s **(P2)**
`setInterval(processNextJob, 10_000)` adds up-to-10s latency before a job starts and runs a query even when idle. Fine for now; revisit with a real queue (BullMQ/pg-boss) if volume grows.

---

## 4. Cross-cutting

- **No request timeouts at the Express layer** — a stuck upstream call ties up a connection indefinitely. Add a server/route timeout.
- **No structured logging / request IDs** — failures are `console.error` only; hard to correlate a user's failed turn. Add a logger with request/user IDs.
- **Secrets/config** — `OPENAI_API_KEY` read directly; fine, but centralize model name/timeouts in one config so latency knobs live in one place.
- **Model choice** — everything runs on `gpt-4o` at `temperature 0.7` (`openai.js:17`). For short beginner-chat turns a faster/cheaper model (e.g. `gpt-4o-mini`) may cut latency materially for normal-chat; keep 4o where the structured contract needs it. Worth an A/B.

---

## Suggested order of work

| # | Item | Sev | Effort |
|---|------|-----|--------|
| 1 | Stream chat responses (topic-chat + normal-chat) | P0/P1 | M |
| 2 | JSON-mode: validate + retry-once + log failures | P0 | S |
| 3 | OpenAI timeout + retry + client-abort | P0/P1 | S |
| 4 | Save user+AI turn in one transaction (fix dangling turns) | P0 | S |
| 5 | Window/summarize history instead of full reload | P1 | M |
| 6 | Parallelize reads + `createMany` writes + confirm indexes | P1 | S–M |
| 7 | Background jobs: atomic claim + stuck-job requeue | P1 | M |
| 8 | Fix goal-completion math + load-time goal status | P2 | S |
| 9 | Per-chapter curriculum generation | P1 | M |

*Findings are from static reading of the current branch; line references may shift as code changes. Nothing here has been modified — this is analysis only.*
