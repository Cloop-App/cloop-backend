# -*- coding: utf-8 -*-
"""
Cloop tutor prompt QC harness.

Run BEFORE publishing any prompt version. Two stages:

  STAGE 1  STATIC   - invariants on the prompt text itself
                      (contradictions, dangling refs, numbering, labels)
  STAGE 2  DYNAMIC  - simulated sessions on random topics, turn by turn,
                      each turn validated against every mechanical rule
                      the prompt states.

Stage 2 is the one that matters. Reading a prompt tells you what it says;
running a session tells you what it DOES. Every defect shipped so far was
invisible to stage 1 and obvious to stage 2.

usage:  python3 tools/prompt-qc/qc_harness.py
        TUTOR_PROMPT=/path/to/your-prompt.txt python3 tools/prompt-qc/qc_harness.py
exit 0 = safe to publish. exit 1 = do not publish.
"""
import io, re, sys, json, random

import os
PROMPT = os.environ.get(
    "TUTOR_PROMPT",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "tutor-prompt.txt"),
)
T = io.open(PROMPT, encoding="utf-8").read()

FAIL = []
def bad(stage, what, detail=""):
    FAIL.append((stage, what, detail))

# ─────────────────────────────────────────────────────────────
# STAGE 1 — static invariants
# ─────────────────────────────────────────────────────────────
def stage1():
    # every rule/phase/key/block/label the contract promises
    for name, items in [
        ("rules",    ['RULE MINUS-ONE','RULE ZERO','RULE ONE','RULE TWO','RULE THREE','RULE FOUR']),
        ("phases",   ['PHASE 1','PHASE 2','PHASE 3','PHASE 4','PHASE 5','PHASE 6','PHASE 7']),
        ("keys",     ['ai_messages','"feedback"','user_correction','goals_update','session_summary','"evaluation"']),
        ("blocks",   ['hook_prediction','session_frame','exam_definition','deep_dive','concept_card',
                      'score_prediction','exam_question','revision_sheet','text_diagram',
                      'mermaid_diagram','google_image','youtube_video']),
        ("pills",    ["What You'll Learn","Remember This","More On This","Concept Diagram",
                      "Picture","Watch","Concept Card","Revision Sheet"]),
        ("intents",  ['ANSWER','ACK','HELP','NO_ATTEMPT','GIBBERISH','OFF_TOPIC','DISRUPTION']),
        ("archetypes",['Predict','Contrast','Representation','ErrorSpotting','Transfer',
                       'Numerical','ExplainLikeIm5','MisconceptionChk','Recall']),
    ]:
        missing = [i for i in items if i not in T]
        if missing: bad("static", f"{name} missing", ", ".join(missing))

    # retired wording must not survive anywhere
    for dead in ['Write This Down','Write this down','closing invitation','render_as": "attachment']:
        if dead in T: bad("static", "retired wording still present", dead)

    # variables referenced must be declared in the context block
    declared = set(re.findall(r'\{\{([a-zA-Z]+)\}\}', T[T.index('SESSION CONTEXT'):T.index('THE SESSION ARC')]))
    declared |= {'topicTitle','phase','name','placeholder'}
    for v in set(re.findall(r'\{\{([a-zA-Z]+)\}\}', T)):
        if v not in declared: bad("static", "undeclared variable referenced", "{{%s}}" % v)

    # self-check numbering must be gapless
    sc = T[T.index('SELF-CHECK'):]
    nums = re.findall(r'^\s*(\d+)\.', sc, re.M)
    if nums != [str(i) for i in range(1, len(nums)+1)]:
        bad("static", "self-check numbering broken", ",".join(nums))

    # the ladder must be gapless and end in a catch-all
    lad = T[T.index('Check top to bottom'):T.index('RULE THREE COMES FIRST')]
    lnums = re.findall(r'^\s*(\d+)\.', lad, re.M)
    if lnums != [str(i) for i in range(len(lnums))]:
        bad("static", "phase ladder numbering broken", ",".join(lnums))
    if 'Anything else' not in lad: bad("static", "ladder has no catch-all rule")

    # budget arithmetic must close: the per-goal costs must sum to the stated total
    m = re.search(r'EVERY GOAL \.+ EXACTLY (\d+) assessed', T)
    total = int(m.group(1)) if m else None
    costs = sum(int(x) for x in re.findall(r'^\s+(?:HOOK|FRAME|REVEAL|EXPLORE|LOCK)\s+(\d+) assessed', T, re.M))
    if total != costs: bad("static", "budget does not close", f"stated {total}, phases sum to {costs}")
    # ...and the ladder must hand off to LOCK one question BEFORE the total
    m2 = re.search(r'(\d+)\+? assessed questions used this goal', T)
    if not m2 or int(m2.group(1)) != total - 1:
        bad("static", "ladder fires LOCK at the wrong count",
            f"budget {total}, ladder fires at {m2.group(1) if m2 else '?'}")

# ─────────────────────────────────────────────────────────────
# STAGE 2 — simulated sessions
# ─────────────────────────────────────────────────────────────
WORD = re.compile(r"[A-Za-z0-9'’₹%°/-]+")
def words(s): return len(WORD.findall(s))

CORRECTING = ["actually","but ","not quite","the real twist","close, though",
              "in fact","careful —","almost","isn't","doesn't","only slows"]
PRAISE_OPEN = ("right","exactly","correct","good","perfect","yes")
PILL_TALK   = ["open the","tap the","click the","check the card","check the diagram",
               "card below","see below","copy it down","have a look","i've added",
               "written below","read the"]
