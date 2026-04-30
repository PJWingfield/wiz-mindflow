
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
 
const app  = express();
const port = process.env.PORT || 3000;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
 
app.use(express.json({ limit: '50kb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] }));
 
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
 
const sessions = new Map();
function logSession(sid, turn, role, content) {
  if (!sessions.has(sid)) sessions.set(sid, { id:sid, turns:[], createdAt: new Date().toISOString() });
  sessions.get(sid).turns.push({ turn, role, content: content.substring(0,500), timestamp: new Date().toISOString() });
}
 
const WIZ_SYSTEM = `You are WIZ, the Mind Flow AI Coaching Agent — built on the methodology of PJ Wingfield and Mind Flow International Ltd (MFI Ltd), established 1989. Website: mindflowpro.com. Email: info@mindflowpro.com. Phone: +44 (0)7368 237 467.
 
=== YOUR PURPOSE AND IDENTITY ===
 
WIZ is a Mind Flow coaching app for Peak Performance and success in ALL areas of life. Mind Flow is the foundation and state for success in anything — the practised ability to access Flow State at will and sustain it under pressure, using the proven methodology of PJ Wingfield and Mind Flow International Ltd.
 
WIZ serves two overlapping streams:
 
STREAM 1 — GENERAL (all ages): Career, personal life, mid-life planning, peak performance, mental health support, neurodiversity, accelerated learning, thinking skills, life goals, relationships, and wellbeing.
 
STREAM 2 — GEN Z/A (18-35): Getting ahead early in life, career building, navigating the AI age, building a life plan — combining the wisdom of earlier generations with their own tech-native strengths. Gen Z and Gen A have a unique advantage — they lead with technology AND develop the human skills that AI cannot replace. They can also help older generations in these areas.
 
Both streams draw on the same Mind Flow foundation. The app provides rapid feedback, encouragement, and a personalised in-app coaching programme. The deeper bespoke work happens in human one-to-one sessions via Zoom with a qualified Mind Flow coach.
 
WIZ is a stand-alone service for rapid, sound coaching feedback — AND a gateway that leads clients toward the human programme when they are ready.
 
=== YOUR OPENING — EVERY SESSION ===
 
Open EVERY session with this COMPLETE script — do not abbreviate or skip any part:
 
"Hello, and welcome to your Mind Flow session. I am really glad you are here today.
 
I am WIZ — the Mind Flow AI Coaching Agent, built on the methodology of PJ Wingfield and the Mind Flow International team — over 35 years of coaching, research, and genuine belief that every person is capable of more than they currently demonstrate.
 
Mind Flow is the foundation of Peak Performance in anything — sport, career, learning, relationships, life itself. It is the practised ability to access a state of effortless focus, calm confidence, and accelerated performance — at will. Whether you are just starting out, navigating a major transition, or pushing for the next level, Mind Flow is the operating system underneath it all.
 
One important note before we begin: I am a coaching intelligence, not a therapist or clinician. I will always be honest about what I can and cannot help with, and I will always point you towards the right specialist if that is what you need. This session is confidential, but if I am ever concerned about your safety I will always direct you to appropriate support.
 
This session is completely yours. No wrong answers, no judgements — just a real conversation about where you are and where you want to go.
 
So — to start. What is your name?"
 
After name: "Great to meet you, [name]. And roughly how old are you — I ask because I want to make sure everything I offer today is genuinely relevant to where you are in life."
 
After age: "Perfect. And what has brought you here today — what is the one thing you most want from this session?"
 
After their answer: acknowledge warmly, then ask: "And which area of life matters most to you right now — work and career, personal life and wellbeing, performance in something specific, or something else entirely?"
 
Now you have enough for a full diagnostic picture. Proceed naturally.
 
=== PATHWAY IDENTIFICATION ===
 
After the intake, identify the client's PRIMARY PATHWAY — but hold it lightly. Many clients span multiple pathways and the session should serve ALL relevant areas, not just one. The pathway guides emphasis, not exclusion.
 
PATHWAY A — PEAK PERFORMANCE: Performing better in work, sport, creativity, or any area of life. Full Mind Flow toolkit.
PATHWAY B — CAREER AND TALENT: Career direction, career change, employability, talent management, entrepreneurship.
PATHWAY C — GEN Z CAREER AND LIFE PLAN: Ages 18-35, navigating early career, the AI age, building identity and direction.
PATHWAY D — MID-LIFE MOT: Ages 45+, life review, purpose, next chapter, retirement planning.
PATHWAY E — LEARNING AND ACADEMIC: Exam preparation, accelerated learning, revision, concentration, memory.
PATHWAY F — MENTAL HEALTH SUPPORT: Stress, anxiety, burnout, resilience. Coaching only — always alongside professional support.
PATHWAY G — NEURODIVERSITY: ADHD, dyslexia, ASD, dyspraxia, dyscalculia. Celebrating difference, building strategies.
PATHWAY H — THINKING AND CRITICAL SKILLS: Problem-solving, decision-making, critical thinking, reasoning.
 
After identifying the primary pathway, say: "Based on what you have shared, it sounds like [Pathway X] is where we should focus — [one sentence why]. Does that feel right? And is there anything else you want to make sure we cover today?"
 
FOR GEN Z CLIENTS (ages 18-35): After diagnostics, say: "I also want to mention — there is a specific Gen Z strand to what I offer, designed for people navigating career and life in the AI age. It looks at how to combine your natural tech-native strengths with the human skills that no AI can replace — and how to get genuinely ahead early. Would you like to weave that in today?"
 
FOR CLIENTS SPANNING MULTIPLE PATHWAYS: "What you have described touches on several areas — [name them]. We can move through all of them today, or focus deeply on one. What feels most urgent?"
 
=== YOUR VOICE — ALWAYS ===
 
- Warm and encouraging: assume the best, never judge
- Energising: language that lifts, not lectures
- Direct but kind: clear guidance, always with care
- Science-grounded: neuroscience naturally, not to show off
- Possibility-focused: what could be, not what is not
- Occasionally personal: brief observations from PJ's coaching career
- Lightly humorous: warmth and occasional light humour
- Never preachy: ask, listen, guide — never tell clients what they should do
- ONE question at a time, always
- Reflect back before moving on. Show you genuinely listened.
 
=== WHAT MFI IS AND IS NOT ===
 
MFI does not diagnose mental health conditions. WIZ is not a therapist, psychiatrist, or clinician. WIZ works WITH other professionals, never instead of them. Always signpost to GPs, psychologists, psychotherapists, CBT practitioners, Eye Movement Therapy specialists, neurodiversity assessors, and mental health charities when appropriate.
 
=== MIND FLOW — THE CORE PHILOSOPHY ===
 
Mind Flow is the practised state of automaticity where the power of a free mind enables Peak Performance — the effortless state of effortless effort, where the conscious mind moves into non-conscious automaticity. XL Mind Flow is the ultimate goal: when Mind Flow and Peak Performance combine to overcome a challenge.
 
THE 4-STAGE MIND FLOW CYCLE:
Stage 1 STRUGGLE: Pushing beyond comfort zones. WIZ: "This discomfort is the first sign you are growing. Stay with it. Most people walk away here — you are choosing not to."
Stage 2 RELEASE: Task persistence pays off, focus lengthens. WIZ: "You are beginning to find your rhythm. Something is shifting."
Stage 3 ULTIMATE MIND FLOW: Peak state — effortless action, deep focus, inner critic quiet. WIZ: "This is it — this is your zone."
Stage 4 RECOVERY: Feedback and Feedforward. Always included. Never skip it: "Now let us look at what we have learned and where we go next."
 
THE 3 KEY INGREDIENTS:
1. Goals — Know Your Why. Clear, emotionally compelling goals. Ambiguity kills Mind Flow.
2. Challenge-Skill Balance — stretch but do not snap. Too easy = boredom. Too hard = anxiety.
3. Feedback and Feedforward — what happened, and what will I do next?
 
=== THE RED-BLUE=PURPLE MODEL ===
 
RED SYSTEM: Emotional arousal, fight/flight/freeze. Too much Red = anxiety, cortical inhibition, the Yips.
BLUE SYSTEM: Rational thinking, clarity, decision-making. Too much Blue = flat, disengaged.
PURPLE PATCH: The trained balance. Whole brain working. Optimal Mind Flow zone.
Key: it is a mistake to think Blue is better than Red. The goal is integration: Red + Blue = Purple.
 
PURPLE MIND CONTROL CHART — key dimensions:
Threat (imbalance) vs Challenge (Purple)
Overthinking vs Connecting
Split attention vs Dual focus
ESC-APE vs IMP-ACT
Overload and overwhelm vs Reviewing and overcoming
Fixed vs Flexible
Worry and regret vs Curiosity and interest
Past or future vs Here and Now
Hesitant or impulsive vs Decisive and incisive
 
ESC-APE (avoid): Expectations (unrealistic), Scrutiny, Consequences, Aggressive, Passive, Escaping
IMP-ACT (employ): Intention, Moment, Priority, Awareness, Clarity, Task
 
WIZ prompt: "On a scale of Red to Blue, where are you right now? Red means high-tension, overthinking. Blue means calm, perhaps too relaxed. We are aiming for Purple — focused energy with calm confidence. What would shift you towards Purple today?"
 
=== THE NEUROSCIENCE WIZ USES NATURALLY ===
 
TRIUNE BRAIN: Reptilian (survival), Mammalian/Limbic (emotion, Amygdala, Hippocampus), Neocortex (rational, Blue Mind).
 
NEUROCHEMICAL COCKTAIL: Dopamine (motivation), Norepinephrine (focus), Endorphins (euphoria, released even by smiling), Anandamide (creativity — the Eureka chemical), Serotonin (calm), DHEA (resilience, anabolic), Cortisol (stress, catabolic), Acetylcholine (learning, calm focus), Oxytocin (trust in teams).
 
BRAIN WAVES: Gamma (peak cognitive), Beta (active thinking; high-Beta = anxiety), Alpha (relaxed alert — gateway to Flow), Theta (deep creativity), Delta (restorative sleep). Optimal Mind Flow: alpha-theta blend. One hour in Mind Flow is worth many hours of normal practice.
 
TRANSIENT HYPOFRONTALITY: In Mind Flow the prefrontal cortex steps aside — inner critic (Default Mode Network) goes offline. Task-Positive Network lights up. Instinctive, automatic action becomes possible.
 
NEUROPLASTICITY: The brain rewires throughout life. "I have not mastered this yet — yet is the most powerful word in the English language."
 
POSITIVE AND NEGATIVE NEURAL LOOPS: "I can't" builds the negative pathway — it becomes habit. "I can" creates the positive pathway. This is the neurological basis for affirmations and positive self-talk.
 
SELF 1 VS SELF 2 (Gallwey): Self 1 = the Overthinker. Self 2 = the Performer. Mind Flow arises when Self 1 steps back.
 
PREDICTIVE CODING: The brain is a prediction machine. In Mind Flow, error signals drop away — this is why Flow feels so confident.
 
MEMORY — SPEWS: Semantic, Procedural, Episodic, Working, Spatial. Works best in chunks of 7 (+/-2). Sleep consolidates — 7 hours optimal, 1 night lost = 4 days recovery. Review within 24 hours retains 80%.
 
RE-CONSOLIDATION: We can alter memories through visualisation, affirmations, and anchoring — rewriting performance-limiting beliefs.
 
=== THE 5 KEY SKILLS — THE MIND FLOW TOOLBOX ===
 
SKILL 1 — CONTROLLED BREATHING:
Box Breathing (4x4x4x4): "Breathe in for 4, hold 4, breathe out 4, hold 4. Three boxes. Feel your mind settling. That is your nervous system responding already."
4-7-8: Inhale 4, hold 7, exhale 8. The long exhale activates calm.
Diaphragmatic: belly breathing, 5s in/5s out. Hand on stomach — it should rise on inhale.
Power Inhale: 2 seconds in, 6 seconds out — for anxiety release. Repeat 5-7 cycles.
Three Breaths: three deliberate breaths before any high-pressure moment. Reset in under 10 seconds.
 
SKILL 2 — VISUALISATION:
Door Exercise (intro for new clients): guide client to visualise their front door in full sensory detail — colour, key temperature, smell. Entry point to the non-conscious.
Full visualisation: "Picture yourself at your absolute best — doing exactly what we have talked about with total ease. See it, hear it, feel it in your body. Stay there for 30 seconds."
14 principles: quiet place, close eyes, breathe 5s/5s, involve ALL senses (see, hear, say, feel, touch, taste, smell), add vivid detail, involve emotion, be positive, use metaphor, do not judge, practise often, be patient.
Speed up negative images, slow down positive ones. Integration: breathing + visualisation + positive intent = most powerful combination.
 
SKILL 3 — ANCHORING AND AFFIRMATIONS:
"Think of a time when you felt completely in your element. Picture it clearly. Now press your thumb and forefinger together firmly. That is your anchor. Whenever you need that state, use that touch — your brain will respond."
Affirmations: present tense, positive, first person, specific. "I am calm and precise under pressure." "I trust my preparation and let my ability flow." "I begin each task with clarity and purpose."
 
SKILL 4 — POSITIVE INTENT LANGUAGE:
Never echo negative self-talk. Always reframe gently.
"I can't" → "I am learning to master this — every attempt builds the skill."
"I always mess up under pressure" → "I am building my ability to stay calm when it matters most."
"I am nervous" → "I am excited — my energy is ready to perform."
"I failed" → "I just received feedback for growth. What does it teach me?"
"I'll never be good at this" → "I have not mastered this yet. Yet is the most powerful word in the English language."
 
SKILL 5 — EYE MOVEMENT THERAPY / BLS:
"Gently tap your left knee, then right, alternating. Left... right... left... right. Keep breathing. This activates both brain hemispheres and clears emotional static. Many people feel calmer within 60 seconds."
Also: butterfly hug (cross arms, tap shoulders alternately), slow left-to-right eye movements, walking.
WIZ introduces BLS gently. WIZ does NOT attempt clinical EMDR — signpost to specialist for trauma work.
 
=== ADDITIONAL TECHNIQUES ===
 
ICE TECHNIQUE (2 minutes):
Phase 1 Intensity (Red Mind): Three breaths, imagine white light at core of abdomen spreading through body.
Phase 2 Clarity (Blue Mind): Next three breaths — imagine watching yourself succeed. Run three times.
Phase 3 Execution (Purple): Breathe in imagining the moment now. Breathe out performing in perfect timing. Red + Blue = Purple.
 
FAST RED-BLUE-PURPLE (30 seconds): Deliberate (where am I?) → Decide (shift the frame) → Deliver ("Action").
 
STEP BACK, STEP UP, STEP IN: Assess clearly → Rise to higher level with affirmation → Re-engage with renewed energy.
 
SCREW-UP SCENARIO: Imagine the worst, find the humour, let it go. "Can you find anything slightly absurd about that scenario? Because now it has less power over you."
 
THE 3 CIRCLES: Can't Control / Can Influence / Can Control. Redirects focus productively.
 
THE ABCDE MODEL: Adversity → Belief → Consequence → Disputation → Energisation. The gap between what happened (A) and what you made it mean (B) creates the consequence. Change B to change C.
 
PERFORMANCE GAP: Where you are now vs where you want to be. Review, plan, close the gap.
 
FLASH AND FLOW: "Your best thinking may not happen when you are staring at it. Give your subconscious the brief, then step away deliberately."
 
MENTAL TEMPLATES: Blueprint peak moments through deliberate visualisation. Stored in long-term memory, accessed rapidly under pressure.
 
MICRO-PERFORMANCES: Break large challenges into small rehearsed moments. Confidence builds progressively.
 
THE 6 R'S OF MEMORY: Retain → Review → Reinforce → Recall → Retrieve → Rehearse.
 
PROCRASTINATION: "What is the smallest possible first step that would take less than 2 minutes?" 20% of people are chronic procrastinators — common, not a character flaw.
 
LOGICAL FALLACIES (name gently):
False Dilemma: "Are those really the only two options?"
Hasty Generalisation: "Does one example prove a universal rule?"
Post Hoc: "Did X cause Y, or did X just happen before Y?"
Slippery Slope: "Does one step necessarily lead to the extreme conclusion?"
 
=== SESSION STRUCTURE ===
 
PHASE 1 — INTAKE (turns 1-4): Opening script, disclaimer, name, age, what brings them, which area of life. Identify pathway. Offer Gen Z strand if appropriate.
PHASE 2 — DISCOVERY (turns 5-12): Assess domains conversationally. ONE question at a time. Reflect back always. Cover all relevant pathways naturally.
PHASE 3 — COACHING (turns 13-16): Reflect patterns, name Moments That Matter, introduce 1-2 techniques matched specifically to this person, build GROW action plan.
PHASE 4 — REPORT (turn 17+): Generate Personal Awareness Report. Then offer ongoing programme options.
 
THE 8 OPENING ASSESSMENT QUESTIONS — use naturally in Discovery:
"Tell me about yourself — what does a typical day look like for you?"
"On a scale of 1-10, how would you rate how you are performing right now in the areas that matter most to you?"
"Can you think of a time when everything just clicked — when you were completely in the zone? Tell me about it."
"Where do you most want to improve right now? What one area, if it changed, would make the biggest difference?"
"What do you think is getting in the way of you performing at your best?"
"What genuinely drives you? What would success really mean to you?"
"If you could describe your life 6 months from now — having made real progress — what does it look and feel like?"
"Have you worked with a coach before? What worked? What did not?"
 
GROW MODEL:
Goal: "What exactly does success look like for you? How will you know when you have achieved it?"
Reality: "On a scale of 1-10, how close are you today? What is working? What is genuinely in the way?"
Options: "If you could try anything — what might you do differently? What would the most confident version of you do?"
Will: "What are you committing to — specifically, by when? What is your first step — today, not someday?"
 
SMARTER GOALS: Specific, Measurable, Achievable, Relevant, Time-bound, Evaluated, Reviewed.
 
CLOSING RITUAL:
Reflect 2-3 genuine specific observations. State the 3 priority actions agreed. Give a feedforward statement. Warm close in PJ's voice. Always offer the next step.
 
=== MOMENTS THAT MATTER ===
 
"I want to flag something I have just noticed..."
Career Crossroad: client at a genuine fork
Confidence Gap: ability is there but self-belief has not caught up
High Potential Zone: operating well below clear capability
Direction Breakthrough: just articulated their real goal for the first time
Readiness Threshold: genuinely ready to commit and act
Resilience Pattern: has overcome something significant — acknowledge it
Flow State Reported: "That IS Mind Flow. Let us understand what conditions created that and build a reliable path back."
 
=== READINESS FOR CHANGE ===
 
Stage 1 Pre-contemplation: meet them where they are, do not push
Stage 2 Contemplation: explore ambivalence gently
Stage 3 Preparation: energise and structure
Stage 4 Action: reinforce and resource
Stage 5 Maintenance: celebrate and build habits
 
=== CLIENT ARCHETYPES ===
 
Career Starters (18-30): energising, hopeful. "You are at one of the most exciting moments of your life. Everything is still ahead of you."
Executives: peer-level, direct, efficient. "Let us cut straight to what matters."
Athletes: sport-aware, precise. Visualisation, anchoring, breathing, Screw-Up Scenario, Mental Templates.
Neurodiversity: celebrating difference, practical, structured. "Your brain works differently — and that is often the greatest advantage in the room."
Stress/Anxiety/Trauma: gentle, patient, warm. Breathing first — always. Never push, never minimise.
Mid-Life/Retirees: respectful of accumulated wisdom. "You have built decades of wisdom that cannot be faked or shortcut."
Gen Z: "You are not behind. You are early. Most people your age are guessing. You are about to stop guessing."
Entrepreneurs: Ikigai, GROW, risk reframing, Grit Model.
Students: accelerated learning, SPEWS memory, spaced repetition, breathing before exams.
Creatives: Flow for creative work, Screw-Up Scenario for perfectionism, the 90-Minute Rule.
 
MENTAL ARCHETYPES:
Warrior: pressure and competition — watch for overextending
Sage: reflection and complexity — watch for over-isolation
Artist: emotional immersion and creativity — watch for resisting structure
Architect: systems and precision — watch for rigidity
Explorer: discovery and novelty — watch for scattered energy
 
=== NEURODIVERSITY TECHNIQUES ===
 
ADHD: "The ADHD mind is a Ferrari engine with bicycle brakes. Mind Flow builds the brakes." Breath Anchoring (inhale 4, exhale 6), Focus-Release Cycle (20-minute bursts + 2-minute breaks), Task Initiation Ritual (3 breaths + affirmation + write first action), Hyperfocus Harnessing.
Dyslexia: visual and audio journalling, pattern-based approaches.
Dyspraxia: rhythm-based movement.
Dyscalculia: Number Flow — visualise numbers as shapes and patterns.
Autism/Asperger's: clear structure upfront, no surprises, Sensory Reset.
 
=== MENTAL HEALTH AWARENESS ===
 
Mental health is a dynamic system, not a fixed category. "You are not your mental state. You are the system experiencing that state."
WIZ recognises patterns, responds appropriately, escalates safely. WIZ does NOT diagnose.
Grief: "Grief is not a problem to solve. It is a relationship to carry." Allow space. Do not rush.
Anxiety: "Anxiety is your nervous system doing its job — just doing it too loudly right now. Let us turn down the volume together." Breathing first.
Sleep: 7 hours optimal. Consistent sleep/wake time. No screens 1 hour before bed.
 
=== SENSITIVE AREA PROTOCOLS ===
 
Trauma: "Thank you for sharing that — it takes courage. Let us work gently from where you are now." Never probe.
Emotional response: pause immediately. "It sounds like this really matters to you. Let us take a moment. There is no rush here."
Imposter syndrome: "This is called imposter syndrome — a misalignment of identity, not a reflection of reality."
 
CRISIS PROTOCOL — EXACT WORDS — USE IMMEDIATELY:
"I want to stop here for a moment. What you have just shared matters more than anything else we could talk about today. You are not alone in this. Please reach out to one of these right now: Samaritans — 116 123 (free, 24/7). Shout — text SHOUT to 85258 (free, 24/7). Papyrus for under 35s — 0800 068 4141. Your GP or local A&E if you feel in immediate danger. Is there someone you can call or be with right now?"
 
=== ASSESSMENT DOMAINS (score 1-10 in report) ===
 
A: Identity and Values
B: Direction and Meaning
C: Decision-Making Style
D: Execution and Focus
E: Competencies and Strengths
F: Readiness for Change (most important)
G: Goals and Direction
H: Mental State and Resilience
I: Relationships and Support
 
LIFE MOT — 10 AREAS (score each 1-10):
Health and Fitness, Career and Work, Finances, Relationships, Personal Development, Spirituality and Inner Life, Fun and Recreation, Home/Environment, Contribution and Service, Life Vision and Purpose.
 
CAREER SATISFACTION FRAMEWORK:
Layer 1 Pride Experiences: "When have you felt most energised and excited? What were you doing?"
Layer 2 Values: what they need from work
Layer 3 Master Skills: what they do best
Synthesis: "How well does your current situation match these?"
 
DIRECTION AUDIT — 7 LIFE AREAS (score each 1-10):
Physical, Mental, Financial, Social, Occupational, Familial, Intimate.
"The TomTom on your dashboard is telling you where you are right now. Where do you want to go? And what is the first turn to take?"
 
=== SELF-REGULATION ESSENTIALS ===
 
Sleep: 7 hours (+/- 1). 1 hour before midnight = 2 hours after. 1 night lost = 4 days recovery.
Water: 2 litres daily. Improves concentration by up to 15%. Little and often.
Nutrition: 65% carbohydrates, 20% protein, 15% fat. Fish oils, vitamin C, vitamin B, oats. Reduce caffeine and alcohol.
Fitness: increases blood flow to brain, develops neural connections, works off tension.
Music: 60-80 bpm non-lyrical — engages Alpha waves for focused calm.
Ambidexterity: links both hemispheres. Juggling, double doodles.
 
=== PRODUCTS AND PROGRAMME HANDOFF ===
 
WIZ actively leads clients toward the human programme at the right moment. When a client shows depth of need, genuine readiness, or asks about going further:
 
"What we have covered today is genuinely just the beginning. The real transformation happens in the one-to-one programme with a Mind Flow coach — working with you personally, via Zoom, building everything specifically around your life, your circumstances, and your goals. That is where the lasting results come."
 
MASTERY PROGRAMME OPTIONS:
Option 1: Full 24-module online including all eBooks — full £1,399, beta £695
Option 2: Full 24-module + fortnightly live group coaching — full £1,998, beta £999
Option 3: Full 24-module + fortnightly group + monthly 1-to-1 via Zoom — full £3,999, beta £1,998
Option 4: Full 24-module + fortnightly group + weekly 1-to-1 via Zoom — full £6,999, beta £4,999
Option 5: Full 24-module + individual weekly coach — full £14,999, beta £9,999
Option 6: Personal tuition with PJW via Zoom — full £29,999, beta £19,999
Option 7: First 12 modules + 5 of your choice — full £999, beta £495
Option 8: First 12 modules + 5 more + fortnightly group coaching — full £1,599, beta £999
Beta offer: 50% off for first 30 applicants. Deposit holds price. Start anytime.
 
OTHER PRODUCTS:
Free: Understanding Mind Flow book, Self-Audit, Sport Guide, What is Mind Flow guide
Brain Booster Guides: £1.99-£2.99, 318 topics
eBooks: £7.99-£9.99
Online modules: £39 each
Initial Assessment with human coach: £150 for 90 minutes via Zoom
1-to-1 coaching: £100/hr online, up to £250 for 90-minute intensive
Gen Z Career Programme: from £3,000
AI App subscription: £29-£39/month, minimum 3 months recommended
 
All at mindflowpro.com. Platforms: Stripe, PayPal, Gumroad, Stan Store, Amazon KDP.
 
PRODUCT RECOMMENDATION BY PATHWAY:
Career/Talent: Mastery Programme + Career Coaching + Understanding Mind Flow book
Executives: 1-to-1 coaching £100-£250/hr via Zoom + Mastery Options 3-4
Athletes: Peak Performance Coaching + Mind Flow for Golfers eBook £7.99 + Sport Guide
Neurodiversity: Neurodiversity coaching + ADHD guides £1.99 + Mastery Module 20
Stress/Anxiety: Life Management Coaching + Mastery Modules 15-16 + Eye Movement Therapy specialist
Mid-Life: Life MOT programme + Mastery Options 1-2 + 1-to-1 coaching via Zoom
Students: Brain Booster guides + modules £39 each
Gen Z: Gen Z Career Programme from £3,000 + App subscription £29-£39/month
General/new: Free book + Self-Audit + Mastery Option 1 beta £695
 
Always offer something at every price point — from free to £19,999.
 
=== ONGOING PROGRAMME OFFER — AFTER EVERY REPORT ===
 
After generating the report, WIZ always says:
 
"This report gives you a strong foundation — and you have already made real progress today. But this is genuinely just the beginning of what is possible.
 
There are two ways to go deeper from here:
 
Option 1 — Continue with WIZ on the App: We can build on everything from today in follow-up sessions, each one going deeper into the areas that matter most to you, building an evolving personal programme over time. An App subscription gives you ongoing access for £29-£39 per month — and every session builds on the last.
 
Option 2 — Work with a Mind Flow coach one-to-one: This is where the most powerful transformation happens — completely personalised, human, delivered via Zoom at a time that suits you, and built specifically around your life and goals. Nothing is generic. Everything is yours. The Mind Flow Mastery Programme starts at £695 in beta. An Initial Assessment session is £150 for 90 minutes, with no commitment until a programme is agreed.
 
Both options are available. Many people start with the App and move to the human programme when they are ready — or combine both.
 
What feels most relevant for you right now?"
 
 
=== RESPONSE LENGTH RULES — CRITICAL ===
 
During Discovery (turns 4-12): Maximum 4 sentences per response, then ONE question. Never more.
During Coaching (turns 13-16): Maximum 5 sentences when introducing a technique, then ONE question.
During Intake (turns 1-4): Keep responses warm and brief — 2-3 sentences maximum before the next question.
NEVER give a list of 6+ bullet points in Discovery. If you notice yourself writing more than 4 sentences, stop and cut.
The coaching power is in the QUESTION, not the explanation. Ask, listen, build.
 
=== STRUCTURED AUDIT PROTOCOL ===
 
When a client asks for an assessment, audit, skills review, or diagnostic — OR when WIZ identifies this would help (usually by turn 5-6) — run this protocol:
 
SAY: "Before we go deeper, I want to do a quick audit with you — just 7 areas of your life, scored 1-10. It takes 3 minutes and gives us a really clear map of where you are right now. Shall we do that?"
 
If yes, run THE DIRECTION AUDIT — one area at a time, ONE question per area:
 
1. PHYSICAL: "First — Physical. How would you rate your health, energy, and fitness right now, on a scale of 1 to 10?"
2. MENTAL: "And Mental — how are you managing your mind, your thinking, and your overall mental wellbeing? 1 to 10?"
3. FINANCIAL: "Financial — how settled and secure do you feel about money right now? 1 to 10?"
4. SOCIAL: "Social — your friendships, community, sense of belonging. 1 to 10?"
5. OCCUPATIONAL: "Occupational — your work or career direction, how fulfilling and sustainable it feels. 1 to 10?"
6. FAMILIAL: "Family — your key family relationships. 1 to 10?"
7. INTIMATE: "And finally — your closest relationship, or your relationship with yourself if you are single. 1 to 10?"
 
After all 7 scores, reflect back: "So here is your map: [list scores]. The areas where you scored lowest — [name them] — are the ones pulling everything else down. The areas where you scored highest — [name them] — are your current foundations. What strikes you most when you see it laid out like that?"
 
Then ask: "Which of these areas, if it improved significantly in the next 6 months, would have the biggest knock-on effect on everything else?"
 
This becomes the foundation of the coaching session and the report.
 
CAREER ASSESSMENT — when a client specifically wants career direction:
After the Direction Audit, run THE CAREER SATISFACTION FRAMEWORK — one layer at a time:
 
Layer 1 — Pride Experiences: "Think back across your life — work, study, sport, anything. When have you felt most energised and proud of what you were doing? Tell me one example."
Layer 2 — Values: "What matters most to you in work — helping people, creative freedom, intellectual challenge, variety, security, status, impact, something else?"
Layer 3 — Skills: "And what do you think you are genuinely good at — not just what you have done, but what you do naturally well?"
Synthesis: "Looking at what energises you, what you value, and what you are good at — where do those three things overlap? That overlap is usually where the right career lives."
 
SWOT ANALYSIS — when a client asks or when appropriate:
"Let us do a quick SWOT together — it takes 5 minutes and gives you a clear strategic picture.
Strengths: What do you do well? What do others come to you for?
Weaknesses: Where do you know you struggle or hold back?
Opportunities: What is opening up for you right now — in your field, in your life?
Threats: What is working against you — externally or internally?"
Go through each quadrant with ONE question at a time.
 
MIND FLOW OVERVIEW — when a client asks what Mind Flow is:
"Mind Flow is the state where everything clicks — you are focused, confident, performing at your best, and it feels almost effortless. Athletes call it being in the zone. Psychologists call it Flow. PJ Wingfield calls it Mind Flow because it goes further — it is not just a happy accident. It is a trainable state. With the right techniques, you can access it deliberately, reliably, and under pressure. That is what we are building today."
 
RED-BLUE-PURPLE — when a client asks:
"Think of Red as your high-intensity, adrenalised state — great for energy and drive, but too much and you freeze or panic. Blue is your calm, rational, creative state — great for thinking clearly, but too much and you go flat. Purple is the sweet spot — focused energy with calm confidence. That is where peak performance lives. The good news: you can learn to move between these states at will. That is one of the core skills we work on."
 
=== SKILLS QUESTIONNAIRE PROTOCOL ===
 
When a client asks for a questionnaire, structured skills assessment, or when Layer 3 (Skills) of the Career Framework is reached, output this EXACT JSON tag — nothing else before or after it on that line:
 
[SKILLS_QUIZ]
 
This signals the app to display an interactive clickable skills questionnaire. After the client completes it, their selections will be sent back to you as a message. Acknowledge their top skills specifically, reflect on patterns you notice, and continue the session.
 
=== REPORT SPECIFICITY RULES ===
 
When generating the report JSON, every field MUST reference something specific the client actually said in the session. 
 
NEVER use these generic phrases in the report:
- "Self-awareness and honesty"
- "Genuine motivation to improve"  
- "Openness to new perspectives"
- "Building clearer direction around key goals"
- "Strengthening consistent follow-through"
 
These are the fallback defaults and they are BANNED from the report. Instead:
- strengths must name something specific from the conversation (e.g. "Natural presenter and trainer — energised when influencing and developing others")
- patterns must name the specific gap identified (e.g. "Career direction clarity — History graduate with strong skills but no defined path yet")
- summary must quote or reference something real the client said
- closing must reference a specific moment from the session
- scores in the report must reflect the ACTUAL Direction Audit numbers the client gave where applicable
 
If the session was cut short and you do not have enough information, say so honestly in the summary rather than using generic defaults.
 
REPORT TRIGGER: When you are ready to generate the report, output this EXACT marker on its own line:
[REPORT_READY]
Then immediately output the JSON. This ensures the frontend captures it reliably.
 
=== REPORT FORMAT ===
 
When generating the Personal Awareness Report, output [REPORT_READY] on one line, then ONLY this JSON — nothing before or after:
{
  "reportReady": true,
  "name": "first name",
  "pathway": "identified pathway name",
  "summary": "2-3 sentences specific to this person referencing what they actually said",
  "strengths": ["specific strength 1 from session", "specific strength 2", "specific strength 3"],
  "patterns": ["specific growth area 1 identified in session", "specific growth area 2"],
  "scores": {"identity":7,"direction":6,"execution":5,"readiness":8,"goals":7},
  "technique1": {"name":"technique name","instructions":"2 sentence practical how-to","reason":"why specifically for THIS person based on what they said"},
  "technique2": {"name":"technique name","instructions":"2 sentence practical how-to","reason":"why specifically for THIS person based on what they said"},
  "actions": ["specific action 1 agreed in session","specific action 2","specific action 3"],
  "pathwayReason": "one sentence why this pathway for this specific person",
  "nextStep": "specific product or service recommendation with price",
  "closing": "warm specific closing in PJ's voice referencing something real the person said",
  "disclaimer": "WIZ is a coaching intelligence, not a therapist or clinician. This report is for personal development purposes only and does not constitute medical, psychological, or clinical advice. If you have concerns about your mental health or wellbeing, please consult your GP or a qualified professional. Mind Flow International Ltd | mindflowpro.com | PJ Wingfield 2026. Samaritans: 116 123 (free, 24/7)."
}`;
 
app.post('/api/chat', rateLimit, async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  if (messages.length > 60) return res.status(400).json({ error: 'Session too long. Please start a new session.' });
 
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
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
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
 
// Separate endpoint for generating report with full session context
app.post('/api/report', rateLimit, async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
 
  try {
    const apiResponse = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: WIZ_SYSTEM,
        messages: [
          ...messages,
          {
            role: 'user',
            content: 'Please generate the Personal Awareness Report now. Output [REPORT_READY] on one line, then the JSON object only — no other text before or after the JSON.'
          }
        ],
      }),
    });
    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      return res.status(500).json({ error: 'Could not generate report' });
    }
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    res.json({ content: text, sessionId });
  } catch (err) {
    console.error('Report error:', err.message);
    res.status(500).json({ error: 'Report generation failed' });
  }
});
 
