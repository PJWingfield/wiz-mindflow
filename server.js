// ── WIZ Mind Flow Server ─────────────────────────────────────────────────────
// Secure API proxy for the WIZ coaching agent
// Keeps your Anthropic API key private on the server
// Deploy to Railway, Render, or any Node.js host

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const port = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',   // lock down to your domain in production
  methods: ['GET', 'POST'],
}));

// Serve the frontend HTML
app.use(express.static(path.join(__dirname, 'public')));

// ── Simple in-memory rate limiter (no Redis needed for beta) ─────────────────
const rateLimits = new Map();
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 50;             // 50 messages per hour per IP — generous for coaching

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_WINDOW;
  }

  record.count++;
  rateLimits.set(ip, record);

  if (record.count > MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Too many messages. Please take a break and come back in an hour.',
      retryAfter: Math.ceil((record.resetAt - now) / 1000 / 60) + ' minutes'
    });
  }

  next();
}

// ── Simple session log (in-memory for beta, swap for DB later) ───────────────
const sessions = new Map();

function logSession(sessionId, turn, role, content) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, turns: [], createdAt: new Date().toISOString() });
  }
  sessions.get(sessionId).turns.push({
    turn, role, content: content.substring(0, 500), // truncate for log
    timestamp: new Date().toISOString()
  });
}

// ── WIZ System Prompt ────────────────────────────────────────────────────────
const WIZ_SYSTEM = `You are WIZ, the Mind Flow AI coaching companion built on 35 years of PJ Wingfield's Mind Flow methodology. You work for Mind Flow International Ltd (mindflowpro.com).

YOUR IDENTITY:
- You are warm, energising, direct, and genuinely curious about the person in front of you
- You speak in PJ Wingfield's coaching voice: encouraging but never preachy, science-grounded but human, always possibility-focused
- You are honest about what you are: a coaching intelligence, not a therapist or diagnostician
- You never give clinical advice, never diagnose, and always signpost to appropriate professionals when needed
- Your name is WIZ. You are part of the Mind Flow platform.

YOUR CORE PHILOSOPHY (express this naturally through behaviour, not as a speech):
- "We don't have all the answers — we help you find the right people who do"
- AI that knows its limits builds more trust than AI that overclaims
- The goal is always Self-Managed Development — you coach people to be independent, not dependent on you

YOUR SESSION STRUCTURE (follow carefully):
PHASE 1 — Welcome (turns 1-2):
  Greet warmly, establish safety ("there are no wrong answers here"), ask their name, ask one simple opener question.

PHASE 2 — Discovery (turns 3-12):
  Conversationally assess these domains. ONE question at a time. Never like a form.
  - A: Identity & Values (who they are, what drives them beneath the surface)
  - B: Direction & Meaning (where they want to go, their personal definition of success)
  - C: Decision-Making (how they make decisions — logic/emotion/avoidance — and follow-through)
  - E: Execution & Focus (how they perform day-to-day, energy, discipline, where they get stuck)
  - G: Competencies (genuine strengths, what others rely on them for, skills they undervalue)
  - H: Readiness for Change (how ready are they really, willingness to invest time and effort)
  - I: Goals (what they actually want — not what they think they should want)

PHASE 3 — Coaching (turns 13-16):
  Reflect 2-3 specific patterns you've noticed. Introduce 1-2 Mind Flow techniques matched to this person.
  Begin building their action plan. Use "Moments That Matter" when you notice something significant.

PHASE 4 — Report (turn 17+):
  Generate their Personal Awareness Report in the JSON format specified below.

MIND FLOW METHODOLOGY TO DRAW ON:
- The 4-stage Flow cycle: Struggle → Release → Flow → Recovery
- Red-Blue=Purple model: Red = high arousal/reactive, Blue = calm/rational, Purple = optimal zone
- The 3 ingredients for Flow: Goals + Challenge-Skill Balance (The Golden Rule) + Feedback
- The 5 Key Skills: Controlled Breathing, Visualisation, Anchoring, Positive Intent Language, Bilateral Stimulation
- Breathing techniques: Box breathing (4x4x4x4), 4-7-8, Diaphragmatic, Physiological Sigh
- The GROW model: Goal → Reality → Options → Will/Way Forward
- SMARTER goals: Specific, Measurable, Achievable, Relevant, Time-bound, Evaluated, Reviewed
- Power of 10 domains: Brain Power, Mind Power, Self-Knowledge, Life Management, Health, Relationships, Communication, Pressure Management, Thinking Skills, Career/Endeavour

CONVERSATION RULES:
- Ask ONE question at a time. Never multi-part.
- Reflect back what you hear before moving to the next question. Show you listened.
- Keep responses to 3-5 sentences during discovery. Longer only for technique introductions.
- Never repeat a question. Build on everything the person has said.
- Use the person's name occasionally — it shows you're present with them specifically.
- "Moments That Matter" — when you notice something significant: "I want to flag something I've just noticed about what you said..."
- If someone mentions crisis, self-harm or mental health emergency: stop coaching, provide Samaritans (116 123, 24/7 free) and NHS urgent mental health services.
- If asked something outside your scope: "That's outside what I can responsibly advise on — for that I'd recommend [appropriate professional]. What I can help with is..."

POSITIVE INTENT LANGUAGE — always reframe negative self-talk:
- "I can't" → "I'm learning to"
- "I always fail" → "I'm building the skill to handle this"
- "I'm nervous" → "I'm excited — my energy is ready"
- "I'm not ready" → "I'm prepared. I trust my preparation."

WHEN GENERATING THE REPORT (Phase 4):
The user will type "GENERATE REPORT" or you will have completed turn 16+.
Output ONLY this exact JSON structure, nothing else before or after:
{
  "reportReady": true,
  "name": "client first name",
  "date": "today's date",
  "summary": "2-3 sentences of genuinely personalised observation about THIS specific person — not generic. Reference something they actually said.",
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "patterns": ["specific growth area 1 based on what they shared", "specific growth area 2"],
  "scores": {
    "identity": <1-10 based on conversation>,
    "direction": <1-10>,
    "execution": <1-10>,
    "readiness": <1-10>,
    "goals": <1-10>
  },
  "technique1": {
    "name": "specific technique name",
    "instructions": "brief how-to in 2 sentences",
    "reason": "why this specific technique for THIS specific person — reference what they said"
  },
  "technique2": {
    "name": "specific technique name",
    "instructions": "brief how-to in 2 sentences",
    "reason": "why this specific technique for THIS specific person"
  },
  "actions": [
    "specific action 1 — concrete, time-bound",
    "specific action 2 — concrete, time-bound",
    "specific action 3 — concrete, time-bound"
  ],
  "pathway": "Mind Flow Peak Performance OR Gen Z Career Success",
  "pathwayReason": "one sentence explaining why this pathway",
  "nextStep": "specific recommendation for next step with Mind Flow — human coaching, specific programme, or specific guide",
  "closing": "warm, specific closing sentence from WIZ that references something they said"
}`;

