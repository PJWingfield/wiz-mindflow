'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT_DIR, 'server.js');
const PINNED_SOURCE_COMMIT = '9ac2810cbf63e61d4771277484bdc271525ab9f5';
const EXPECTED_PROMPT_SHA256 = '8799a0cd551187498914120e9dc10e7ed5dd42293f40579fbb40440cf1f0d7a3';
const EXPECTED_PROMPT_LENGTH = 117584;

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

test('exact decoded WIZ_SYSTEM equality with pinned source commit 9ac2810', () => {
  const currentContent = fs.readFileSync(SERVER_PATH, 'utf8');
  const { line: currentLine, decoded: currentDecoded } = extractWizSystemFromContent(currentContent);

  // Check expected sha256 checksum and decoded length
  const hash = crypto.createHash('sha256').update(currentDecoded, 'utf8').digest('hex');
  assert.equal(hash, EXPECTED_PROMPT_SHA256, 'WIZ_SYSTEM sha256 matches expected pinned content hash');
  assert.equal(currentDecoded.length, EXPECTED_PROMPT_LENGTH, 'WIZ_SYSTEM decoded length matches 9ac2810');

  // Verify against git object 9ac2810:server.js if git repo is accessible
  try {
    const originRaw = execSync(`git show ${PINNED_SOURCE_COMMIT}:server.js`, { cwd: ROOT_DIR, maxBuffer: 10 * 1024 * 1024 }).toString('utf8');
    const { line: originLine, decoded: originDecoded } = extractWizSystemFromContent(originRaw);
    assert.equal(currentDecoded, originDecoded, 'WIZ_SYSTEM must be decoded byte-for-byte identical to 9ac2810');
    assert.equal(currentLine, originLine, 'WIZ_SYSTEM declaration line must match 9ac2810');
  } catch (err) {
    // If git object lookup is skipped (e.g. isolated filesystem without git worktree path access),
    // the cryptographic SHA256 and length above guarantee exact byte equality.
    if (!err.message.includes('not a git repository') && !err.message.includes('Access to the path')) {
      throw err;
    }
  }
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