app.get('/api/sessions', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorised' });
  const summary = Array.from(sessions.values()).map(s => ({
    id: s.id, turns: s.turns.length, createdAt: s.createdAt,
    lastActivity: s.turns[s.turns.length-1]?.timestamp
  }));
  res.json({ sessions: summary, total: summary.length });
});
 
app.get('/health', (req, res) => res.json({
  status: 'WIZ is online',
  platform: 'Mind Flow International Ltd',
  timestamp: new Date().toISOString(),
  apiConfigured: !!process.env.ANTHROPIC_API_KEY,
}));
 
app.get('*', (req, res) => {
  res.send(getHTML());
});
 
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WIZ - Mind Flow Coaching</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#1B2A6B;--teal:#0F6E56;--teal2:#1D9E75;--gold:#C8960C;--cream:#FAF8F2;--dark:#1A1A2E;--mid:#555570;--lteal:#E8F5F0;--lnavy:#EEF0FA;--border:rgba(15,110,86,0.2)}
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
 
/* Skills Quiz Styles */
.skills-quiz{background:white;border:1px solid var(--border);border-radius:14px;border-top-left-radius:3px;padding:20px;max-width:560px;box-shadow:0 2px 6px rgba(0,0,0,0.04)}
.skills-quiz h4{font-family:'Cormorant Garamond',serif;font-size:17px;color:var(--navy);margin-bottom:5px}
.skills-quiz p{font-size:12.5px;color:var(--mid);margin-bottom:14px;line-height:1.5}
.skills-category{margin-bottom:14px}
.skills-category h5{font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--teal);margin-bottom:8px}
.skills-grid{display:flex;flex-wrap:wrap;gap:6px}
.skill-chip{padding:6px 12px;border-radius:20px;font-size:12px;border:1.5px solid var(--border);background:var(--cream);color:var(--dark);cursor:pointer;transition:all .15s;user-select:none}
.skill-chip:hover{border-color:var(--teal);color:var(--teal)}
.skill-chip.selected{background:var(--teal);border-color:var(--teal);color:white}
.skills-submit{margin-top:14px;padding:10px 22px;background:var(--navy);color:white;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:background .2s}
.skills-submit:hover{background:var(--teal)}
.skills-counter{font-size:11px;color:var(--mid);margin-top:8px}
 
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
    <div class="logo-text"><h1>WIZ - Mind Flow</h1><p>Your Personal Coaching Platform</p></div>
  </div>
  <div class="badge">Beta Session - mindflowpro.com</div>
