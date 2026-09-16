/**
 * Voice Session System Prompt Builder  (Cloop English — Gemini Live)
 *
 * Assembles the Gemini Live system instruction from 4 layers:
 *   Layer 1 — Tutor persona (cloop, warm Indian-English voice)
 *   Layer 2 — Session shape (interview / conversation / drill / free-talk)
 *   Layer 3 — Topic content (chapter prompts, vocabulary, pronunciation targets)
 *   Layer 4 — Learner profile (level, open/past errors, history)
 *
 * Also contains the course catalog used for target error/word lookups.
 *
 * v2 fixes (from live-session feedback):
 *   1. Voice-only — never references on-screen images (rule + sanitizePrompt()).
 *   2. Length — PACING block enforces a 7–10 min session; session_complete is
 *      gated behind coverage + teaching + a minimum number of exchanges.
 *   3/4. Teaching — the tutor corrects, explains the rule in plain words, and has
 *      the learner repeat; past (open) errors are re-surfaced and re-taught.
 *   5. Ending — a proper spoken round-up + richer session_complete payload
 *      (things to practise, next-session focus).
 *   6. Pronunciation — corrected out loud (sound + stress), in every session.
 */

// ============================================================
// 10-type error taxonomy (from platform-design-v2.md Part 5A.3)
// ============================================================
const ERROR_TYPES = [
  'sound_swap',       // sink → think, wery → very
  'word_stress',      // PREsent vs preSENT
  'grammar',          // I am having two years experience
  'word_choice',      // I did my graduation → I graduated
  'sentence_shape',   // Why you are calling? → Why are you calling?
  'hesitation',       // Long pauses, umm, restarts, actually actually
  'speed',            // Too fast or too slow
  'too_short',        // One-word answers where three sentences were needed
  'indian_english',   // prepone, revert back, doing the needful
  'unclear',          // Trailing off, mumbling sentence endings
]

// Buckets the 10 types into the 4 areas the dashboard highlights.
// (grammar · sentence · pronunciation · fluency)
const ERROR_CATEGORIES = {
  sound_swap: 'pronunciation',
  word_stress: 'pronunciation',
  grammar: 'grammar',
  word_choice: 'grammar',
  indian_english: 'grammar',
  sentence_shape: 'sentence',
  too_short: 'sentence',
  hesitation: 'fluency',
  speed: 'fluency',
  unclear: 'fluency',
}

