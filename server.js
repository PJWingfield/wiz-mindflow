// ── WIZ Mind Flow Server — Single File Edition ───────────────────────────────
// Complete server with HTML embedded — no separate public folder needed
// Deploy to Railway: add ANTHROPIC_API_KEY, ADMIN_KEY, ALLOWED_ORIGIN=* as variables

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');

const app    = express();
const port   = process.env.PORT || 3000;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

app.use(express.json({ limit: '50kb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] }));

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || 'unknown';
  const now = Date.now();
  const rec = rateLimits.get(ip) || { count:0, resetAt: now + 3600000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 3600000; }
  rec.count++;
  rateLimits.set(ip, rec);
  if (rec.count > 50) return res.status(429).json({ error: 'Too many messages. Please take a short break.' });
  next();
}

// ── Session log ───────────────────────────────────────────────────────────────
const sessions = new Map();
function logSession(sid, turn, role, content) {
  if (!sessions.has(sid)) sessions.set(sid, { id:sid, turns:[], createdAt: new Date().toISOString() });
  sessions.get(sid).turns.push({ turn, role, content: content.substring(0,500), timestamp: new Date().toISOString() });
}

// ── WIZ System Prompt ─────────────────────────────────────────────────────────
const WIZ_SYSTEM = `You are WIZ, the Mind Flow AI coaching companion built on 35 years of PJ Wingfield's Mind Flow methodology. You work for Mind Flow International Ltd (mindflowpro.com).

YOUR IDENTITY:
- You are warm, energising, direct, and genuinely curious about the person in front of you
- You speak in PJ Wingfield's coaching voice: encouraging but never preachy, science-grounded but human, always possibility-focused
- You are honest about what you are: a coaching intelligence, not a therapist or diagnostician
- You never give clinical advice, never diagnose, and always signpost to appropriate professionals when needed
- Your name is WIZ. You are part of the Mind Flow platform.

YOUR CORE PHILOSOPHY:
- "We don't have all the answers — we help you find the right people who do"
- AI that knows its limits builds more trust than AI that overclaims
- The goal is always Self-Managed Development

YOUR SESSION STRUCTURE:
PHASE 1 — Welcome (turns 1-2): Greet warmly, establish safety, ask name, ask one simple opener.
PHASE 2 — Discovery (turns 3-12): Assess these domains conversationally. ONE question at a time. Never like a form.
  - A: Identity & Values
  - B: Direction & Meaning  
  - C: Decision-Making style
  - E: Execution & Focus
  - G: Competencies & Strengths
  - H: Readiness for Change (most important)
  - I: Goals
PHASE 3 — Coaching (turns 13-16): Reflect patterns, introduce 1-2 Mind Flow techniques, build action plan.
PHASE 4 — Report (turn 17+): Generate JSON report.

MIND FLOW METHODOLOGY:
- 4-stage Flow cycle: Struggle → Release → Flow → Recovery
- Red-Blue=Purple: Red=high arousal/reactive, Blue=calm/rational, Purple=optimal performance zone
- 3 ingredients: Goals + Challenge-Skill Balance + Feedback
- 5 Key Skills: Controlled Breathing, Visualisation, Anchoring, Positive Intent Language, Bilateral Stimulation
- Breathing: Box (4x4x4x4), 4-7-8, Diaphragmatic, Physiological Sigh
- GROW model: Goal → Reality → Options → Will/Way Forward
- SMARTER goals: Specific, Measurable, Achievable, Relevant, Time-bound, Evaluated, Reviewed

CONVERSATION RULES:
- ONE question at a time. Never multi-part.
- Reflect back before moving on. Show you listened.
- 3-5 sentences max during discovery.
- Never repeat. Build on everything said.
- Use the person's name occasionally.
- "Moments That Matter": "I want to flag something I've just noticed..."
- Crisis: stop coaching, provide Samaritans 116 123 (24/7 free).

POSITIVE INTENT LANGUAGE reframes:
- "I can't" → "I'm learning to"
- "I always fail" → "I'm building the skill"  
- "I'm nervous" → "I'm excited — my energy is ready"

REPORT FORMAT — output ONLY this JSON when generating report:
{
  "reportReady": true,
  "name": "first name",
  "summary": "2-3 sentences specific to this person referencing what they said",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "patterns": ["growth area 1", "growth area 2"],
  "scores": {"identity":7,"direction":6,"execution":5,"readiness":8,"goals":7},
  "technique1": {"name":"technique","instructions":"2 sentence how-to","reason":"why for this person"},
  "technique2": {"name":"technique","instructions":"2 sentence how-to","reason":"why for this person"},
  "actions": ["action 1","action 2","action 3"],
  "pathway": "Mind Flow Peak Performance OR Gen Z Career Success",
  "pathwayReason": "one sentence why",
  "nextStep": "specific recommendation",
  "closing": "warm specific closing referencing something they said"
}`;

// ── Chat endpoint ─────────────────────────────────────────────────────────────
app.post('/api/chat', rateLimit, async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  if (messages.length > 40) return res.status(400).json({ error: 'Session too long. Please start a new session.' });

  const sid  = sessionId || crypto.randomUUID();
  const turn = messages.length;
  const last = messages[messages.length - 1];
  if (last) logSession(sid, turn, last.role, last.content);

  try {
    const apiResponse = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: WIZ_SYSTEM,
        messages,
      }),
    });
    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      console.error('Anthropic API error:', apiResponse.status, JSON.stringify(data));
      if (apiResponse.status === 401) return res.status(500).json({ error: 'API key error. Please contact info@mindflowpro.com' });
      if (apiResponse.status === 429) return res.status(429).json({ error: 'WIZ is momentarily busy. Please try again in 30 seconds.' });
      return res.status(500).json({ error: 'WIZ encountered a technical issue. Please try again.' });
    }
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    logSession(sid, turn, 'assistant', text);
    res.json({ content: text, sessionId: sid, turnCount: turn });
  } catch (err) {
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'WIZ encountered a technical issue. Please try again.' });
  }
});