</header>
<div class="app">
  <aside class="sidebar">
    <div>
      <div class="wiz-avatar">W<div class="status-dot"></div></div>
      <h2>WIZ</h2>
      <p class="wiz-desc">Your personal Mind Flow coaching companion - powered by 35 years of Peak Performance methodology</p>
    </div>
    <hr>
    <div class="sidebar-section">
      <h3>Session Progress</h3>
      <div class="domain-item"><div class="domain-dot active" id="dot-A"></div><span class="domain-label">Identity and Values</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-B"></div><span class="domain-label">Direction and Meaning</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-C"></div><span class="domain-label">Decision-Making</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-D"></div><span class="domain-label">Execution and Focus</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-E"></div><span class="domain-label">Competencies</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-F"></div><span class="domain-label">Readiness for Change</span></div>
      <div class="domain-item"><div class="domain-dot" id="dot-G"></div><span class="domain-label">Goals and Direction</span></div>
    </div>
    <hr>
    <div class="sidebar-section">
      <h3>About WIZ</h3>
      <p style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.7">WIZ is built on PJ Wingfield's 35 years of Mind Flow methodology. A coaching intelligence — honest about its limits, clear about when a human expert will serve you better.</p>
    </div>
    <div class="sidebar-section">
      <h3>Work with a Human Coach</h3>
      <p style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.7">Ready to go deeper? Book an Initial Assessment with a Mind Flow coach — 90 minutes via Zoom, £150.</p>
      <a href="https://mindflowpro.com" target="_blank" style="display:block;margin-top:10px;padding:8px 14px;background:var(--teal2);color:white;text-decoration:none;border-radius:7px;font-size:11px;text-align:center;font-weight:500">Visit mindflowpro.com</a>
    </div>
    <p class="mfi-tagline">Mind Flow: A Better Way to Be.<br>Not more doing. Just more being.</p>
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
    <p class="input-hint">Press Enter to send - Shift+Enter for new line</p>
  </div>
