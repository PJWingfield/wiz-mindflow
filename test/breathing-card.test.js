'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(startMarker, endMarker) {
  const a = INDEX.indexOf(startMarker);
  assert.ok(a >= 0, `marker not found: ${startMarker}`);
  const b = INDEX.indexOf(endMarker, a);
  assert.ok(b > a, `end marker not found: ${endMarker}`);
  return INDEX.slice(a, b);
}

function makeFakePanel(title, subtitle) {
  const classes = new Set(['audit-panel']);
  const makeEl = (initialText = '', initialDisplay = '') => {
    const attrs = new Map();
    const elClasses = new Set();
    return {
      textContent: initialText,
      innerHTML: initialText,
      disabled: false,
      offsetWidth: 120,
      style: { display: initialDisplay },
      onclick: null,
      classList: {
        add: c => elClasses.add(c),
        remove: c => elClasses.delete(c),
        contains: c => elClasses.has(c)
      },
      getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v))
    };
  };
  const orb = makeEl();
  const label = makeEl('Ready when you are');
  const count = makeEl('&nbsp;');
  const roundEl = makeEl('&nbsp;');
  const go = makeEl('Start', '');
  go.setAttribute('data-b', 'go');
  const stop = makeEl('Stop', 'none');
  stop.setAttribute('data-b', 'stop');
  const panel = {
    title,
    subtitle,
    html: '',
    orb, label, count, roundEl, go, stop,
    classList: {
      add: c => classes.add(c),
      contains: c => classes.has(c)
    },
    insertAdjacentHTML(_pos, html) { panel.html += html; },
    querySelector: sel => {
      if (sel === '.breath-orb') return orb;
      if (sel === '.breath-label') return label;
      if (sel === '.breath-count') return count;
      if (sel === '.breath-round') return roundEl;
      if (sel === '[data-b="go"]') return go;
      if (sel === '[data-b="stop"]') return stop;
      return null;
    }
  };
  return panel;
}