OPEN_ENDED  = ["any questions","what do you think","does that make sense",
               "tell me about","anything you want","least sure about","any doubts"]
DIAGRAM_SYNTAX = ["```","graph td","graph lr","-->","[","]"]

def check_turn(topic, i, t, state):
    """Validate one emitted turn against every mechanical rule."""
    where = f"{topic} turn {i} ({t['phase']})"
    msgs  = t["ai_messages"]

    # RULE ZERO — length
    if not 1 <= len(msgs) <= 2:
        bad("sim", "bubble count out of range", f"{where}: {len(msgs)}")
    for m in msgs:
        if words(m) > 20:
            bad("sim", "bubble over 20 words", f"{where}: {words(m)}w — {m[:50]}")

    # RULE TWO — last bubble answerable, except the two declared exceptions.
    # Answerable = a question mark, an imperative directive ("name one..",
    # "in one line, explain.."), or an explicit either/or choice.
    IMPERATIVE = ("name ","give ","tell ","explain ","solve ","write ","say ",
                  "type ","pick ","choose ","list ","show ","find ","in one line")
    last = msgs[-1].lower().lstrip()
    answerable = ("?" in msgs[-1]
                  or last.startswith(IMPERATIVE)
                  or any(f" {w} " in last for w in ("or",))
                  or any(k in last for k in IMPERATIVE))
    if t["phase"] not in ("SESSION OVER", "DISRUPTION_END"):
        if not answerable:
            bad("sim", "turn ends with nothing answerable", f"{where}: {msgs[-1][:50]}")
        for o in OPEN_ENDED:
            if o in last:
                bad("sim", "turn ends open-ended", f"{where}: '{o}'")

    # LINK PILLS — never narrated
    for m in msgs:
        for p in PILL_TALK:
            if p in m.lower():
                bad("sim", "bubble narrates a pill", f"{where}: '{p}' in {m[:50]}")

    # VISUALS — no diagram syntax in prose
    for m in msgs:
        if "```" in m or "graph TD" in m or "graph LR" in m or "-->" in m:
            bad("sim", "diagram syntax in a bubble", f"{where}: {m[:50]}")

    # RULE FOUR B — verdict must match the words
    fb = t.get("feedback", {})
    corrects = any(c in " ".join(msgs).lower() for c in CORRECTING) or t.get("diff_html")
    if corrects and fb.get("is_correct") is True:
        bad("sim", "is_correct=true while correcting the student", f"{where}: {msgs[0][:60]}")
    if corrects and msgs[0].lower().lstrip().startswith(PRAISE_OPEN):
        bad("sim", "praise opener on a correcting reply", f"{where}: {msgs[0][:40]}")

    # RULE FOUR A — the asked question must have a correct answer
    if t.get("options") and t.get("correct_option") is None:
        bad("sim", "question has no correct answer among its options", f"{where}: {msgs[-1][:50]}")

    # RULE THREE — non-answers are never scored and never advance
    intent = t.get("input_intent")
    if intent and intent != "ANSWER":
        if fb.get("is_correct") is not None:
            bad("sim", f"{intent} was scored", where)
        if t.get("diff_html"):
            bad("sim", f"{intent} got a strikethrough", where)
        if t.get("assessed_delta", 0) != 0:
            bad("sim", f"{intent} consumed a question from the budget", where)
        if t.get("phase_advanced"):
            bad("sim", f"{intent} advanced the phase", where)

    # HOOK answers are never marked wrong
    if state.get("awaiting") == "hook" and fb.get("is_correct") is False:
        bad("sim", "hook answer marked wrong", where)

    # budget
    state["assessed"] += t.get("assessed_delta", 0)
    if state["assessed"] > 3:
        bad("sim", "goal exceeded 3 assessed questions", f"{where}: {state['assessed']}")
    if t["phase"] == "LOCK2":
        state["assessed"] = 0

def run_session(topic, turns):
    state = {"assessed": 0, "awaiting": None}
    for i, t in enumerate(turns, 1):
        check_turn(topic, i, t, state)
        state["awaiting"] = t.get("awaiting")
    return state

# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    from sessions import SESSIONS          # the simulated transcripts
    stage1()
    pool = list(SESSIONS.items())
    random.seed()
    pool = [(n, s) for n, s in pool if "replay" not in n]
    picked = random.sample(pool, min(3, len(pool)))
    print("QC HARNESS — cloop tutor prompt")
    print(f"prompt: {len(T.splitlines())} lines\n")
    print("STAGE 1  static invariants")
    print("STAGE 2  simulated sessions on: " + ", ".join(n for n, _ in picked) + "\n")
    for name, turns in picked:
        run_session(name, turns)

    # NEGATIVE FIXTURE — a replay of a real shipped bug. The harness must
    # flag it. If this comes back clean, the checks have gone blind and the
    # whole run is worthless.
    before = len(FAIL)
    run_session("REGRESSION FIXTURE", SESSIONS["Metals — replay of live bug"])
    caught = len(FAIL) - before
    del FAIL[before:]
    if caught == 0:
        bad("harness", "regression fixture passed — checks have no teeth",
            "the known Metals bug was not detected")
    else:
        print(f"  regression fixture: {caught} defect(s) caught — checks have teeth\n")

    if FAIL:
        print(f"✗ {len(FAIL)} DEFECT(S) — DO NOT PUBLISH\n")
        for stage, what, detail in FAIL:
            print(f"  [{stage}] {what}")
            if detail: print(f"          {detail}")
        sys.exit(1)
    print("✓ all checks pass — safe to publish")
    sys.exit(0)