// ── Admin sessions ────────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorised' });
  const summary = Array.from(sessions.values()).map(s => ({
    id: s.id, turns: s.turns.length, createdAt: s.createdAt,
    lastActivity: s.turns[s.turns.length-1]?.timestamp
  }));
  res.json({ sessions: summary, total: summary.length });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'WIZ is online',
  platform: 'Mind Flow International Ltd',
  timestamp: new Date().toISOString(),
  apiConfigured: !!process.env.ANTHROPIC_API_KEY,
}));

// ── Embedded HTML ─────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WIZ — Mind Flow Coaching</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#1B2A6B;--teal:#0F6E56;--teal2:#1D9E75;--gold:#C8960C;--cream:#FAF8F2;--white:#FFFFFF;--dark:#1A1A2E;--mid:#555570;--lteal:#E8F5F0;--lnavy:#EEF0FA;--border:rgba(15,110,86,0.2)}
body{font-family:'DM Sans',sans-serif;background:var(--cream);color:var(--dark);min-height:100vh;display:flex;flex-direction:column}
header{background:var(--navy);padding:16px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid var(--teal2)}
.logo-area{display:flex;align-items:center;gap:14px}
.logo-mark{width:40px;height:40px;background:linear-gradient(135deg,var(--teal2),var(--gold));border-radius:9px;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:white}
.logo-text h1{font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:white}
.logo-text p{font-size:11px;color:rgba(255,255,255,0.55);margin-top:1px}
.badge{font-size:11px;color:rgba(255,255,255,0.45);border:1px solid rgba(255,255,255,0.2);padding:4px 10px;border-radius:20px}
.app{display:flex;flex:1;height:calc(100vh - 67px)}
.sidebar{width:260px;min-width:260px;background:var(--navy);padding:24px 18px;display:flex;flex-direction:column;gap:18px;overflow-y:auto}
.wiz-avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--teal),var(--teal2));display:flex;align-items:center;justify-content:center;margin:0 auto 6px;font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:300;color:white;box-shadow:0 0 0 4px rgba(29,158,117,0.3);position:relative}
.status-dot{position:absolute;bottom:3px;right:3px;width:11px;height:11px;border-radius:50%;background:var(--teal2);border:2px solid var(--navy)}
.sidebar h2{font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:400;color:white;text-align:center}
.wiz-desc{font-size:11px;color:rgba(255,255,255,0.45);text-align:center;line-height:1.6}
.sidebar hr{border:none;border-top:1px solid rgba(255,255,255,0.1)}
.sidebar-section h3{font-size:10px;font-weight:500;letter-spacing:.1em;color:var(--teal2);text-transform:uppercase;margin-bottom:10px}
.domain-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;margin-bottom:3px}
.domain-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.18);flex-shrink:0}
.domain-dot.active{background:var(--teal2)}
.domain-dot.done{background:var(--gold)}
.domain-label{font-size:11px;color:rgba(255,255,255,0.6)}
.mfi-tagline{margin-top:auto;font-family:'Cormorant Garamond',serif;font-size:12px;font-style:italic;color:rgba(255,255,255,0.28);text-align:center;line-height:1.7}
.chat-area{flex:1;display:flex;flex-direction:column;background:var(--cream);overflow:hidden}
.phase-bar{padding:10px 28px;background:white;border-bottom:1px solid var(--border);display:flex;align-items:center}
.phase-step{display:flex;align-items:center;gap:0;flex:1}
.phase-step:last-child{flex:none}
.phase-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;background:#E8EAF0;color:var(--mid);flex-shrink:0;transition:all .4s}
.phase-dot.active{background:var(--teal);color:white;box-shadow:0 0 0 3px rgba(15,110,86,0.2)}
.phase-dot.done{background:var(--teal2);color:white}
.phase-label{font-size:11px;color:var(--mid);margin-left:5px;white-space:nowrap}
.phase-label.active{color:var(--teal);font-weight:500}
.phase-line{flex:1;height:2px;background:#E8EAF0;margin:0 6px}
.phase-line.done{background:var(--teal2)}
.messages{flex:1;overflow-y:auto;padding:28px 36px;display:flex;flex-direction:column;gap:18px;scroll-behavior:smooth}
.msg{display:flex;align-items:flex-start;gap:12px;max-width:80%}
.msg.wiz{align-self:flex-start}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg-avatar{width:34px;height:34px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:15px;font-weight:600}
.msg.wiz .msg-avatar{background:linear-gradient(135deg,var(--teal),var(--teal2));color:white}
.msg.user .msg-avatar{background:var(--navy);color:white}
.msg-bubble{padding:13px 16px;border-radius:14px;line-height:1.65;font-size:14.5px}
.msg.wiz .msg-bubble{background:white;border:1px solid var(--border);border-top-left-radius:3px;color:var(--dark);box-shadow:0 2px 6px rgba(0,0,0,0.04)}
.msg.user .msg-bubble{background:var(--navy);color:white;border-top-right-radius:3px}
.msg-meta{font-size:10px;color:rgba(0,0,0,0.28);margin-top:4px}
.msg.user .msg-meta{text-align:right;color:rgba(255,255,255,0.35)}
.typing{display:flex;align-items:center;gap:4px;padding:12px 14px}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--teal2);animation:bounce 1.4s infinite;opacity:.6}
.typing span:nth-child(2){animation-delay:.2s}
.typing span:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
.input-area{padding:18px 36px 20px;background:white;border-top:1px solid var(--border);display:flex;gap:10px;align-items:flex-end}
.input-wrap{flex:1}
textarea{width:100%;padding:13px 16px;border:1.5px solid var(--border);border-radius:11px;font-family:'DM Sans',sans-serif;font-size:14px;color:var(--dark);background:var(--cream);resize:none;outline:none;line-height:1.5;transition:border-color .2s,box-shadow .2s;min-height:50px;max-height:130px}
textarea:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(15,110,86,0.1);background:white}
.send-btn{width:48px;height:48px;border-radius:11px;background:var(--teal);color:white;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;transition:background .2s,transform .1s;flex-shrink:0}
.send-btn:hover{background:var(--teal2);transform:scale(1.03)}
.send-btn:disabled{background:#ccc;cursor:not-allowed;transform:none}
.input-hint{font-size:10px;color:var(--mid);padding-bottom:8px;text-align:center}
.report-view{flex:1;overflow-y:auto;padding:36px}
.report-header{background:var(--navy);padding:32px 36px;border-radius:14px;margin-bottom:24px}
.report-header .label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--teal2);margin-bottom:10px}
.report-header h2{font-family:'Cormorant Garamond',serif;font-size:30px;font-weight:300;color:white;margin-bottom:6px}
.report-header .sub{font-size:13px;color:rgba(255,255,255,0.5)}
.report-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
.report-card{background:white;border:1px solid var(--border);border-radius:11px;padding:22px;border-top:3px solid var(--teal2)}
.report-card h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);margin-bottom:12px;font-weight:500}
.report-card p{font-size:13.5px;color:var(--dark);line-height:1.7}
.report-card.full{grid-column:1/-1}
.score-row{display:flex;align-items:center;gap:12px;margin-bottom:9px}
.score-label{font-size:12.5px;color:var(--mid);width:140px;flex-shrink:0}
.score-bar{flex:1;height:6px;background:#E8EAF0;border-radius:3px;overflow:hidden}
.score-fill{height:100%;background:linear-gradient(90deg,var(--teal),var(--teal2));border-radius:3px;transition:width 1s ease}
.score-num{font-size:12.5px;font-weight:500;color:var(--navy);width:26px;text-align:right}
.action-item{display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-bottom:1px solid rgba(0,0,0,0.06)}
.action-item:last-child{border-bottom:none}
.action-num{width:24px;height:24px;border-radius:50%;background:var(--teal);color:white;font-size:11px;font-weight:500;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
.action-text{font-size:13.5px;color:var(--dark);line-height:1.6}
.report-cta{background:linear-gradient(135deg,var(--teal),var(--navy));border-radius:13px;padding:26px 30px;color:white;margin-top:20px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.report-cta h3{font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:400;color:white;margin-bottom:5px}
.report-cta p{font-size:13px;color:rgba(255,255,255,0.65)}
.cta-btns{display:flex;gap:10px;flex-shrink:0}
.btn-primary,.btn-secondary{padding:11px 20px;border-radius:7px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;cursor:pointer;border:none;white-space:nowrap;transition:all .2s}
.btn-primary{background:white;color:var(--navy)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 10px rgba(0,0,0,0.12)}
.btn-secondary{background:rgba(255,255,255,0.13);color:white;border:1px solid rgba(255,255,255,0.28)}
.loading-overlay{position:fixed;inset:0;background:rgba(27,42,107,0.55);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:100}
.loading-card{background:white;border-radius:14px;padding:36px 44px;text-align:center;max-width:320px}
.loading-spinner{width:44px;height:44px;border-radius:50%;border:3px solid var(--lteal);border-top-color:var(--teal);animation:spin .9s linear infinite;margin:0 auto 18px}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-card h3{font-family:'Cormorant Garamond',serif;font-size:19px;color:var(--navy);margin-bottom:7px}
.loading-card p{font-size:12.5px;color:var(--mid);line-height:1.6}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.1);border-radius:3px}
@media(max-width:768px){.sidebar{display:none}.messages{padding:18px}.input-area{padding:14px 18px}.report-grid{grid-template-columns:1fr}.report-view{padding:18px}.report-cta{flex-direction:column}}
</style>
</head>
<body>
<header>
  <div class="logo-area">
    <div class="logo-mark">W</div>
    <div class="logo-text"><h1>WIZ &mdash; Mind Flow</h1><p>Your Personal Coaching Platform</p></div>
  </div>
  <div class="badge">Beta Session &bull; mindflowpro.com</div>
</header>
<div class="app">
  <aside class="sidebar">
    <div>
      <div class="wiz-avatar">W<div class="status-dot"></div></div>
      <h2>WIZ</h2>
      <p class="wiz-desc">Your personal Mind Flow coaching companion &mdash; powered by 35 years of Peak Performance methodology</p>
    </div>
    <hr>
    <div class="sidebar-section">
      <h3>Session Progress</h3>
      <div class="domain-item"><div class="domain-dot active" id="dot-A"></div><span class="domain-label">Identity &amp; Self-Awareness</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-B"></div><span class="domain-label">Direction &amp; Meaning</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-C"></div><span class="domain-label">Decision-Making</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-E"></div><span class="domain-label">Execution &amp; Focus</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-G"></div><span class="domain-label">Competencies</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-H"></div><span class="domain-label">Readiness for Change</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-I"></div><span class="domain-label">Goals &amp; Direction</span></div>
    </div>
    <hr>
    <div class="sidebar-section">
      <h3>About WIZ</h3>
      <p style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.7">WIZ is a coaching intelligence &mdash; honest about its limits, clear about when a human expert will serve you better.</p>
    </div>
    <p class="mfi-tagline">Mind Flow: A Better Way to Be.<br><em>Not more doing. Just more being.</em></p>
  </aside>
  <div class="chat-area" id="chatArea">
    <div class="phase-bar" id="phaseBar">
      <div class="phase-step"><div class="phase-dot active" id="ph1">1</div><span class="phase-label active">Welcome</span></div>
      <div class="phase-line" id="pl1"></div>
      <div class="phase-step"><div class="phase-dot" id="ph2">2</div><span class="phase-label">Discovery</span></div>
      <div class="phase-line" id="pl2"></div>
      <div class="phase-step"><div class="phase-dot" id="ph3">3</div><span class="phase-label">Coaching</span></div>
      <div class="phase-line" id="pl3"></div>
      <div class="phase-step"><div class="phase-dot" id="ph4">4</div><span class="phase-label">Your Report</span></div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="input-area" id="inputArea">
      <div class="input-wrap"><textarea id="userInput" placeholder="Type your response to WIZ..." rows="1"></textarea></div>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">&#10148;</button>
    </div>
    <p class="input-hint">Press Enter to send &bull; Shift+Enter for new line</p>
  </div>
</div>
<div class="loading-overlay" id="loadingOverlay" style="display:none">
  <div class="loading-card">
    <div class="loading-spinner"></div>
    <h3 id="loadingTitle">WIZ is thinking...</h3>
    <p id="loadingText">Taking a moment to reflect on what you've shared</p>
  </div>
</div>
<script>
const state={messages:[],phase:1,turnCount:0,reportData:null,assessedDomains:new Set(),clientName:"",isLoading:false,sessionId:null};
async function callWIZ(userMessage){
  if(userMessage)state.messages.push({role:"user",content:userMessage});
  const response=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:state.messages,sessionId:state.sessionId})});
  if(!response.ok){const err=await response.json().catch(()=>({}));throw new Error(err.error||"Server error "+response.status)}
  const data=await response.json();
  if(data.sessionId)state.sessionId=data.sessionId;
  const text=data.content;
  state.messages.push({role:"assistant",content:text});
  return text;
}
function addMessage(role,text){
  const msgs=document.getElementById("messages");
  const now=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  const div=document.createElement("div");
  div.className="msg "+role;
  div.innerHTML='<div class="msg-avatar">'+(role==="wiz"?"W":"U")+'</div><div><div class="msg-bubble">'+text.replace(/\n/g,"<br>")+'</div><div class="msg-meta">'+(role==="wiz"?"WIZ":"You")+' &bull; '+now+'</div></div>';
  msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;
}
function showTyping(){const msgs=document.getElementById("messages");const div=document.createElement("div");div.className="msg wiz";div.id="typing-indicator";div.innerHTML='<div class="msg-avatar">W</div><div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>';msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight}
function removeTyping(){const t=document.getElementById("typing-indicator");if(t)t.remove()}
function setPhase(n){state.phase=n;for(let i=1;i<=4;i++){const d=document.getElementById("ph"+i);const l=d?d.nextElementSibling:null;const ln=document.getElementById("pl"+i);if(d)d.className="phase-dot"+(i<n?" done":i===n?" active":"");if(l)l.className="phase-label"+(i===n?" active":"");if(ln)ln.className="phase-line"+(i<n?" done":"")}}
function setLoading(show,title,text){state.isLoading=show;document.getElementById("loadingOverlay").style.display=show?"flex":"none";if(title)document.getElementById("loadingTitle").textContent=title;if(text)document.getElementById("loadingText").textContent=text;document.getElementById("sendBtn").disabled=show}
function activateDomain(d){if(state.assessedDomains.has(d))return;state.assessedDomains.add(d);["A","B","C","E","G","H","I"].forEach(x=>{if(state.assessedDomains.has(x)&&x!==d){const el=document.getElementById("dot-"+x);if(el)el.className="domain-dot done"}});const dot=document.getElementById("dot-"+d);if(dot)dot.className="domain-dot active"}
async function generateReport(){
  setLoading(true,"WIZ is crafting your report...","Pulling together everything from your session");
  let raw;
  try{raw=await callWIZ("Based on our entire conversation, please generate the Personal Awareness Report JSON now. Output ONLY the JSON.")}
  catch(e){setLoading(false);addMessage("wiz","I'm having difficulty generating the full report right now. Based on everything you've shared, you show real self-awareness and genuine readiness for change. Your next step is to visit mindflowpro.com to book a session with a Mind Flow coach.");return}
  setLoading(false);
  let report;
  try{const m=raw.match(/\{[\s\S]*\}/);report=JSON.parse(m?m[0]:raw)}
  catch(e){report={name:state.clientName||"there",summary:"You've shown real openness and self-awareness throughout our session. What stands out is your willingness to look honestly at where you are — that's the most important quality for change.",strengths:["Self-awareness and honesty","Genuine motivation to improve","Openness to new perspectives"],patterns:["Building clearer direction around key goals","Strengthening consistent follow-through"],scores:{identity:7,direction:6,execution:6,readiness:8,goals:7},technique1:{name:"Controlled Breathing (4-7-8)",instructions:"Inhale for 4 seconds through the nose, hold for 7, exhale slowly for 8 through the mouth. Repeat 4 times.",reason:"Will help you shift into a calmer, clearer mind state before important decisions."},technique2:{name:"The Concentration Anchor",instructions:"Choose a focus point — your breath or a word. Each time your mind wanders, gently return to it without criticism.",reason:"A practical tool to bring focus back whenever your attention drifts during important tasks."},actions:["Spend 10 minutes this week writing your three most important goals","Practice the 4-7-8 breathing technique each morning for one week","Book a follow-up session to go deeper on the areas we identified today"],pathway:"Mind Flow Peak Performance",pathwayReason:"Your profile and goals align with the Peak Performance pathway.",nextStep:"Book a 1-to-1 coaching session with a Mind Flow coach at mindflowpro.com",closing:"You came here today with honesty and openness. That's rare and it matters. What we've started is just the beginning."}}
  state.reportData=report;renderReport(report);
}
function renderReport(r){
  const ca=document.getElementById("chatArea");
  ca.innerHTML='<div class="report-view"><div class="report-header"><div class="label">Personal Awareness Report &bull; Mind Flow</div><h2>Your Session Report, '+r.name+'</h2><div class="sub">'+new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"})+' &bull; Powered by WIZ</div></div><div class="report-grid"><div class="report-card full"><h3>WIZ\'s Observation</h3><p>'+r.summary+'</p></div><div class="report-card"><h3>Strengths Identified</h3>'+r.strengths.map(s=>'<p style="margin-bottom:7px">&#10003; &nbsp;'+s+'</p>').join('')+'</div><div class="report-card"><h3>Growth Opportunities</h3>'+r.patterns.map(p=>'<p style="margin-bottom:7px">&#8594; &nbsp;'+p+'</p>').join('')+'</div><div class="report-card full"><h3>Domain Scores</h3>'+Object.entries(r.scores).map(([k,v])=>'<div class="score-row"><span class="score-label">'+k.charAt(0).toUpperCase()+k.slice(1)+'</span><div class="score-bar"><div class="score-fill" style="width:'+v*10+'%"></div></div><span class="score-num">'+v+'/10</span></div>').join('')+'</div><div class="report-card"><h3>Recommended Technique 1</h3><p><strong>'+r.technique1.name+'</strong></p><p style="margin-top:7px;font-size:12.5px;color:var(--mid)">'+r.technique1.instructions+'</p><p style="margin-top:6px;font-size:12px;color:var(--teal);font-style:italic">'+r.technique1.reason+'</p></div><div class="report-card"><h3>Recommended Technique 2</h3><p><strong>'+r.technique2.name+'</strong></p><p style="margin-top:7px;font-size:12.5px;color:var(--mid)">'+r.technique2.instructions+'</p><p style="margin-top:6px;font-size:12px;color:var(--teal);font-style:italic">'+r.technique2.reason+'</p></div><div class="report-card full"><h3>Your Three Priority Actions</h3>'+r.actions.map((a,i)=>'<div class="action-item"><div class="action-num">'+(i+1)+'</div><div class="action-text">'+a+'</div></div>').join('')+'</div><div class="report-card full" style="border-top-color:var(--gold);background:var(--lnavy)"><h3 style="color:var(--navy)">Recommended Pathway: '+r.pathway+'</h3><p>'+r.closing+'</p><p style="margin-top:8px;font-size:13px;color:var(--teal)"><strong>Next step:</strong> '+r.nextStep+'</p></div></div><div class="report-cta"><div><h3>Ready to go deeper?</h3><p>Work with a qualified Mind Flow coach and accelerate everything WIZ has started today.</p></div><div class="cta-btns"><button class="btn-primary" onclick="window.open(\'https://mindflowpro.com\',\'_blank\')">Book a Session</button><button class="btn-secondary" onclick="window.print()">Save Report</button></div></div><p style="font-size:11px;color:var(--mid);text-align:center;margin-top:20px;padding-bottom:28px">&copy; PJ Wingfield / Mind Flow International Ltd 2026 &bull; WIZ is a coaching intelligence, not a therapist. Samaritans: 116 123 (24/7, free)</p></div>';
  setPhase(4);
}
async function sendMessage(){
  const input=document.getElementById("userInput");
  const text=input.value.trim();
  if(!text||state.isLoading)return;
  input.value="";input.style.height="auto";
  state.turnCount++;
  if(state.turnCount<=3&&!state.clientName&&text.length<40){const w=text.trim().split(" ");if(w.length<=3)state.clientName=w[0]}
  addMessage("user",text);showTyping();setLoading(true);
  if(state.turnCount>=3&&state.phase===1)setPhase(2);
  if(state.turnCount>=11&&state.phase===2)setPhase(3);
  if(state.turnCount>=3)activateDomain("A");
  if(state.turnCount>=5)activateDomain("B");
  if(state.turnCount>=7)activateDomain("C");
  if(state.turnCount>=9)activateDomain("E");
  if(state.turnCount>=11)activateDomain("G");
  if(state.turnCount>=13)activateDomain("H");
  if(state.turnCount>=15)activateDomain("I");
  try{
    if(state.turnCount>=16&&state.phase<4){setPhase(4);removeTyping();setLoading(false);await generateReport();return}
    const reply=await callWIZ(text);
    removeTyping();setLoading(false);addMessage("wiz",reply);
    if(reply.toLowerCase().includes("personal awareness report")&&state.turnCount>=12){setTimeout(generateReport,1500)}
  }catch(err){removeTyping();setLoading(false);addMessage("wiz","I'm having a brief technical moment. Please try again in a few seconds — I'm still here.");console.error(err)}
}
document.getElementById("userInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}});
document.getElementById("userInput").addEventListener("input",function(){this.style.height="auto";this.style.height=Math.min(this.scrollHeight,130)+"px"});
async function startSession(){
  setLoading(true,"Starting your session...","WIZ is ready to meet you");
  try{const opening=await callWIZ(null);setLoading(false);addMessage("wiz",opening)}
  catch(e){setLoading(false);addMessage("wiz","Hello, and welcome to your Mind Flow session. I'm WIZ — your personal coaching companion, built on the Mind Flow methodology.\n\nThis session is completely yours. There are no wrong answers, no judgements. Just a real conversation about where you are and where you want to go.\n\nTo start — what's your name, and in one sentence, what's brought you here today?")}
}
startSession();
</script>
</body>
</html>`;

// Serve the embedded HTML for all non-API routes
app.get('*', (req, res) => res.send(HTML));

app.listen(port, () => {
  console.log('\n✅ WIZ Mind Flow Server running on port ' + port);
  console.log('   API key: ' + (process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'MISSING'));
});

module.exports = app;
