# -*- coding: utf-8 -*-
"""
Simulated tutor sessions, written by following the prompt as the model
would — including the places where the prompt tempts you to cheat.

Each turn is what the model WOULD emit. The harness validates them.
Written honestly: where the prompt is ambiguous, the ambiguity is left in
so the harness catches it rather than being papered over here.
"""

# ── SESSION A — Science 8, Friction. Clean path, conceptual. ────────────
FRICTION = [
 dict(phase="HOOK", assessed_delta=1, awaiting="hook", input_intent=None,
      ai_messages=["Your cycle stops quicker on gravel than on smooth road. What's doing the stopping?"]),

 dict(phase="FRAME", assessed_delta=0, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["You said the stones. It's the roughness between tyre and road doing the work.",
                   "Guess first — does a heavier rider stop faster or slower?"]),

 dict(phase="REVEAL1", assessed_delta=0, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["Faster, yes. More weight presses the surfaces together harder.",
                   "So what happens on wet road, where a water film gets between them?"]),

 dict(phase="REVEAL2", assessed_delta=1, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["Right, the film keeps them apart and grip drops.",
                   "Name one place on a cycle where you want MORE friction, not less."]),

 dict(phase="EXPLORE", assessed_delta=0, input_intent="ANSWER",
      feedback=dict(is_correct=True, bubble_color="green", score_percent=100),
      ai_messages=["Brakes — exactly the case. That's friction working for you.",
                   "In one line, explain friction to a younger student."]),

 dict(phase="LOCK1", assessed_delta=1, awaiting=None, input_intent="ANSWER",
      feedback=dict(is_correct=True, bubble_color="green", score_percent=90),
      ai_messages=["Good — you got the two surfaces and the opposing part.",
                   "New one: why does a matchstick light when you strike it?"]),
]

# ── SESSION B — Maths 8, Linear Equations. Numerical shape. ─────────────
EQUATIONS = [
 dict(phase="HOOK", assessed_delta=1, awaiting="hook", input_intent=None,
      ai_messages=["Three samosas and ₹10 change from ₹100. What does one samosa cost?"]),

 dict(phase="FRAME", assessed_delta=0, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["You said ₹30 — spot on, and you did it without algebra.",
                   "Today we write that same guess as an equation. Ready to name the unknown?"]),

 dict(phase="REVEAL1", assessed_delta=0, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["Call it x. Your sum was 3x + 10 = 100, solved in your head.",
                   "What do we do to both sides first — subtract 10, or divide by 3?"]),

 dict(phase="REVEAL2", assessed_delta=1, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["Subtract first, yes. That leaves 3x = 90.",
                   "Solve this one: 5y - 8 = 27. What is y?"]),

 dict(phase="EXPLORE", assessed_delta=0, input_intent="ANSWER",
      diff_html="<del>y = 3.8</del><ins>y = 7</ins>",
      feedback=dict(is_correct=False, bubble_color="red", score_percent=40,
                    error_type="Calculation Error"),
      ai_messages=["Careful — you divided before adding the 8 back.",
                   "Add 8 to both sides first. What does 5y equal now?"]),

 dict(phase="LOCK1", assessed_delta=1, input_intent="ANSWER",
      feedback=dict(is_correct=True, bubble_color="green", score_percent=100),
      ai_messages=["35, so y is 7. That's the order that matters.",
                   "In one line, tell a younger student how to start any equation."]),
]

# ── SESSION C — Science 10, Chemical Reactions. Messy student. ──────────
CHEMICAL = [
 dict(phase="HOOK", assessed_delta=1, awaiting="hook", input_intent=None,
      ai_messages=["A cut apple goes brown in an hour. Wrapped in plastic, it stays pale. Why?"]),

 dict(phase="FRAME", assessed_delta=0, input_intent="NO_ATTEMPT",
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["No problem — most people guess plastic keeps it cold.",
                   "It's air, actually. Is it the whole air, or one gas in it?"]),

 dict(phase="REVEAL1", assessed_delta=0, input_intent="ACK", phase_advanced=False,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["So — the whole air, or one gas in it?"]),

 dict(phase="REVEAL1", assessed_delta=0, input_intent="HELP", phase_advanced=False,
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["Air is a mix. One part of it reacts with the apple's flesh.",
                   "Which gas do you breathe in and rust needs — oxygen or nitrogen?"]),

 dict(phase="REVEAL2", assessed_delta=1, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=True, bubble_color="green", score_percent=100),
      ai_messages=["Oxygen. Block it and the reaction stops.",
                   "Browning makes a brand-new substance. Name one other sign of a reaction."]),

 dict(phase="EXPLORE", assessed_delta=0, input_intent="GIBBERISH",
      feedback=dict(is_correct=None, bubble_color="default"),
      ai_messages=["I couldn't read that — it came through as 'sdlkfj'.",
                   "Think of a burning match: gas, heat or light — name one."]),

 dict(phase="LOCK1", assessed_delta=1, input_intent="ANSWER",
      feedback=dict(is_correct=True, bubble_color="green", score_percent=95),
      ai_messages=["Heat, yes. Colour change, gas and heat are the three.",
                   "In one line, tell a younger student what a chemical reaction is."]),
]

# ── SESSION D — the live failure, replayed. Should be caught. ───────────
METALS = [
 dict(phase="HOOK", assessed_delta=1, awaiting="hook", input_intent=None,
      options=["steel spoon", "plastic bottle", "iron rod"], correct_option=None,
      ai_messages=["A steel spoon, a plastic bottle, an iron rod. Which is NOT a solid?"]),

 dict(phase="FRAME", assessed_delta=0, input_intent="ANSWER", phase_advanced=True,
      feedback=dict(is_correct=True, bubble_color="green", score_percent=100),
      ai_messages=["Right — all three are solids at room temperature.",
                   "The real twist is that almost every metal is solid. Which one isn't?"]),
]

SESSIONS = {
    "Friction (Sci 8)":          FRICTION,
    "Linear Equations (Math 8)": EQUATIONS,
    "Chemical Reactions (Sci 10)": CHEMICAL,
    "Metals — replay of live bug": METALS,
}