// ============================================================
// Tool declarations for Gemini Live
// ============================================================
const LOG_ERROR_TOOL = {
  functionDeclarations: [
    {
      name: 'log_error',
      description:
        "Log an error detected in the learner's speech. Call this for EVERY error you detect, even errors you do not correct aloud. This runs silently in the background — the learner does not see it.",
      parameters: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: ERROR_TYPES,
            description: 'The error category from the 10-type taxonomy',
          },
          said: { type: 'STRING', description: 'What the learner actually said' },
          correct: { type: 'STRING', description: 'The correct English version' },
          target_word: { type: 'STRING', description: 'The specific word with the error, if applicable' },
          detail: { type: 'STRING', description: 'Technical detail: e.g. "produced /s/ in place of /θ/"' },
          severity: {
            type: 'STRING',
            enum: ['blocks_understanding', 'sounds_non_native', 'minor'],
            description: 'How much this error affects communication',
          },
          confidence: {
            type: 'STRING',
            enum: ['high', 'medium', 'low'],
            description: 'How confident you are that this is genuinely an error. Use "high" only when you clearly heard it.',
          },
          corrected_aloud: { type: 'BOOLEAN', description: 'Whether you corrected this error aloud to the learner in this turn' },
          rule_explained: { type: 'BOOLEAN', description: 'Whether you also gave the learner a short, plain-words reason/rule for the fix' },
          is_repeat: { type: 'BOOLEAN', description: 'True if this is a repeat of one of the learner\'s known open errors from a past session' },
          learner_repeated_correctly: { type: 'BOOLEAN', description: 'If corrected aloud, did the learner repeat it correctly?' },
        },
        required: ['type', 'said', 'correct', 'severity', 'confidence', 'corrected_aloud'],
      },
    },
    {
      name: 'session_complete',
      description:
        'Call this ONLY when the session is truly finished — you have covered every chapter prompt, taught at least 3 errors out loud, had at least 12 back-and-forth exchanges, and given the spoken round-up. Do NOT call this early. This ends the session.',
      parameters: {
        type: 'OBJECT',
        properties: {
          summary: {
            type: 'STRING',
            description:
              'A warm spoken round-up, 70-110 words. Start with one thing they did well (their own example). Then name the 2-3 main things to work on, each with THEIR mistake and the correct version. End with what to practise before next time. Simple English, short sentences, second person. Never use: elaboration, proficiency, articulation, coherence, demonstrate, utilize.',
          },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          exchanges: { type: 'INTEGER', description: 'Roughly how many back-and-forth turns the session had' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          things_to_fix: {
            type: 'ARRAY',
            description: 'The 2-3 main things to work on. Each item: the learner\'s own mistake and the correct version, in plain words.',
            items: { type: 'STRING' },
          },
          pronunciation_notes: { type: 'STRING', description: 'Any specific sounds or word-stress to keep practising (or empty if none)' },
          repeated_errors_seen: {
            type: 'ARRAY',
            description: 'Which known open/past errors showed up again this session (empty if none).',
            items: { type: 'STRING' },
          },
          next_session_focus: { type: 'STRING', description: 'The one clear thing to focus on and practise in the next session' },
        },
        required: ['summary', 'questions_asked', 'learner_did_well', 'things_to_fix', 'next_session_focus'],
      },
    },
  ],
}

