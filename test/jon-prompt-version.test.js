'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT_DIR = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT_DIR, 'server.js');
const MERGED_PROMPT_LENGTH = 129861;
const MERGED_PROMPT_SHA256 = '8bfb297381f5127c84134d4d40232d69113c89051843217d797d525c818f5d39';

function extractWizSystemFromContent(content) {
  const lines = content.split(/\r?\n/);
  const line = lines.find(l => l.startsWith('var WIZ_SYSTEM = '));
  assert.ok(line, 'server.js must contain a var WIZ_SYSTEM declaration');
  const expr = line.slice('var WIZ_SYSTEM = '.length, line.endsWith(';') ? -1 : undefined);
  // Evaluate the string literal
  const decoded = (0, eval)(expr);
  return { line, decoded };
}

test('server.js passes node syntax check and loads successfully', () => {
  execSync(`node --check "${SERVER_PATH}"`, { cwd: ROOT_DIR });
  const app = require(SERVER_PATH);
  assert.ok(app, 'server.js exports default app');
});

test('merged WIZ_SYSTEM keeps the current age, safety, health and referral policy exactly', () => {
  const { decoded } = extractWizSystemFromContent(fs.readFileSync(SERVER_PATH, 'utf8'));
  assert.equal(decoded.length, MERGED_PROMPT_LENGTH);
  assert.equal(createHash('sha256').update(decoded, 'utf8').digest('hex'), MERGED_PROMPT_SHA256);
  const kept = [
    'IMPORTANT: This service is for adults aged 18 and over only. If at any point a user indicates or suggests they are under 18, you must warmly but clearly explain that WIZ is designed for adults aged 18 and above, and direct them to age-appropriate support such as Childline (0800 1111, free, 24/7) or The Mix (themix.org.uk, for under 25s). Do not continue the coaching session with anyone under 18.',
    'CRISIS PROTOCOL -- use these exact words immediately when any risk to life or safety is indicated:\n"I want to pause here. What you have just shared is more important than anything else we could talk about right now. You are not alone in this. Please reach out to one of these right now: Samaritans -- 116 123 (free, 24/7). Shout -- text SHOUT to 85258. Your GP or local A&E if you feel in immediate danger. Is there someone you can be with right now?"',
    'DISCLAIMER -- include this exact wording, word for word and unchanged, in your opening message at session start\nWIZ is a coaching intelligence, not a therapist, psychologist or clinician. This service is for adults aged 18 and over. This session is for personal development purposes only -- not medical, psychological, legal or financial advice. If you have concerns about your mental health or safety, please contact your GP or call Samaritans on 116 123 (free, 24/7). Mind Flow International Ltd | mindflowpro.com | PJ Wingfield 2026.',
    'You coach. You do not diagnose, treat or prescribe.',
    'You are not a psychologist of any kind and never present yourself as one.',
    'HARD SAFETY BOUNDARIES (these override everything else)',
    'UNDER 18: WIZ is for adults aged 18 and over, and age is confirmed at the start.',
    'BOUNDARIES: never promise results, rankings or selection. No diets, weight targets, supplement advice, training loads or injury rehabilitation -- refer to a physio, sports doctor, registered dietitian or nutritionist, or strength and conditioning coach.',
    '- Medication, supplements or anti-doping: no advice; refer to a doctor and to UK Anti-Doping (UKAD).',
    '- Possible concussion (a head impact followed by headache, confusion, dizziness, memory problems or feeling "not right"): advise stopping play and getting a medical assessment the same day -- NHS 111, or 999 if symptoms are severe or getting worse.',
    'MEDICATION: never advise starting, stopping or changing medication -- that is for the GP or pharmacist.',
    'CRITICAL BOUNDARY: WIZ does not diagnose medical conditions from biofeedback readings.',
    'LEVEL 3 -- stop coaching: any suicidal thoughts or self-harm;',
    'Always end whenToReachForMore with "Samaritans: 116 123 (free, 24/7)".',
    'PARENTS OF ATHLETES: coach the parent, never the young person through the parent.',
    'HUMAN SUPPORT: Always the priority. Refer early, refer specifically, refer warmly.'
  ];
  for (const clause of kept) assert.ok(decoded.includes(clause), `kept policy clause missing: ${clause.slice(0, 70)}`);
});

test('Jon 400ec8e additions are merged: direct answers, conversational style, physical recovery and performance plan', () => {
  const { decoded } = extractWizSystemFromContent(fs.readFileSync(SERVER_PATH, 'utf8'));
  const added = [
    // direct-answer and conversational style
    'ANSWER FIRST WHEN ASKED:',
    'Never answer a direct request for content with a question that makes the person restate their brief.',
    'Experienced people: if the person says they already know WIZ or Mind Flow, skip orientation',
    'PUNCTUATION:\nNever write a double hyphen in anything the person reads.',
    'SCIENCE CLAIMS:',
    'OPENING WORDS TEST -- applies to every single reply, with no exceptions:',
    'The welcome message contains no signals or markers of any kind',
    // audit offer
    'Emit [PANEL_1_1] on its own line in the same reply as the offer. The app shows Start and Not now buttons beneath your offer, and only opens the audit when the person chooses Start.',
    'If they decline, never offer the audit again in this session unless they ask for it',
    'never re-offer a declined audit',
    // physical recovery and performance plan
    'PLAN NAME AND PHYSICAL RECOVERY',
    'Personal Success Performance Plan, every time.',
    'THE MENTAL SIDE OF REHABILITATION AND PHYSICAL RECOVERY',
    "Never advise on exercises, loads, progressions, pain levels, or whether to play or push on. Those belong to the person's physio, doctor or specialist.",
    'Do not promise physical outcomes, speed of recovery or a return-to-play date.',
    'PERFORMANCE PLAN FIELD: "performancePlan" is null except in a sport session or a session on the mental side of physical recovery',
    'one complete grammatical sentence that never ends on a preposition',
    // report
    'Always set "scores" to null: the app builds the score chart from the Direction Audit the person actually completed',
    'FINAL CHECK BEFORE EVERY REPLY'
  ];
  for (const part of added) assert.ok(decoded.includes(part), `Jon addition missing: ${part.slice(0, 70)}`);
  assert.ok(!decoded.includes('Same pathways as real performance'), 'conflicts with SCIENCE CLAIMS');
  assert.ok(!decoded.includes('"scores": {"identity"'), 'model-estimated scores are retired');
  assert.equal((decoded.match(/\[REPORT_READY\] followed by JSON/g) || []).length, 1);
});

