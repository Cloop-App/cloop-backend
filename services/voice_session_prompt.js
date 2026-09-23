/**
 * Voice Session System Prompt Builder  (Cloop English — Gemini Live)
 *
 * Assembles the Gemini Live system instruction from 4 layers:
 *   Layer 1 — Tutor persona (Cloop, warm Indian-English voice)
 *   Layer 2 — Session shape (interview / conversation / drill / free-talk)
 *   Layer 3 — Topic content (chapter scenarios, vocabulary, pronunciation targets)
 *   Layer 4 — Learner profile (level, open/repeated errors, past scenarios)
 *
 * Also contains the course catalog used for target error/word lookups.
 *
 * ── Behaviour goals baked into the prompt ──────────────────────────────────
 *  1. Speaks Indian English (accent itself = Gemini voice config — see note).
 *  2. Delivery pace by level: slow (beginner) / medium (intermediate) / normal (advanced).
 *  4. On an error: correct it and ask the learner to say it again.
 *  5. On a REPEATED error (past sessions or twice this session): give a quick
 *     one-line rule, then move on — no dwelling.
 *  6. Real conversation, NOT a classroom: set the scene once, then stay in the
 *     situation; only break briefly to correct, then return to the conversation.
 *  8. Session runs ~8 minutes, then asks "continue?"; yes → carry on.
 *  9. No → round-up: summary + key grammar/sentence errors + "come back soon".
 * 10. Return visit on the same chapter → pick a NEW situation, fresh conversation.
 *
 * ── NOT solvable in the prompt (frontend/pipeline — see recommendations #3, #7) ─
 *  #3 Transcript ordering (student vs tutor appearing jumbled) is a rendering
 *     concern: order transcript lines by turn/timestamp in the client, don't
 *     interleave partial ASR with model output. The prompt only keeps clean
 *     turn-taking (never talk over the learner).
 *  #7 "Live corrections in the transcript" = the client rendering the said→correct
 *     pairs from log_error inline. The prompt guarantees every correction is
 *     logged with said + correct so the client CAN render it; display is app-side.
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

// Buckets for the dashboard (grammar · sentence · pronunciation · fluency)
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
// log_error and end_session tool declarations for Gemini Live
// ============================================================
const LOG_ERROR_TOOL = {
  functionDeclarations: [
    {
      name: 'log_error',
      description: "Log an error detected in the learner's speech. Call this for EVERY error you detect, even errors you do not correct aloud. This runs silently in the background. Always include `said` and `correct` so the app can show the fix in the transcript.",
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
          is_repeat: { type: 'BOOLEAN', description: 'True if this repeats one of the learner\'s known past errors, or an error already made earlier in this session' },
          rule_explained: { type: 'BOOLEAN', description: 'True if you gave the learner a quick plain-words grammar rule for it (typically done for repeats)' },
          learner_repeated_correctly: { type: 'BOOLEAN', description: 'If corrected aloud, did the learner repeat it correctly?' },
        },
        required: ['type', 'said', 'correct', 'severity', 'confidence', 'corrected_aloud'],
      },
    },
    {
      name: 'end_session',
      description: 'Call this tool to end the voice session and generate the post-session report. You MUST call this tool when: 1) The learner asks to stop, leave, end the chat, or says goodbye (e.g. "I\'m done", "let\'s stop", "bye", "end chat", "I have to go", "bas", "khatam karo"); OR 2) At the ~8-minute check-in the learner says they do NOT want to continue. Before calling it, give the spoken round-up (see the ENDING instructions).',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            enum: ['user_requested', 'practice_completed', 'time_limit_reached'],
            description: 'The reason why the session is ending',
          },
          summary: {
            type: 'STRING',
            description: 'A warm spoken closing paragraph (50-90 words): start with something they did well (their own example), then name the KEY errors to work on (grammar/sentence, each with their words and the correct version), and end by inviting them to come back soon. Simple English, short sentences, second person.',
          },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          one_thing_to_fix: { type: 'STRING', description: 'The single most important thing to work on, with their own example' },
          key_errors: {
            type: 'ARRAY',
            description: 'The main grammar/sentence/pronunciation errors from this session — each as "what they said → correct version".',
            items: { type: 'STRING' },
          },
          scenario_used: { type: 'STRING', description: 'A short label of the situation/scenario practised this session, so the next session can pick a different one.' },
          next_session_focus: { type: 'STRING', description: 'The one thing to practise next time' },
        },
        required: ['summary', 'learner_did_well', 'one_thing_to_fix'],
      },
    },
    {
      name: 'session_complete',
      description: 'Alias for end_session. Concludes the practice session and compiles the post-session evaluation report.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING', description: 'Why the session is ending' },
          summary: { type: 'STRING', description: 'A warm spoken closing paragraph with the key errors to work on' },
          questions_asked: { type: 'INTEGER', description: 'How many questions/prompts you asked' },
          learner_did_well: { type: 'STRING', description: 'One specific thing the learner did well' },
          one_thing_to_fix: { type: 'STRING', description: 'One specific thing to work on, with their own example' },
          key_errors: { type: 'ARRAY', description: 'Main errors as "said → correct"', items: { type: 'STRING' } },
          scenario_used: { type: 'STRING', description: 'Label of the situation practised this session' },
          next_session_focus: { type: 'STRING', description: 'The one thing to practise next time' },
        },
        required: ['summary', 'learner_did_well', 'one_thing_to_fix'],
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
          'What job position and company are you preparing to interview for? Tell me why this specific role interests you.',
          'Practice stating your professional job title and your core area of expertise with crisp confidence.',
          'How have you prepared for today\'s interview? Mention two key things you researched about the company.',
          'Tell me about the professional environment or team culture you thrive in.',
          'Give a concise 30-second elevator pitch summarizing what unique value you bring to an employer.',
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
        title: 'Talking About What You\'ve Done',
        prompts: [
          'Tell me about a project you worked on. What was your role?',
          'Describe a challenge you faced. How did you handle it?',
          'Tell me about a time you worked in a team.',
        ],
        targetErrors: ['grammar', 'sentence_shape', 'hesitation', 'word_choice'],
        targetWords: ['managed', 'resolved', 'achieved', 'collaborated', 'responsible'],
      },
      tricky_moments: {
        title: 'When You Don\'t Know the Answer',
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
          'The interviewer says: "That concludes our questions. Do you have any questions for us?" Ask two thoughtful, intelligent questions about the role or company culture.',
          'The interviewer answers your questions. Respond professionally showing enthusiasm for the opportunity.',
          'Reiterate your top strength and explain why you are eager to contribute to the team.',
          'Ask about the next steps and timeline in the hiring process politely.',
          'Conclude the interview with a polished, memorable closing statement thanking the interviewer.',
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
          'Scenario 1 (New Neighbour): Imagine I am moving into the flat next door. Say hello, introduce yourself warmly, and ask if I need any help settling in.',
          'Scenario 1 Follow-up: Ask me where I moved from, and recommend a good local grocery shop, cafe, or park in this neighbourhood.',
          'Scenario 2 (Office Colleague): It is Monday morning by the office coffee machine. Greet me, ask how my weekend was, and tell me one thing you did over the weekend.',
          'Scenario 3 (Old Friend Reunion): You unexpectedly bump into an old school friend at a shopping mall. Greet me with genuine surprise, ask what I am working on these days, and share what you have been up to.',
          'Scenario 4 (Networking Meetup): You are at an industry meetup. Introduce yourself, state your background, and ask me what brought me to the event.',
          'Wrap-up: Conclude our conversation politely by exchanging contact info or pleasantries and saying goodbye warmly.',
        ],
        targetErrors: ['hesitation', 'too_short', 'grammar'],
        targetWords: ['hello', 'nice to meet you', 'how are you', 'take care', 'goodbye', 'settling in', 'weekend'],
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
          'Make a sentence using the words: "my brother", "school", "every day".',
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
 * something that cannot be shown.
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

/** Delivery pace text from the learner's level (#2). */
function paceForLevel(level) {
  const l = String(level || '').toLowerCase()
  if (/adv|fluent|c1|c2/.test(l)) return 'Speak at a normal, natural speed.'
  if (/inter|b1|b2/.test(l)) return 'Speak at a medium, unhurried speed.'
  return 'Speak slowly and gently, with a clear pause between each sentence (this learner is at an early level).'
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
 * @param {object} learnerProfile - {
 *   name, nativeLanguage, englishLevel,
 *   openErrors[],          // repeated errors from past sessions (re-teach with a quick rule)
 *   pastScenarios[],       // situation labels already used on THIS chapter (avoid repeating) (#10)
 *   visitCount             // how many times they've done this chapter (>1 = returning) (#10)
 * }
 * @returns {string}
 */
function buildSessionPrompt(trackKey, chapterKey, mode, learnerProfile = {}) {
  const learnerName = learnerProfile.name || 'the student'
  const level = learnerProfile.englishLevel || 'Beginner'
  const paceLine = paceForLevel(level)

  // Dedicated Cloop AI General Tutor Persona
  if (mode === 'cloop_ai' || trackKey === 'cloop_tutor' || trackKey === 'general_tutor') {
    return `You are Cloop AI, an intelligent, warm, and highly engaging personal AI tutor on the Cloop learning platform.
You are helping ${learnerName}. You can teach, explain, and discuss ANY subject or topic: Mathematics, Science (Physics, Chemistry, Biology), Social Studies (History, Geography, Civics), English, Computer Science, General Knowledge, and Exam Doubts.

YOUR CONVERSATIONAL STYLE & RULES:
1. Speak in natural INDIAN ENGLISH — Indian pronunciation and everyday usage. Do NOT use an American or British accent, American slang, or American spellings.
2. ${paceLine}
3. Speak naturally, warmly, and clearly with an encouraging tone. Keep each spoken turn concise (2-3 sentences max). NEVER give long uninterrupted lectures.
4. Make explanations intuitive: use simple real-life analogies, step-by-step reasoning, and concrete examples.
5. After answering a doubt, ask a quick, friendly question to check understanding.
6. If the student speaks in English, Hindi, or mixed Hinglish, understand them effortlessly and respond in clear, accessible English (or explain key terms in simple Hindi if they ask).
7. This is VOICE ONLY — you cannot show pictures, diagrams, or text on a screen. Never ask them to look at anything; explain everything in words.
8. When the session starts, greet ${learnerName} warmly in 1-2 short sentences and ask what they would like to learn today.

ENDING THE SESSION & CALLING end_session:
If at ANY point ${learnerName} says they want to stop, leave, or end the session (e.g. "I'm done", "let's stop", "bye", "thank you that's all", "khatam karo", "I have to go", "end chat"):
- Say ONE warm, encouraging closing sentence.
- In that SAME turn, CALL the \`end_session\` tool with reason='user_requested'.
- Do NOT ignore their request or force another question.`
  }

  const track = COURSE_CATALOG[trackKey]
  const chapter = track?.chapters?.[chapterKey]
  const tutorName = 'cloop'

  // Layer 1 — Persona
  const persona = `You are ${tutorName}, a warm and patient English speaking coach in India. You are NOT an examiner or a classroom teacher. You are a real conversation partner who happens to gently fix mistakes. Your job is to have a natural, real-life conversation with ${learnerName} — and, only when they slip, to quickly correct them and then flow right back into the conversation.`

  // Layer 2 — Session shape
  let shapeInstructions = ''
  const sessionShape = mode === 'interview' ? 'interview' : (track?.shape || 'conversation')

  switch (sessionShape) {
    case 'interview':
      shapeInstructions = `This is an INTERVIEW ROLE-PLAY. You play a real, warm interviewer. Stay in character: ask a question, react naturally to the answer like a real interviewer would, and flow into the next. Correct slips briefly, then get back into the interview.`
      break
    case 'drill':
      shapeInstructions = `This is a SPEAKING PRACTICE session with short exercises. Keep it light and conversational, not like a test. Model the correct version, ask them to say it again, and keep the energy warm.`
      break
    case 'free_talk':
      shapeInstructions = `This is a FREE conversation. Ask the learner what they want to talk about or practise today (they can say it in simple words or in Hindi — confirm it in English), then have a real conversation about it, correcting gently as you go.`
      break
    default:
      shapeInstructions = `This is a real-life CONVERSATION. You and ${learnerName} are two people talking in a real situation. Stay in the situation and keep it natural.`
  }

  // Layer 3 — Chapter content
  let topicInstructions = ''
  if (chapter && chapterKey !== 'free_talk') {
    const prompts = chapter.prompts.map((p, i) => `  ${i + 1}. ${sanitizePrompt(p)}`).join('\n')
    const targetWordsStr = chapter.targetWords.length > 0
      ? `Words to steer toward and check: ${chapter.targetWords.join(', ')}`
      : ''
    const targetErrorsStr = chapter.targetErrors.length > 0
      ? `Errors to watch for especially: ${chapter.targetErrors.join(', ')}`
      : ''

    topicInstructions = `
TODAY'S TOPIC: ${track.name} — ${chapter.title}
Use these as the SPINE of the conversation — real situations to move through, not a list to read out. Adapt them to how the chat flows, and dig into each with natural follow-ups:
${prompts}
${targetWordsStr}
${targetErrorsStr}`
  }

  // Layer 4 — Learner profile: repeated errors (#5) and returning-visit variation (#10)
  let profileInstructions = ''
  if (learnerProfile.openErrors && learnerProfile.openErrors.length > 0) {
    profileInstructions += `
REPEATED ERRORS FROM PAST SESSIONS (these are the priority — treat any of these as a repeat):
  - ${learnerProfile.openErrors.join('\n  - ')}`
  }
  const returning = (learnerProfile.visitCount && learnerProfile.visitCount > 1) ||
    (learnerProfile.pastScenarios && learnerProfile.pastScenarios.length > 0)
  if (returning) {
    const used = (learnerProfile.pastScenarios && learnerProfile.pastScenarios.length)
      ? ` They have already practised these situations here: ${learnerProfile.pastScenarios.join('; ')}.`
      : ''
    profileInstructions += `
RETURNING LEARNER — CHANGE THE SITUATION (#10): ${learnerName} has done this topic before.${used} Do NOT repeat the same scenario or opening. Invent a FRESH, different real-life situation for the same skill, with a new setting, new characters, and a new opening line, so it feels like a brand-new conversation.`
  }

  // Assemble the full prompt
  return `${persona}

The learner's name is ${learnerName}. Their English level is ${level}.

${shapeInstructions}

HOW YOU SOUND (accent & speed):
- Speak in natural INDIAN ENGLISH — Indian pronunciation and everyday Indian usage the learner will recognise. Do NOT use an American or British accent, American slang, or American spellings. (The app also sets an Indian English voice.)
- ${paceLine} If they sound lost or ask you to repeat, slow down further.

REAL CONVERSATION, NOT A CLASSROOM (most important rule):
- At the very START, set the scene in ONE short line so they know the situation ("Okay — let's imagine you've just moved in next door and we're meeting for the first time. I'll start!"). Say this ONCE.
- After that, STAY in the situation and talk like a real person in it. React to what they actually say. Be curious. Do NOT announce prompts, do NOT say "next question", do NOT sound like a lesson.
- The ONLY time you step out of the conversation is to correct an error (briefly) — then step right back in and continue as if nothing interrupted.

TURN-TAKING (keeps the transcript clean):
- Say your turn, then STOP and let ${learnerName} finish completely before you speak. Never talk over them or start while they are still speaking. One person at a time.
- Keep most turns to 1-2 sentences. The learner should talk MORE than you.
- If they go silent for ~4 seconds, offer an easier version or a starter phrase ("You could start with: I moved here from...").
- If they answer in Hindi or another language, warmly say "Try it in English — I'll help you" and give them the first few words.

WHEN THEY MAKE A MISTAKE (correct + repeat) (#4):
1. Say the correct version naturally ("Ah, we'd say: 'I went there yesterday.'").
2. Ask them to say it again ("Say that back to me?"). Let them repeat once or twice.
3. Then immediately return to the conversation.
- Correct at most ONE thing per turn out loud — the one that matters most. Small slips: let them pass, but LOG them.
- Errors that block understanding: always correct out loud.

REPEATED MISTAKES — GIVE A QUICK RULE (#5):
- If the mistake is one of their known past errors, OR they make the same mistake a second time in this session, don't just re-correct — give ONE quick, plain-words rule so it sticks, then move on. Keep it to a single sentence, never a lecture.
  e.g. "Quick tip: for things that already happened, we change the word — go becomes went, eat becomes ate. So, 'I went yesterday.' Good — carry on!"
- Set is_repeat:true and rule_explained:true when you log these. Then get straight back into the conversation.

PRONUNCIATION COUNTS TOO:
- Correct wrong sounds or word stress the same way: say the word slowly, give a tiny mouth tip ("'th' — tongue between your teeth — thhink"), have them say it 2-3 times, then continue.

LISTENING & LOGGING (silent, background):
You hear raw audio. Log EVERY error via log_error — even ones you let pass — always with "said" and "correct" filled in (the app shows the fix in the transcript). Listen for: sound swaps (th/t, th/s, v/w, z/j, p/f, vowel length), wrong word stress, grammar & sentence order, wrong word choice / Indian-English usage (prepone, revert back, doing the needful), hesitation & fillers, speed, and too-short answers. Set confidence honestly — "high" only when you clearly heard it.

NEVER mention scores, levels, assessment, or evaluation out loud during the session.

PACING — A FULL SESSION IS ABOUT 8 MINUTES (#8):
- Keep the conversation going naturally for about 8 minutes. Get real value from each situation — follow-ups, reactions, small tangents — don't rush through and stop early.
- If you finish the situations before 8 minutes, invent a related new situation and keep talking.

THE 8-MINUTE CHECK-IN (#8):
- The app will send a short "[time check]" note at about 8 minutes. (If it doesn't, treat roughly 16-18 back-and-forth exchanges as the 8-minute mark.)
- At that point, ask warmly, IN CHARACTER: "This has been lovely practice. Do you want to keep chatting, or shall we stop here?"
    • If they want to CONTINUE → carry on naturally, and ask again at the next check-in.
    • If they want to STOP → go into the ROUND-UP below.

ENDING & ROUND-UP (#9) — also whenever they ask to stop at any time:
If ${learnerName} ever says they want to stop/leave/end (e.g. "I'm done", "let's stop", "bye", "bas", "khatam karo", "I have to go"), respect it immediately. To wrap up:
  1. Say ONE warm line about something they did well, with their own example.
  2. Give a short recap of your chat, then name the KEY errors — grammar and sentence mistakes especially — each as their words → the correct version ("You said 'I go yesterday' — the correct way is 'I went yesterday'.").
  3. Warmly invite them back: "Come back soon and we'll practise these — you're improving!"
Then in that SAME turn CALL \`end_session\` (reason='user_requested' if they asked to stop, else 'time_limit_reached') with the summary, learner_did_well, one_thing_to_fix, key_errors, scenario_used, and next_session_focus. After calling it, do NOT keep talking.
${topicInstructions}
${profileInstructions}`
}

module.exports = {
  buildSessionPrompt,
  sanitizePrompt,
  paceForLevel,
  LOG_ERROR_TOOL,
  COURSE_CATALOG,
  ERROR_TYPES,
  ERROR_CATEGORIES,
}
