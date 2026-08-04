/**
 * Cloop English — personalised curriculum builder.
 *
 * Takes the continuously-updating learner profile (built by the Stage 1
 * diagnostic in cloop_english_prompt.js, including the learner's stated track
 * preferences) and produces a curriculum customised to that one learner: which
 * of the five tracks to include, in what order and depth, expanded into the
 * repo's chapters → topics → goals shape so it persists through the existing
 * content-pipeline.js loop.
 *
 * Output is a SUPERSET of the content-pipeline schema: each track carries the
 * same `chapters` array the pipeline already understands, plus a top-level
 * `curriculum_plan` (the learner-facing "why this path") and an optional
 * `medium` tag per topic (text = Stage 2 foundation, voice = Stage 3 fluency).
 * Extra keys are ignored by the current persistence loop, so it's drop-in.
 */

/**
 * The five tracks are the fixed topic universe. Descriptions ground the model so
 * it builds the right kind of content per track instead of drifting.
 */
const TRACKS = [
  {
    key: "everyday_english",
    name: "Everyday English",
    blurb: "Real-life conversation: greetings, small talk, shopping, directions, phone calls, describing things, telling stories. The base layer of usable fluency.",
  },
  {
    key: "everyday_grammar",
    name: "Everyday Grammar",
    blurb: "The mechanics under everything else: tenses, articles, prepositions, agreement, question forms, plurals. Drilled in context, never as abstract rules.",
  },
  {
    key: "business_english",
    name: "Business English",
    blurb: "Workplace vocabulary and usage: emails, reports, meetings vocabulary, professional phrasing, numbers/schedules, formal vs. informal register.",
  },
  {
    key: "business_communication",
    name: "Business Communication",
    blurb: "Communicating effectively at work: leading and speaking in meetings, presentations, status updates, polite disagreement, negotiation, client and phone handling, giving feedback.",
  },
  {
    key: "interview_prep",
    name: "Interview Prep",
    blurb: "Job-interview performance: self-introduction, 'tell me about yourself', strengths/weaknesses, behavioural (STAR) answers, salary talk, questions to ask, handling tough/unexpected questions.",
  },
];

/**
 * Build the curriculum-generation system prompt for one learner.
 *
 * @param {object} args
 * @param {string} args.userName
 * @param {import('./cloop_english_prompt').LearnerProfile & {
 *   track_preferences?: string[],   // tracks the learner said they want (names or keys)
 * }} args.profile                    // the Stage 1 diagnostic output
 * @returns {string}
 */