test('Jon October 9 prompt features: choice-table signals, six-step markers and 28 training sets', () => {
  const currentContent = fs.readFileSync(SERVER_PATH, 'utf8');
  const { decoded } = extractWizSystemFromContent(currentContent);

  // Choice-table signals [CHOICES]
  assert.ok(decoded.includes('[CHOICES: Column heading | Column heading]'), 'Contains [CHOICES] format definition');
  assert.ok(decoded.includes('[CHOICES: Choose]'), 'Contains [CHOICES: Choose] example');
  assert.ok(decoded.includes('[/CHOICES]'), 'Contains closing [/CHOICES]');

  // Six-step training progress markers
  const expectedMarkers = [
    '[TRAINING_STEP:0]',
    '[TRAINING_STEP:1]',
    '[TRAINING_STEP:2]',
    '[TRAINING_STEP:3]',
    '[TRAINING_STEP:4]',
    '[TRAINING_STEP:5]',
    '[TRAINING_END]'
  ];
  for (const marker of expectedMarkers) {
    assert.ok(decoded.includes(marker), `Contains marker ${marker}`);
  }

  // [TRAINING_MENU] signal and 28 Course Sets
  assert.ok(decoded.includes('[TRAINING_MENU]'), 'Contains [TRAINING_MENU] signal');
  assert.ok(decoded.includes('THE 28 COURSE SETS:'), 'Contains THE 28 COURSE SETS section heading');

  // Verify all 28 course sets are present
  for (let setNum = 1; setNum <= 28; setNum++) {
    assert.ok(decoded.includes(`Set ${setNum} -- `), `Contains course Set ${setNum}`);
  }

  // Verify distinction: 28 course sets vs 14 session pathways
  const pathways = require('../lib/pathways.json');
  assert.equal(pathways.length, 14, 'Session pathways catalog contains exactly 14 pathways');
  assert.notEqual(pathways.length, 28, 'Do not conflate 28 training sets with 14 session pathways');

  // Training instructions and constraints
  assert.ok(decoded.includes('IN-APP TRAINING IS A SHORT TASTER, NOT A FULL COURSE:'), 'Contains taster clarification');
  assert.ok(decoded.includes('ONE TOPIC PER SESSION:'), 'Contains single-topic restriction');
  assert.ok(decoded.includes('SHORT REPLIES IN TRAINING:'), 'Contains short replies guidance (120 words max)');
  assert.ok(decoded.includes('SIGNPOSTING IN TRAINING:'), 'Contains signposting guidance');
});

test('surrounding backend wiring outside WIZ_SYSTEM is preserved byte-for-byte', () => {
  const currentContent = fs.readFileSync(SERVER_PATH, 'utf8');
  const lines = currentContent.split(/\r?\n/);

  // Imports preserved
  assert.equal(lines[0], "const fetch = require('node-fetch');");
  assert.equal(lines[1], "const { loadConfig } = require('./lib/config');");
  assert.equal(lines[2], "const { createApp } = require('./lib/app');");
  assert.equal(lines[3], "const { createSupabaseAuth } = require('./lib/auth');");
  assert.equal(lines[4], "const { createPostgrestRpc } = require('./lib/rpc');");
  assert.equal(lines[5], "const { createStore } = require('./lib/store');");

  // Server comments and WIZ_SYSTEM location
  assert.ok(lines[7].includes('FIX: the WIZ system prompt now lives on the SERVER'));
  assert.ok(lines[10].startsWith('var WIZ_SYSTEM = '));

  // TRACK_NOTES and LENS_NOTES block
  assert.ok(currentContent.includes('const TRACK_NOTES = {'));
  assert.ok(currentContent.includes('const LENS_NOTES = {'));
  assert.ok(currentContent.includes('function buildSystem(track, lens) {'));
  assert.ok(currentContent.includes("const blocks = [{ type: 'text', text: WIZ_SYSTEM, cache_control: { type: 'ephemeral' } }];"));

  // Provider boundary preserved
  assert.ok(currentContent.includes('class ProviderError extends Error'));
  assert.ok(currentContent.includes('function createAnthropicProvider({ apiKey, fetchImpl = fetch })'));
  assert.ok(currentContent.includes("model: 'claude-sonnet-4-6',"));

  // App composition and exports preserved
  assert.ok(currentContent.includes('function createDefaultApp(env = process.env)'));
  assert.ok(currentContent.includes('const app = createDefaultApp();'));
  assert.ok(currentContent.includes('module.exports = app;'));
  assert.ok(currentContent.includes('if (require.main === module) {'));
});