// ============================================================
// Course catalog — tracks, chapters, target errors, target words
// ============================================================
const COURSE_CATALOG = {
  interview_prep: {
    name: 'Practice for a Job Interview',
    shape: 'interview',
    chapters: {
      getting_ready: {
        title: 'Getting Ready',
        prompts: [
          'What job are you applying for? Tell me the company name and the role.',
          'Say the company name and your role clearly and confidently.',
        ],
        targetErrors: ['hesitation', 'unclear', 'too_short'],
        targetWords: ['interview', 'position', 'company', 'application', 'opportunity'],
      },
      telling_about_yourself: {
        title: 'Telling Them About Yourself',
        prompts: [
          'Tell me about yourself — your name, where you are from, and what you do.',
          'Tell me about your education. Where did you study?',
          'What are your strengths? Name two or three things you are good at.',
        ],
        targetErrors: ['grammar', 'hesitation', 'too_short', 'sentence_shape'],
        targetWords: ['completed', 'graduated', 'experience', 'strength', 'skilled'],
      },
      common_questions: {
        title: 'The Questions Everyone Asks',
        prompts: [
          'Why do you want this job?',
          'What are your strengths and weaknesses?',
          'Where do you see yourself in five years?',
          'Why should we hire you?',
        ],
        targetErrors: ['grammar', 'word_choice', 'indian_english', 'too_short'],
        targetWords: ['because', 'although', 'improve', 'contribution', 'growth'],
      },
      talking_about_experience: {
        title: "Talking About What You've Done",
        prompts: [
          'Tell me about a project you worked on. What was your role?',
          'Describe a challenge you faced. How did you handle it?',
          'Tell me about a time you worked in a team.',
        ],
        targetErrors: ['grammar', 'sentence_shape', 'hesitation', 'word_choice'],
        targetWords: ['managed', 'resolved', 'achieved', 'collaborated', 'responsible'],
      },
      tricky_moments: {
        title: "When You Don't Know the Answer",
        prompts: [
          'I am going to ask you something hard. If you do not know the answer, just say so politely.',
          'Why did you leave your last job?',
          'There is a gap in your work history. Can you explain it?',
        ],
        targetErrors: ['hesitation', 'unclear', 'too_short', 'grammar'],
        targetWords: ['unfortunately', 'honestly', 'opportunity', 'transition', 'currently'],
      },
      finishing_well: {
        title: 'Finishing Well',
        prompts: [
          'The interview is ending. Do you have any questions for me?',
          'How would you end this interview on a good note?',
        ],
        targetErrors: ['too_short', 'hesitation', 'word_choice'],
        targetWords: ['appreciate', 'looking forward', 'thank you', 'opportunity', 'follow up'],
      },
    },
  },

  everyday_english: {
    name: 'Talk to People Every Day',
    shape: 'conversation',
    chapters: {
      saying_hello: {
        title: 'Saying Hello',
        prompts: [
          'Imagine I am your new neighbour. Say hello and introduce yourself.',
          'Ask me how I am doing today.',
          'Now end this short chat politely.',
        ],
        targetErrors: ['hesitation', 'too_short', 'grammar'],
        targetWords: ['hello', 'nice to meet you', 'how are you', 'take care', 'goodbye'],
      },
      talking_with_friends: {
        title: 'Talking with Friends',
        prompts: [
          'Invite me to watch a movie this weekend.',
          'I cannot come. Suggest another plan.',
          'Say no to my plan politely without hurting my feelings.',
        ],
        targetErrors: ['grammar', 'word_choice', 'hesitation'],
        targetWords: ['together', 'instead', 'unfortunately', 'maybe', 'sounds good'],
      },
      at_home: {
        title: 'At Home',
        prompts: [
          'Tell me about your day today. What happened?',
          'Ask an elder in your family how they are feeling today.',
          'Tell me how you feel right now — happy, tired, worried?',
        ],
        targetErrors: ['grammar', 'sentence_shape', 'word_choice'],
        targetWords: ['today', 'feeling', 'tired', 'worried', 'happened'],
      },
      meeting_new_people: {
        title: 'Meeting New People',
        prompts: [
          'You are at a party. Introduce yourself to someone you have never met.',
          'The person tells you they are from another city. Make small talk about it.',
          'Give the person a compliment about something they said.',
        ],
        targetErrors: ['hesitation', 'too_short', 'word_choice', 'grammar'],
        targetWords: ['pleasure', 'interesting', 'wonderful', 'originally', 'lovely'],
      },
      casual_work_chat: {
        title: 'At Work, Not About Work',
        prompts: [
          'It is lunch break. Ask your colleague about their weekend.',
          'Your colleague has a birthday. Wish them.',
          'It is a festival today. Wish your team.',
        ],
        targetErrors: ['grammar', 'indian_english', 'word_choice'],
        targetWords: ['weekend', 'birthday', 'congratulations', 'festival', 'celebrations'],
      },
      opinions_and_situations: {
        title: 'Saying What You Think',
        prompts: [
          'I think cricket is boring. What do you think?',
          'I disagree with you. Tell me why you think I am wrong, politely.',
          'There was a small misunderstanding between us. Fix it.',
        ],
        targetErrors: ['sentence_shape', 'word_choice', 'grammar'],
        targetWords: ['opinion', 'disagree', 'however', 'misunderstanding', 'apologize'],
      },
    },
  },

  grammar_sentences: {
    name: 'Make Correct Sentences',
    shape: 'drill',
    chapters: {
      building_a_sentence: {
        title: 'Building a Sentence',
        prompts: [
          // Voice-only: imagination prompt, not an on-screen picture.
          'Imagine a boy reading a book in a park. Describe it to me — what is he doing, what is around him?',
          'Tell me three things you can see around you right now.',
          'Make a sentence using these words: "my brother", "school", "every day".',
        ],
        targetErrors: ['grammar', 'sentence_shape'],
        targetWords: ['a', 'an', 'the', 'is', 'are'],
      },
      talking_about_now: {
        title: 'Talking About Now',
        prompts: [
          'What do you like to eat? Tell me about your favourite food.',
          'What are you doing right now?',
          'Tell me about your daily routine — what do you do every morning?',
        ],
        targetErrors: ['grammar'],
        targetWords: ['like', 'have', 'goes', 'does', 'every day'],
      },
      before_and_later: {
        title: 'Before and Later',
        prompts: [
          'What did you do yesterday? Tell me your whole day.',
          'What are you going to do this weekend?',
          'Tell me a short story about something funny that happened to you.',
        ],
        targetErrors: ['grammar', 'word_choice'],
        targetWords: ['went', 'ate', 'saw', 'will', 'going to'],
      },
      asking_questions: {
        title: 'Asking Questions',
        prompts: [
          'You want to know my name and where I work. Ask me.',
          'Ask me what I did last weekend.',
          'I said something you did not understand. Ask me to repeat it.',
        ],
        targetErrors: ['sentence_shape', 'grammar'],
        targetWords: ['do', 'does', 'did', 'what', 'where', 'when', 'why', 'how'],
      },
      joining_ideas: {
        title: 'Joining Your Ideas',
        prompts: [
          'Tell me why you like your favourite movie. Use "because".',
          'Tell me two things: one you like and one you do not like about your city.',
          'Where do you keep your phone? Use "in", "on", or "at".',
        ],
        targetErrors: ['grammar', 'sentence_shape'],
        targetWords: ['because', 'but', 'so', 'in', 'on', 'at'],
      },
      longer_sentences: {
        title: 'Longer Sentences',
        prompts: [
          'What should a student do to get a good job? Use "should" or "must".',
          'Compare two cities you know. Which is bigger? Which is better?',
          'Tell me something using: "Although it was difficult, I..."',
        ],
        targetErrors: ['grammar', 'indian_english', 'sentence_shape'],
        targetWords: ['should', 'must', 'could', 'bigger', 'better', 'although'],
      },
    },
  },

  pronunciation: {
    name: 'Say Words Clearly',
    shape: 'drill',
    chapters: {
      sounds_of_english: {
        title: 'The Sounds of English',
        prompts: [
          'Say these words slowly: ship, sheep, sit, seat.',
          'Say these words: van, wine, vest, west.',
          'Now say: bat, bet, bit, but, boot.',
        ],
        targetErrors: ['sound_swap'],
        targetWords: ['ship', 'sheep', 'van', 'wine', 'sit', 'seat', 'vest', 'west'],
      },
      hard_sounds: {
        title: 'The Hard Sounds',
        prompts: [
          'Say these words with the "th" sound: think, three, thank you, this, that.',
          'Say these words: very, west, voice, water, village, winner.',
          'Say these words with silent letters: know, hour, honest, write, knife.',
        ],
        targetErrors: ['sound_swap'],
        targetWords: ['think', 'three', 'thank', 'this', 'that', 'very', 'voice', 'know', 'hour', 'honest'],
      },
      word_stress: {
        title: 'Which Part of the Word is Loud',
        prompts: [
          'Say these words and stress the right part: PREsent (gift) vs preSENT (to give).',
          'Say: PHOtograph, phoTOGrapher, photoGRAPHic.',
          'Say these commonly mispronounced words: development, comfortable, vegetable.',
        ],
        targetErrors: ['word_stress'],
        targetWords: ['present', 'photograph', 'photographer', 'development', 'comfortable', 'vegetable'],
      },
      sentence_stress: {
        title: 'Which Word in the Sentence is Loud',
        prompts: [
          'Say this sentence stressing different words: "I did not say he stole the money."',
          'Say: "I want an apple" — link "an" and "apple" together.',
          'Read this at a natural speed: "I went to the market and bought some vegetables."',
        ],
        targetErrors: ['word_stress', 'speed'],
        targetWords: ['apple', 'market', 'vegetables', 'money'],
      },
      intonation: {
        title: 'Going Up and Going Down',
        prompts: [
          'Ask me: "Are you coming tomorrow?" — make your voice go up at the end.',
          'Say: "I finished my work." — make your voice go down at the end.',
          'Say "Thank you" politely. Now say it like you are annoyed.',
        ],
        targetErrors: ['sound_swap', 'unclear'],
        targetWords: ['tomorrow', 'finished', 'thank you'],
      },
      clarity_confidence: {
        title: 'Speaking So People Understand',
        prompts: [
          'Read this slowly and clearly: "The quick brown fox jumps over the lazy dog."',
          'Tell me about your morning in four sentences. Speak slowly.',
          'Say the hardest English word you know, and say it three times.',
        ],
        targetErrors: ['speed', 'unclear'],
        targetWords: [],
      },
    },
  },

  free_practice: {
    name: 'Practice Anything You Want',
    shape: 'free_talk',
    chapters: {
      free_talk: {
        title: 'Free Conversation',
        prompts: [],
        targetErrors: [],
        targetWords: [],
      },
    },
  },
}