function buildCloopEnglishCurriculumPrompt({ userName, profile = {} } = {}) {
  const p = profile || {};
  const trackMenu = TRACKS.map((t) => `- ${t.name}: ${t.blurb}`).join("\n");

  const prefs = Array.isArray(p.track_preferences) && p.track_preferences.length
    ? p.track_preferences.join(", ")
    : "(none stated — infer from goal + weaknesses)";

  const profileBlock = renderProfileForCurriculum(p);

  return `You are Cloop's curriculum architect. Build a personalised English curriculum for ONE learner, ${userName}, from the five fixed tracks below. This is not a generic syllabus — every choice is driven by this learner's diagnostic profile and their stated preferences.

THE FIVE TRACKS (the only topic universe — do not invent others):
${trackMenu}

THIS LEARNER'S PROFILE (from the Stage 1 diagnostic):
${profileBlock}

Stated track preferences: ${prefs}

═══════════════════════════════════════════════════════════════════
HOW TO BUILD THE CURRICULUM
═══════════════════════════════════════════════════════════════════
1. SELECT & PRIORITISE tracks. Honour the learner's stated preferences FIRST — those go near the front and get real depth. Then add any track the diagnostic shows they NEED even if unasked (e.g. weak core grammar → include Everyday Grammar early, because it unblocks the rest), and briefly justify it. If a track is clearly irrelevant to this learner, exclude it and say why. Never pad with all five just to be complete.

2. SEQUENCE by dependency and goal. Foundations that unblock other tracks come first (Everyday Grammar and the weakest core structures before Business Communication or Interview Prep). The track that most directly serves the learner's stated GOAL should be reachable early, not buried at the end.

3. SCALE DEPTH to relevance. A track central to the goal is "deep" (4-6 chapters); a supporting track is "standard" (2-3 chapters); a light-touch track is "light" (1 chapter). Set difficulty from the CEFR band: an A2 learner gets A2→B1 content, not C1.

4. WEAVE THE WEAKNESSES IN. Do not quarantine grammar into one track. Take the learner's weak_language items and make them recurring GOALS inside the situational topics of every track (e.g. drill past tenses inside a Business Communication "status update" topic, and articles inside an Everyday English "at the shop" topic). Their weak_situations should become actual topic titles.

5. TAG THE MEDIUM. Each topic gets "medium": "text" (Stage 2 text-first foundation — use for anything drilling mechanics/accuracy) or "voice" (Stage 3 voice-first fluency — use for live role-play / real-time production). Sequence text topics before their voice counterparts within a track: build it in writing, then automate it out loud.

6. Every topic gets 2-4 concrete, demonstrable learning goals (what the learner can DO after it), and a one-line "content" overview. Goals are mastery checks, not lessons.

═══════════════════════════════════════════════════════════════════
OUTPUT — respond with a VALID JSON object ONLY, in this exact shape:
═══════════════════════════════════════════════════════════════════
{
  "curriculum_plan": {
    "headline": "One warm sentence to the learner naming their path and why it fits their goal",
    "start_here": "Everyday Grammar → Business Communication",
    "selected_tracks": [
      { "track": "Business Communication", "priority": 1, "depth": "deep",
        "target_band": "A2→B1", "why": "Directly serves the stated goal of speaking up in meetings", "requested": true }
    ],
    "excluded_tracks": [
      { "track": "Interview Prep", "why": "Not relevant to this learner's current goal" }
    ]
  },
  "tracks": [
    {
      "track": "Everyday Grammar",
      "priority": 1,
      "chapters": [
        {
          "title": "Chapter title",
          "order": 1,
          "topics": [
            {
              "title": "Topic title (often a real situation from weak_situations)",
              "content": "One-line overview of what this topic practises",
              "order": 1,
              "medium": "text",
              "goals": [
                { "title": "Demonstrable goal", "description": "What the learner can do after this, incl. any woven-in weak structure" }
              ]
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Use the EXACT track names from the five above.
- Order "tracks" by priority. Within a track, order chapters and topics with the "order" field starting at 1.
- Depth controls chapter count: deep = 4-6, standard = 2-3, light = 1. Topics per chapter: 3-5. Goals per topic: 2-4.
- Match difficulty to the learner's band; keep it stress-free and situational.
- Return JSON only — no prose outside the object.`;
}

/**
 * Render the learner profile into the curriculum prompt.
 * @param {object} p
 * @returns {string}
 */
function renderProfileForCurriculum(p) {
  const has = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";
  const lines = [];
  if (has(p.age)) lines.push(`- Age: ${p.age}`);
  if (has(p.occupation)) lines.push(`- Occupation / study: ${p.occupation}`);
  if (has(p.goal)) lines.push(`- Stated goal: ${p.goal}`);
  if (has(p.band) || has(p.cefr)) lines.push(`- Level: ${[p.band, p.cefr].filter(has).join(" / ")}`);
  if (has(p.strengths)) lines.push(`- Strengths: ${p.strengths.join(", ")}`);
  if (has(p.weak_language)) lines.push(`- Weak (language): ${p.weak_language.join(", ")}`);
  if (has(p.weak_situations)) lines.push(`- Weak (situations): ${p.weak_situations.join(", ")}`);
  if (has(p.situation_focus)) lines.push(`- Situation focus: ${p.situation_focus.join(", ")}`);
  return lines.length ? lines.join("\n") : "- (sparse profile — lean on stated preferences and sensible defaults)";
}

module.exports = { buildCloopEnglishCurriculumPrompt, TRACKS };