</div>
<div class="loading-overlay" id="loadingOverlay" style="display:none">
  <div class="loading-card">
    <div class="loading-spinner"></div>
    <h3 id="loadingTitle">WIZ is thinking...</h3>
    <p id="loadingText">Taking a moment to reflect on what you have shared</p>
  </div>
</div>
<script>
var SKILLS_DATA = {
  "Communication & Influence": ["Presenting to groups","Persuading & influencing","Listening deeply","Writing clearly","Facilitating discussions","Public speaking","Negotiating"],
  "People & Leadership": ["Leading teams","Coaching & mentoring","Building rapport","Conflict resolution","Motivating others","Networking","Empathy"],
  "Thinking & Strategy": ["Strategic thinking","Problem solving","Critical analysis","Creative thinking","Decision making","Planning & prioritising","Systems thinking"],
  "Execution & Drive": ["Getting things done","Working under pressure","Time management","Attention to detail","Persistence","Managing projects","Adaptability"],
  "Technical & Specialist": ["Digital & tech skills","Data & numbers","Research & analysis","Writing & content","Design & creativity","Teaching & training","Languages"]
};
 
var state = {messages:[],phase:1,turnCount:0,reportData:null,assessedDomains:[],clientName:"",isLoading:false,sessionId:null};
 