// ============================================================
// Helpers
// ============================================================

/**
 * Voice-only safety net: rewrite any prompt that references an on-screen image
 * into an imagination prompt, so the tutor never asks the learner to look at
 * something that can't be shown.
 */
function sanitizePrompt(text) {
  if (!text) return text
  if (/\b(this|that|the)\s+(picture|image|photo|photograph|screen|diagram|slide)\b/i.test(text) || /\blook at\b/i.test(text)) {
    return text
      .replace(/describe\s+this\s+(picture|image|photo|photograph)\s*:?\s*/i, 'Imagine this and describe it to me: ')
      .replace(/\b(this|that|the)\s+(picture|image|photo|photograph|screen|diagram|slide)\b/gi, 'what you imagine')
      .replace(/\blook at\b/gi, 'imagine')
  }
  return text
}

// ============================================================
// System prompt builder
// ============================================================

/**
 * Build the full system prompt for a Gemini Live voice session.
 *
 * @param {string} trackKey - e.g. 'interview_prep'
 * @param {string} chapterKey - e.g. 'telling_about_yourself'
 * @param {string} mode - 'practice' | 'interview' | 'free_talk' | 'cloop_ai'
 * @param {object} learnerProfile - { nativeLanguage, englishLevel, openErrors[], name }
 * @returns {string}
 */
