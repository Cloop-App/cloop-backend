# Tutor prompt QC harness

Run this before shipping any change to the AI tutor system prompt.

```bash
python3 tools/prompt-qc/qc_harness.py
```

Exit `0` = safe to publish. Exit `1` = do not publish; the defects are printed.

To check a prompt file other than the vendored one:

```bash
TUTOR_PROMPT=/path/to/your-prompt.txt python3 tools/prompt-qc/qc_harness.py
```

No dependencies, no network, no API calls. Python 3 only.

## Why this exists

Several prompt revisions fixed one thing and silently broke another, and the
breakages were found by students in live sessions. Every one of them was
invisible to re-reading the prompt and obvious the moment a session was played
through it turn by turn.

Reading a prompt tells you what it says. Running a session tells you what it
does.

## What it checks

**Stage 1 — static invariants on the prompt text**

- Every rule, phase, top-level key, block, pill label, input intent and
  question archetype the contract promises is actually present
- Retired wording is gone (a renamed pill label left behind in one place is a
  silent contradiction)
- No `{{variable}}` is referenced that the context block never declares
- Self-check and phase-ladder numbering are gapless, and the ladder ends in a
  catch-all
- **The question budget closes.** The per-phase costs must sum to the stated
  per-goal total, and the ladder must hand off to LOCK exactly one question
  before that total. An off-by-one here shipped once and made every goal run
  33% over its time budget.

**Stage 2 — simulated sessions**

Three sessions on randomly chosen topics, played turn by turn. Each turn is
validated against every mechanical rule the prompt states:

- bubble count and word count per bubble
- the turn ends with something answerable — a question, an imperative
  directive, or an explicit choice — and is not open-ended
- no bubble narrates a pill ("open the card", "check below")
- no diagram syntax in prose
- `is_correct` agrees with the words: a reply containing *actually*, *but*,
  *not quite*, *the real twist* cannot be marked correct, and cannot open with
  "Right" or "Exactly"
- a question with options must have a correct answer among them
- non-answers (`ACK`, `HELP`, `NO_ATTEMPT`, `GIBBERISH`) are never scored,
  never struck through, never consume the question budget, never advance the
  phase
- hook answers are never marked wrong
- the goal never exceeds its assessed-question budget

## The regression fixture

`sessions.py` carries a fourth session that is a replay of a bug that actually
shipped: a question where no option was correct (*"a steel spoon, a plastic
bottle, an iron rod — which is NOT a solid?"*), answered wrongly, and marked
`is_correct: true, score 100%`.

Every run replays it and **requires the checks to flag it**:

```
regression fixture: 3 defect(s) caught — checks have teeth
```

If that fixture ever comes back clean, the run fails as worthless rather than
reporting a false all-clear. A green result from a blind harness is worse than
no harness.

## Adding a case

When a defect is found in a live session, add it to `sessions.py` as a turn in
the relevant session — or as a new session if it is a shape not covered yet —
and add the check that catches it to `check_turn()` in `qc_harness.py`. The
same class of defect then cannot ship twice.

Sessions are written as the model would emit them, not as you wish it would.
Where the prompt is ambiguous, leave the ambiguity in and let the harness fail;
that is the signal that the prompt needs the fix, not the fixture.