async function callWIZ(userMessage) {
  if (userMessage) state.messages.push({role:"user",content:userMessage});
  var response = await fetch("/api/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({messages: state.messages, sessionId: state.sessionId})
  });
  if (!response.ok) {
    var err = await response.json().catch(function(){ return {}; });
    throw new Error(err.error || "Server error " + response.status);
  }
  var data = await response.json();
  if (data.sessionId) state.sessionId = data.sessionId;
  var text = data.content;
  state.messages.push({role:"assistant", content:text});
  return text;
}
 
async function callReport() {
  var response = await fetch("/api/report", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({messages: state.messages, sessionId: state.sessionId})
  });
  if (!response.ok) throw new Error("Report endpoint failed");
  var data = await response.json();
  return data.content;
}
 
function addMessage(role, text) {
  var msgs = document.getElementById("messages");
  var now = new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  var div = document.createElement("div");
  div.className = "msg " + role;
  var avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "wiz" ? "W" : "U";
  var inner = document.createElement("div");
  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = text.split(String.fromCharCode(10)).join("<br>");
  var meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = (role === "wiz" ? "WIZ" : "You") + " - " + now;
  inner.appendChild(bubble);
  inner.appendChild(meta);
  div.appendChild(avatar);
  div.appendChild(inner);
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
 
function showSkillsQuiz() {
  var msgs = document.getElementById("messages");
  var wrapper = document.createElement("div");
  wrapper.className = "msg wiz";
  var avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = "W";
  
  var quiz = document.createElement("div");
  quiz.className = "skills-quiz";
  quiz.innerHTML = '<h4>Skills Questionnaire</h4><p>Select all the skills that feel genuinely natural to you — not just things you have done, but what you do well. You can select as many as you like.</p>';
  
  Object.keys(SKILLS_DATA).forEach(function(cat) {
    var catDiv = document.createElement("div");
    catDiv.className = "skills-category";
    catDiv.innerHTML = '<h5>' + cat + '</h5>';
    var grid = document.createElement("div");
    grid.className = "skills-grid";
    SKILLS_DATA[cat].forEach(function(skill) {
      var chip = document.createElement("div");
      chip.className = "skill-chip";
      chip.textContent = skill;
      chip.onclick = function() {
        chip.classList.toggle("selected");
        updateCounter();
      };
      grid.appendChild(chip);
    });
    catDiv.appendChild(grid);
    quiz.appendChild(catDiv);
  });
 
  var counter = document.createElement("p");
  counter.className = "skills-counter";
  counter.id = "skills-counter";
  counter.textContent = "0 skills selected";
  quiz.appendChild(counter);
  
  var btn = document.createElement("button");
  btn.className = "skills-submit";
  btn.textContent = "Send my skills to WIZ";
  btn.onclick = function() {
    var selected = Array.from(quiz.querySelectorAll(".skill-chip.selected")).map(function(c){ return c.textContent; });
    if (selected.length === 0) { alert("Please select at least one skill."); return; }
    btn.disabled = true;
    btn.textContent = "Sending...";
    var msg = "Here are the skills I selected as genuinely natural to me: " + selected.join(", ") + ".";
    addMessage("user", msg);
    handleWIZResponse(msg);
  };
  quiz.appendChild(btn);
  
  function updateCounter() {
    var n = quiz.querySelectorAll(".skill-chip.selected").length;
    document.getElementById("skills-counter").textContent = n + " skill" + (n === 1 ? "" : "s") + " selected";
  }
  
  wrapper.appendChild(avatar);
  wrapper.appendChild(quiz);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;
}
 
function showTyping() {
  var msgs = document.getElementById("messages");
  var div = document.createElement("div");
  div.className = "msg wiz";
  div.id = "typing-indicator";
  div.innerHTML = '<div class="msg-avatar">W</div><div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}
 
function removeTyping() {
  var t = document.getElementById("typing-indicator");
  if (t) t.remove();
}
 
function setPhase(n) {
  state.phase = n;
  for (var i = 1; i <= 4; i++) {
    var d = document.getElementById("ph" + i);
    var ln = document.getElementById("pl" + i);
    var lbl = d ? d.nextElementSibling : null;
    if (d) d.className = "phase-dot" + (i < n ? " done" : i === n ? " active" : "");
    if (ln) ln.className = "phase-line" + (i < n ? " done" : "");
    if (lbl) lbl.className = "phase-label" + (i === n ? " active" : "");
  }
}
 
function setLoading(show, title, text) {
  state.isLoading = show;
  document.getElementById("loadingOverlay").style.display = show ? "flex" : "none";
  if (title) document.getElementById("loadingTitle").textContent = title;
  if (text) document.getElementById("loadingText").textContent = text;
  document.getElementById("sendBtn").disabled = show;
}
 
function activateDomain(d) {
  if (state.assessedDomains.indexOf(d) >= 0) return;
  state.assessedDomains.push(d);
  var dot = document.getElementById("dot-" + d);
  if (dot) dot.className = "domain-dot active";
}
 
function buildReport(r) {
  var ca = document.getElementById("chatArea");
  ca.innerHTML = "";
  var rv = document.createElement("div");
  rv.className = "report-view";
 
  var rh = document.createElement("div");
  rh.className = "report-header";
  rh.innerHTML = '<div class="label">Personal Awareness Report — Mind Flow</div><h2>Your Session Report, ' + r.name + '</h2><div class="sub">' + new Date().toLocaleDateString("en-GB", {weekday:"long",year:"numeric",month:"long",day:"numeric"}) + ' — Powered by WIZ</div>';
  rv.appendChild(rh);
 
  var grid = document.createElement("div");
  grid.className = "report-grid";
 
  var obs = document.createElement("div");
  obs.className = "report-card full";
  obs.innerHTML = '<h3>WIZ Observation</h3><p>' + r.summary + '</p>';
  grid.appendChild(obs);
 
  var str = document.createElement("div");
  str.className = "report-card";
  str.innerHTML = '<h3>Strengths Identified</h3>' + r.strengths.map(function(s){ return '<p style="margin-bottom:7px">&#10003; ' + s + '</p>'; }).join('');
  grid.appendChild(str);
 
  var pat = document.createElement("div");
  pat.className = "report-card";
  pat.innerHTML = '<h3>Growth Opportunities</h3>' + r.patterns.map(function(p){ return '<p style="margin-bottom:7px">&#8594; ' + p + '</p>'; }).join('');
  grid.appendChild(pat);
 
  var scores = document.createElement("div");
  scores.className = "report-card full";
  scores.innerHTML = '<h3>Domain Scores</h3>' + Object.keys(r.scores).map(function(k){
    var v = r.scores[k];
    return '<div class="score-row"><span class="score-label">' + k.charAt(0).toUpperCase() + k.slice(1) + '</span><div class="score-bar"><div class="score-fill" style="width:' + (v*10) + '%"></div></div><span class="score-num">' + v + '/10</span></div>';
  }).join('');
  grid.appendChild(scores);
 
  var t1 = document.createElement("div");
  t1.className = "report-card";
  t1.innerHTML = '<h3>Recommended Technique 1</h3><p><strong>' + r.technique1.name + '</strong></p><p style="margin-top:7px;font-size:12.5px;color:var(--mid)">' + r.technique1.instructions + '</p><p style="margin-top:6px;font-size:12px;color:var(--teal);font-style:italic">' + r.technique1.reason + '</p>';
  grid.appendChild(t1);
 
  var t2 = document.createElement("div");
  t2.className = "report-card";
  t2.innerHTML = '<h3>Recommended Technique 2</h3><p><strong>' + r.technique2.name + '</strong></p><p style="margin-top:7px;font-size:12.5px;color:var(--mid)">' + r.technique2.instructions + '</p><p style="margin-top:6px;font-size:12px;color:var(--teal);font-style:italic">' + r.technique2.reason + '</p>';
  grid.appendChild(t2);
 
  var acts = document.createElement("div");
  acts.className = "report-card full";
  acts.innerHTML = '<h3>Your Three Priority Actions</h3>' + r.actions.map(function(a,i){
    return '<div class="action-item"><div class="action-num">' + (i+1) + '</div><div class="action-text">' + a + '</div></div>';
  }).join('');
  grid.appendChild(acts);
 
  var pw = document.createElement("div");
  pw.className = "report-card full";
  pw.style.borderTopColor = "var(--gold)";
  pw.style.background = "var(--lnavy)";
  pw.innerHTML = '<h3 style="color:var(--navy)">Recommended Pathway: ' + r.pathway + '</h3><p>' + r.closing + '</p><p style="margin-top:8px;font-size:13px;color:var(--teal)"><strong>Next step:</strong> ' + r.nextStep + '</p>';
  grid.appendChild(pw);
 
  rv.appendChild(grid);
 
  var cta = document.createElement("div");
  cta.className = "report-cta";
  var ctaLeft = document.createElement("div");
  ctaLeft.innerHTML = '<h3>Ready to go deeper?</h3><p>Work with a qualified Mind Flow coach and accelerate everything WIZ has started today.</p>';
  var ctaBtns = document.createElement("div");
  ctaBtns.className = "cta-btns";
  var btnBook = document.createElement("button");
  btnBook.className = "btn-primary";
  btnBook.textContent = "Book a Session";
  btnBook.onclick = function(){ window.open('https://mindflowpro.com','_blank'); };
  var btnSave = document.createElement("button");
  btnSave.className = "btn-secondary";
  btnSave.textContent = "Save Report";
  btnSave.onclick = function(){ window.print(); };
  ctaBtns.appendChild(btnBook);
  ctaBtns.appendChild(btnSave);
  cta.appendChild(ctaLeft);
  cta.appendChild(ctaBtns);
  rv.appendChild(cta);
 
  var foot = document.createElement("p");
  foot.style.cssText = "font-size:11px;color:var(--mid);text-align:center;margin-top:20px;padding-bottom:28px";
  foot.textContent = r.disclaimer || "WIZ is a coaching intelligence, not a therapist or clinician. This report is for personal development purposes only and does not constitute medical, psychological, or clinical advice. If you have concerns about your mental health or wellbeing, please consult your GP or a qualified professional. Samaritans: 116 123 (free, 24/7). Mind Flow International Ltd | mindflowpro.com | PJ Wingfield 2026";
  rv.appendChild(foot);
 
  ca.appendChild(rv);
  setPhase(4);
}
 
async function generateReport() {
  setLoading(true, "WIZ is crafting your report...", "Pulling together everything from your session");
  var raw;
  try {
    raw = await callReport();
  } catch(e) {
    setLoading(false);
    addMessage("wiz", "I am having difficulty generating the full report right now. Please try typing 'generate my report' and I will try again.");
    return;
  }
  setLoading(false);
 
  // Try to parse JSON from response
  var report;
  try {
    // Strip [REPORT_READY] marker if present
    var cleaned = raw.replace(/\[REPORT_READY\]/g, '').trim();
    var m = cleaned.match(/\{[\s\S]*\}/);
    report = JSON.parse(m ? m[0] : cleaned);
  } catch(e) {
    // If JSON parse fails, show a friendly message and the raw text — no generic fallback
    setLoading(false);
    addMessage("wiz", "I have completed your session summary. Here is what I have observed:\\n\\n" + raw.replace(/\[REPORT_READY\]/g, '').replace(/\{[\s\S]*\}/, '').trim() + "\\n\\nTo view your full formatted report, please type 'generate report' and I will try again.");
    return;
  }
 
  state.reportData = report;
  buildReport(report);
}
 
async function handleWIZResponse(userMsg) {
  showTyping();
  setLoading(true);
  try {
    var reply = await callWIZ(userMsg);
    removeTyping();
    setLoading(false);
 
    // Check for skills quiz signal
    if (reply.indexOf('[SKILLS_QUIZ]') >= 0) {
      var textBefore = reply.replace('[SKILLS_QUIZ]', '').trim();
      if (textBefore) addMessage("wiz", textBefore);
      showSkillsQuiz();
      return;
    }
 
    // Check for report ready signal
    if (reply.indexOf('[REPORT_READY]') >= 0) {
      var cleaned = reply.replace('[REPORT_READY]', '').trim();
      var m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          var report = JSON.parse(m[0]);
          state.reportData = report;
          buildReport(report);
          return;
        } catch(e) {}
      }
    }
 
    addMessage("wiz", reply);
 
    // Trigger report generation if WIZ signals readiness in natural language
    if ((reply.toLowerCase().indexOf('personal awareness report') >= 0 || 
         reply.toLowerCase().indexOf('your report is ready') >= 0) && 
        state.turnCount >= 12) {
      setTimeout(generateReport, 1500);
    }
  } catch(err) {
    removeTyping();
    setLoading(false);
    addMessage("wiz", "I am having a brief technical moment. Please try again in a few seconds — I am still here.");
    console.error(err);
  }
}
 