function buildSessionPrompt(trackKey, chapterKey, mode, learnerProfile = {}) {
  const learnerName = learnerProfile.name || 'the student'

  // Dedicated Cloop AI General Tutor Persona
  if (mode === 'cloop_ai' || trackKey === 'cloop_tutor' || trackKey === 'general_tutor') {
    return `You are Cloop AI, an intelligent, warm, and highly engaging personal AI tutor on the Cloop learning platform.
You are helping ${learnerName}. You can teach, explain, and discuss ANY subject or topic: Mathematics, Science (Physics, Chemistry, Biology), Social Studies (History, Geography, Civics), English, Computer Science, General Knowledge, and Exam Doubts.

YOUR CONVERSATIONAL STYLE & RULES:
1. Speak naturally, warmly, and clearly with an encouraging tone.
2. Keep each spoken turn concise (2-3 sentences max). NEVER give long uninterrupted lectures.
3. Make explanations intuitive: use simple real-life analogies, step-by-step reasoning, and concrete examples.
4. Encourage interactive learning: after answering a doubt or explaining a concept, ask a quick, friendly question to check their understanding.
5. This is VOICE ONLY — you cannot show pictures, diagrams, or text on a screen. Never ask the learner to look at anything; explain everything in words.
6. If the student speaks in English, Hindi, or mixed Hinglish, understand them effortlessly and respond in clear, accessible English (or explain key terms in simple Hindi if they ask for it).
7. When the session starts, greet ${learnerName} warmly in 1-2 short sentences and ask what they would like to learn or ask today.
8. This is a real-time live voice conversation. Listen carefully, be supportive, and make learning exciting!`
  }

  const track = COURSE_CATALOG[trackKey]
  const chapter = track?.chapters?.[chapterKey]
  const tutorName = 'cloop'
  const level = learnerProfile.englishLevel || 'Beginner'

  // Layer 1 — Persona
  const persona = `You are ${tutorName}, a warm and patient English speaking coach in India. You speak with a calm, encouraging tone. You are NOT an examiner. You are a practice partner and a teacher — your job is to help ${learnerName} SPEAK more and, when they slip, to teach them the fix so they leave knowing what to work on.`

  // Layer 2 — Session shape
  let shapeInstructions = ''
  const sessionShape = mode === 'interview' ? 'interview' : (track?.shape || 'conversation')

  switch (sessionShape) {
    case 'interview':
      shapeInstructions = `This is an INTERVIEW PRACTICE session. You are playing the role of a job interviewer. Ask the interview questions one at a time, listen to the answer, coach the fix, then ask a natural follow-up before the next question. Be realistic but warm.`
      break
    case 'drill':
      shapeInstructions = `This is a PRACTICE DRILL session. You give the learner exercises and prompts. They practise speaking. You model the correct version, explain the fix in one simple line, and ask them to repeat it until it is right.`
      break
    case 'free_talk':
      shapeInstructions = `This is a FREE PRACTICE session. Ask the learner what they want to practise today. They can say it in simple words. Then adapt — become a role-play partner, a conversation partner, or a drill coach based on what they need. If they say a topic in Hindi or any Indian language, confirm it in English and start.`
      break
    default:
      shapeInstructions = `This is a CONVERSATION PRACTICE session. You are having a natural conversation with the learner about real-life situations. Keep it realistic and warm, and coach the fixes as you go.`
  }

  // Layer 3 — Chapter content
  let topicInstructions = ''
  if (chapter && chapterKey !== 'free_talk') {
    const prompts = chapter.prompts.map((p, i) => `  ${i + 1}. ${sanitizePrompt(p)}`).join('\n')
    const targetWordsStr = chapter.targetWords.length > 0
      ? `Pronunciation target words to steer toward and check: ${chapter.targetWords.join(', ')}`
      : ''
    const targetErrorsStr = chapter.targetErrors.length > 0
      ? `Target errors to watch for especially: ${chapter.targetErrors.join(', ')}`
      : ''

    topicInstructions = `
THIS SESSION: ${track.name} — ${chapter.title}
Prompts to cover (adapt them naturally, don't read them robotically). Go through EVERY one, and spend 2-4 back-and-forths on each:
${prompts}
${targetWordsStr}
${targetErrorsStr}`
  }

  // Layer 4 — Learner profile (past/open errors to re-teach)
  let profileInstructions = ''
  if (learnerProfile.openErrors && learnerProfile.openErrors.length > 0) {
    profileInstructions = `
PAST MISTAKES TO REMEMBER (from earlier sessions — watch for these and re-teach them if they come up again):
  - ${learnerProfile.openErrors.join('\n  - ')}
When one of these shows up again, point it out warmly ("This one came up last time too — remember, we say ___"), teach it again, and set is_repeat:true when you log it.`
  }

  // Assemble the full prompt
  return `${persona}

The learner's name is ${learnerName}. Their English level is ${level}.

${shapeInstructions}

YOU ARE VOICE-ONLY:
- You cannot show or share pictures, images, photos, text, diagrams, or anything on a screen.
- NEVER ask the learner to look at or describe something on screen. If a prompt sounds like it needs a picture, make it imagination: "Imagine a boy reading in a park — describe it to me."

HOW YOU SPEAK:
- Keep most turns short (1-2 sentences): ask, then STOP and listen. The learner should talk MORE than you.
- When you TEACH a fix, you may take up to 3 short sentences: the correct version, one simple reason, then "say it".
- If they go silent for 4 seconds, ask an easier version or give them a starter phrase ("You can start with: I went to...").
- If they answer in Hindi or another language, gently say "Try it in English — I'll help you" and give them the first few words.
- NEVER mention scores, levels, assessment, or evaluation out loud during the session.

TEACH — DON'T JUST CHAT (this is the whole point):
The learner must finish the session KNOWING what they got wrong and how to fix it. Do not just talk and end. For each error you correct out loud:
  1. Say the correct version clearly.
  2. Give ONE simple reason in plain, everyday words — like a friend, never a textbook.
     e.g. "It already happened, so we say 'went', not 'go'."  ·  "One person eats, many people eat."  ·  "For a question we put the doing-word first: 'Are you...?' not 'You are...?'"
  3. Ask them to say the correct version. Have them repeat until it's right (max 2 tries, then "we'll come back to that" and move on).
- You may use everyday words (before/after, now, one/many, question word, doing-word). Do NOT use jargon ("past tense", "article", "preposition", "auxiliary").
- Correct at most ONE thing per turn out loud, but always the one that matters most.

PRONUNCIATION COUNTS TOO (not only grammar):
- When you hear a wrong sound or wrong stress, correct it out loud, in any session:
    - Say the word slowly and clearly.
    - Give a tiny mouth tip: "'th' — put your tongue between your teeth — thhhink."  ·  "v — top teeth on bottom lip — very."
    - Have them say it 2-3 times until clearer.
- Watch the target words above especially. Log every sound_swap and word_stress, even small ones.

LISTENING & LOGGING (silent, background — separate from correcting):
You hear raw audio, not a transcript. Listen for ALL of these and log EVERY one via log_error, even the ones you let pass without correcting aloud:
  - sound swaps: th/t, th/s, v/w, z/j, p/f, and vowel length
  - word stress on the wrong syllable
  - grammar and sentence order
  - wrong word choice, including Indian-English (prepone, revert back, doing the needful)
  - hesitation, fillers (um, uh, actually actually), restarts
  - speaking too fast, too slow, too quietly, or trailing off
  - answers too short for the question
Set confidence honestly — use "high" ONLY when you clearly heard it. Set rule_explained:true when you gave the plain-words reason, and is_repeat:true for a known past error.
Correction rule: small errors → let them pass (but LOG them). Errors that block understanding OR are repeats of past errors → correct and teach out loud.

PACING — MAKE THE SESSION LAST 7-10 MINUTES (very important — do NOT end early):
- Go slowly and get value from every prompt. For EACH prompt: ask it → listen → correct & teach one thing → have them repeat → ask ONE natural follow-up about their answer → then move on. That is 2-4 back-and-forths per prompt, not one.
- Do NOT call session_complete until ALL of these are true:
    1. You have covered EVERY prompt in this chapter.
    2. You have corrected AND taught (with a reason + a repeat) at least 3 errors out loud.
    3. You have had at least 12 back-and-forth exchanges with the learner.
    4. You have re-surfaced at least one past/open error, if any were listed.
- If you run out of prompts before that, KEEP GOING: ask a harder version, re-drill a word or sound they missed, or ask them to say a full answer again more clearly. Never end just because you finished the list.

ENDING — DO A PROPER SPOKEN ROUND-UP (never skip this):
Only once every PACING condition above is met, wrap up over your last few turns:
  1. Say ONE thing they did well, with their own example.
  2. Tell them the 2-3 main things to work on — each using THEIR mistake and the correct version ("You said 'I go yesterday' — practise 'I went yesterday'.").
  3. Tell them the ONE thing to practise before the next session.
Then IMMEDIATELY call session_complete with the full round-up (summary, things_to_fix, pronunciation_notes, repeated_errors_seen, next_session_focus). After calling it, do NOT continue talking.
${topicInstructions}
${profileInstructions}`
}

module.exports = {
  buildSessionPrompt,
  sanitizePrompt,
  LOG_ERROR_TOOL,
  COURSE_CATALOG,
  ERROR_TYPES,
  ERROR_CATEGORIES,
}