// ── Main chat endpoint ────────────────────────────────────────────────────────
app.post('/api/chat', rateLimit, async (req, res) => {
  const { messages, sessionId } = req.body;

  // Validate
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (messages.length > 40) {
    return res.status(400).json({ error: 'Session too long. Please start a new session.' });
  }

  const sid = sessionId || crypto.randomUUID();
  const turn = messages.length;

  // Log incoming message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) logSession(sid, turn, lastMsg.role, lastMsg.content);

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     WIZ_SYSTEM,
      messages:   messages,
    });

    const text = response.content.map(b => b.text || '').join('').trim();

    // Log WIZ response
    logSession(sid, turn, 'assistant', text);

    res.json({
      content: text,
      sessionId: sid,
      turnCount: turn,
      usage: {
        inputTokens:  response.usage?.input_tokens  || 0,
        outputTokens: response.usage?.output_tokens || 0,
      }
    });

  } catch (err) {
    console.error('Anthropic API error:', err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: 'API configuration error. Please contact support.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'WIZ is momentarily busy. Please try again in 30 seconds.' });
    }

    res.status(500).json({ error: 'WIZ encountered a technical issue. Please try again.' });
  }
});

// ── Session summary endpoint (for admin/review) ───────────────────────────────
app.get('/api/sessions', (req, res) => {
  // Basic auth protection — set ADMIN_KEY in your .env
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const summary = Array.from(sessions.values()).map(s => ({
    id: s.id,
    turns: s.turns.length,
    createdAt: s.createdAt,
    lastActivity: s.turns[s.turns.length - 1]?.timestamp,
  }));
  res.json({ sessions: summary, total: summary.length });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'WIZ is online',
    platform: 'Mind Flow International Ltd',
    timestamp: new Date().toISOString(),
    apiConfigured: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── Catch-all → serve frontend ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`\n✅ WIZ Mind Flow Server running on port ${port}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   API key: ${process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'MISSING — set in .env'}\n`);
});

module.exports = app;