function createBreathingHarness() {
  const panels = [];
  const sentUserMessages = [];
  const addedMessages = [];
  const timers = new Map();
  let nextTimerId = 1;
  const messagesEl = { scrollTop: 0, scrollHeight: 240 };
  const ctx = vm.createContext({
    Date,
    URLSearchParams,
    window: { location: { search: '' } },
    document: { getElementById: id => (id === 'messages' ? messagesEl : null) },
    panelWrapper: (title, subtitle) => { const p = makeFakePanel(title, subtitle); panels.push(p); return p; },
    sendUserMessage: text => sentUserMessages.push(text),
    addMessage: (role, text) => addedMessages.push({ role, text }),
    setInterval: (fn, ms) => { const id = nextTimerId++; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => { timers.delete(id); }
  });
  const code = [
    between('var state = {', 'function startTrack('),
    between('const initialState = {...state};', 'const key = () =>'),
    between('var WIZ_SIGNAL_RE', 'function addMessage(role, text)'),
    between('function showBreathCard()', 'function showConversation()'),
    between('var WIZ_REPORT_REQUEST', 'function downloadTranscript(kind)')
  ].join('\n');
  vm.runInContext(code, ctx);
  const tickSeconds = n => {
    for (let i = 0; i < n; i++) {
      for (const t of [...timers.values()]) t.fn();
    }
  };
  const resetSession = () => {
    vm.runInContext('Object.assign(state, initialState, {messages:[],assessedDomains:[],track:null,lens:null});', ctx);
  };
  return { ctx, panels, sentUserMessages, addedMessages, timers, tickSeconds, resetSession };
}

test('[BREATH_BOX] signal stripping, em-dash tidying and transcript marker', () => {
  const { ctx } = createBreathingHarness();
  assert.equal(ctx.wizClean('Let us try this.\n[BREATH_BOX]\n'), 'Let us try this.');
  assert.equal(ctx.wizDash('steady—and calm -- now'), 'steady – and calm – now');
  ctx.state.messages = [
    { role: 'assistant', content: 'Take a seat.\n[BREATH_BOX]' }
  ];
  const items = ctx.wizTranscriptItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Take a seat.');
  assert.deepEqual(Array.from(items[0].notes), ['A paced box-breathing card was shown here.']);
  const html = ctx.buildTranscriptHTML(false);
  assert.ok(!html.includes('[BREATH_BOX]'));
  assert.ok(html.includes('A paced box-breathing card was shown here.'));
  const handler = between('async function handleWIZResponse(userMsg)', 'async function sendMessage()');
  assert.ok(handler.includes("if (reply.indexOf('[BREATH_BOX]') >= 0)"));
  assert.ok(handler.includes('showBreathCard();'));
  assert.ok(INDEX.includes("['BREATH_BOX',showBreathCard]"));
});

test('paced breathing card: user Start, 3x4x4s rounds, no automatic request, one follow-up on completion', () => {
  const h = createBreathingHarness();
  assert.equal(h.ctx.state.breathShown, false);
  h.ctx.showBreathCard();
  assert.equal(h.panels.length, 1);
  assert.equal(h.ctx.state.breathShown, true);
  // Duplicate call in the same session is ignored
  h.ctx.showBreathCard();
  assert.equal(h.panels.length, 1);

  const card = h.panels[0];
  assert.ok(card.classList.contains('breath-card'));
  assert.ok(card.html.includes('breath-orb'));
  assert.equal(card.label.textContent, 'Ready when you are');
  assert.equal(card.go.textContent, 'Start');
  assert.equal(card.stop.style.display, 'none');
  assert.equal(h.timers.size, 0, 'timer does not start before user clicks Start');
  assert.deepEqual(h.sentUserMessages, []);

  // Click Start
  card.go.onclick();
  assert.equal(h.timers.size, 1);
  assert.equal(card.go.style.display, 'none');
  assert.equal(card.stop.style.display, '');
  assert.equal(card.label.textContent, 'Breathe in');
  assert.equal(card.roundEl.textContent, 'Round 1 of 3');
  assert.equal(card.count.textContent, 1);
  assert.equal(card.orb.classList.contains('big'), true);

  // 3 ticks -> still in phase 0 (sec = 4)
  h.tickSeconds(3);
  assert.equal(card.label.textContent, 'Breathe in');
  assert.equal(card.count.textContent, 4);
  // 4th tick -> Hold (sec = 1)
  h.tickSeconds(1);
  assert.equal(card.label.textContent, 'Hold');
  assert.equal(card.count.textContent, 1);
  // Next 4 ticks -> Breathe out (orb shrinks)
  h.tickSeconds(4);
  assert.equal(card.label.textContent, 'Breathe out');
  assert.equal(card.orb.classList.contains('big'), false);
  // Next 4 ticks -> second Hold
  h.tickSeconds(4);
  assert.equal(card.label.textContent, 'Hold');
  // Complete remaining 36 ticks (48 total across 3 rounds of 16s)
  h.tickSeconds(36);
  assert.equal(h.timers.size, 0, 'interval cleared on completion');
  assert.equal(card.label.textContent, 'Done. Breathe naturally.');
  assert.equal(card.stop.style.display, 'none');
  assert.equal(card.go.style.display, '');
  assert.equal(card.go.textContent, 'Tell WIZ how it felt');
  assert.deepEqual(h.sentUserMessages, [], 'no automatic message sent when rounds finish');

  // User clicks follow-up button once
  card.go.onclick();
  assert.deepEqual(h.sentUserMessages, ["I've finished the three rounds of box breathing."]);
  assert.equal(card.go.disabled, true);
  assert.equal(card.go.classList.contains('chosen'), true);
});

test('paced breathing card: Stop works and per-session reset allows a new session to use the card', () => {
  const h = createBreathingHarness();
  h.ctx.showBreathCard();
  assert.equal(h.panels.length, 1);

  // Per-session reset restores breathShown to false via VM lexical initialState
  h.resetSession();
  assert.equal(h.ctx.state.breathShown, false);
  h.ctx.showBreathCard();
  assert.equal(h.panels.length, 2);

  const card = h.panels[1];
  card.go.onclick();
  h.tickSeconds(5);
  assert.equal(h.timers.size, 1);
  card.stop.onclick();
  assert.equal(h.timers.size, 0, 'Stop clears the running interval');
  assert.equal(card.label.textContent, 'Stopped');
  assert.equal(card.stop.style.display, 'none');
  assert.equal(card.go.style.display, '');
  assert.equal(card.go.textContent, 'Carry on with WIZ');
  assert.deepEqual(h.sentUserMessages, [], 'Stop sends no automatic message');

  card.go.onclick();
  assert.deepEqual(h.sentUserMessages, ['I stopped the breathing exercise early.']);
  assert.equal(card.go.disabled, true);
});