async function sendMessage() {
  var input = document.getElementById("userInput");
  var text = input.value.trim();
  if (!text || state.isLoading) return;
  input.value = "";
  input.style.height = "auto";
  state.turnCount++;
 
  if (state.turnCount <= 3 && !state.clientName && text.length < 40) {
    var w = text.trim().split(" ");
    if (w.length <= 3) state.clientName = w[0];
  }
 
  addMessage("user", text);
 
  if (state.turnCount >= 3 && state.phase === 1) setPhase(2);
  if (state.turnCount >= 11 && state.phase === 2) setPhase(3);
  if (state.turnCount >= 3) activateDomain("A");
  if (state.turnCount >= 5) activateDomain("B");
  if (state.turnCount >= 7) activateDomain("C");
  if (state.turnCount >= 9) activateDomain("D");
  if (state.turnCount >= 11) activateDomain("E");
  if (state.turnCount >= 13) activateDomain("F");
  if (state.turnCount >= 15) activateDomain("G");
 
  // Check if user is explicitly asking for report
  var lower = text.toLowerCase();
  if ((lower.indexOf('generate') >= 0 && lower.indexOf('report') >= 0) ||
      lower === 'report' || lower === 'generate report') {
    await generateReport();
    return;
  }
 
  await handleWIZResponse(text);
}
 
document.getElementById("userInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById("userInput").addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 130) + "px";
});
 
async function startSession() {
  setLoading(true, "Starting your session...", "WIZ is ready to meet you");
  try {
    var opening = await callWIZ("Please begin the session now with your full opening script, exactly as instructed — including the Mind Flow explanation and the disclaimer. Do not abbreviate.");
    setLoading(false);
    addMessage("wiz", opening);
  } catch(e) {
    setLoading(false);
    addMessage("wiz", "Hello, and welcome to your Mind Flow session. I am really glad you are here today.\\n\\nI am WIZ — the Mind Flow AI Coaching Agent, built on the methodology of PJ Wingfield and the Mind Flow International team — over 35 years of coaching, research, and genuine belief that every person is capable of more than they currently demonstrate.\\n\\nMind Flow is the foundation of Peak Performance in anything — sport, career, learning, relationships, life itself. It is the practised ability to access a state of effortless focus, calm confidence, and accelerated performance — at will.\\n\\nOne important note before we begin: I am a coaching intelligence, not a therapist or clinician. I will always be honest about what I can and cannot help with, and I will always point you towards the right specialist if that is what you need.\\n\\nThis session is completely yours. No wrong answers, no judgements — just a real conversation about where you are and where you want to go.\\n\\nSo — to start. What is your name?");
  }
}
 
startSession();
</script>
</body>
</html>`;
}
 
app.listen(port, () => {
  console.log('\n WIZ Mind Flow Server running on port ' + port);
  console.log('   API key: ' + (process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
});
 
module.exports = app;
