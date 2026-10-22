'use strict';

// Static + sandboxed checks for the conversation copy (Word/PDF), the report escaping and the Direction Audit offer.
// The page functions are cut out of index.html and run in a vm sandbox with no DOM, so no browser is needed.

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

function sandbox(state) {
  const code = [
    between('var WIZ_SIGNAL_RE', 'function addMessage(role, text)'),
    between('var WIZ_AUDIT_LABELS', 'function showDirectionAudit()'),
    between('var WIZ_REPORT_REQUEST', 'function downloadTranscript(kind)'),
    between('function wizAsksTranscript(lower)', 'function offerTranscript()')
  ].join('\n');
  const ctx = vm.createContext({ state, Date });
  vm.runInContext(code, ctx);
  return ctx;
}

function reportSandbox(state, callReport, addMessage, buildReport) {
  const ctx = vm.createContext({
    state, callReport, addMessage, buildReport, console,
    setLoading() {}
  });
  vm.runInContext(between('async function generateReport()', 'async function handleWIZResponse('), ctx);
  return ctx;
}

const msg = (role, content) => ({ role, content });

test('Jon name extraction accepts introductions and skips greetings or longer messages', () => {
  const ctx = sandbox({ clientName: '', messages: [] });
  assert.equal(ctx.wizExtractName('My name is Alex.'), 'Alex');
  assert.equal(ctx.wizExtractName("I'm Sam"), 'Sam');
  assert.equal(ctx.wizExtractName('Hello'), '');
  assert.equal(ctx.wizExtractName('I had a difficult morning today'), '');
  const send = between('async function sendMessage()', 'document.getElementById("userInput").addEventListener("keydown"');
  assert.ok(send.includes('if (state.turnCount <= 3 && !state.clientName'));
  assert.ok(send.includes('var name = wizExtractName(text);'));
});

test('Jon initials and guide titles retain safe rendering', () => {
  const ctx = sandbox({ clientName: 'maria', messages: [] });
  assert.equal(ctx.wizInitial(), 'M');
  assert.equal(sandbox({ clientName: '', messages: [] }).wizInitial(), 'U');
  assert.equal(ctx.wizTitle('THE ART OF FOCUS'), 'THE ART of FOCUS');
  assert.equal(ctx.wizHtml(ctx.wizTitle('<img src=x onerror=alert(1)>')), '&lt;img src=x onerror=alert(1)&gt;');
  const add = between('function addMessage(role, text)', 'function showSkillsQuiz()');
  assert.ok(add.includes('role === "wiz" ? "W" : wizInitial()'));
  const report = between('function buildReport(r)', 'async function generateReport()');
  assert.ok(report.includes('escR(wizTitle(g))'));
});

test('conversation copy escapes user and model text and never emits live markup', () => {
  const ctx = sandbox({ clientName: '<b>Sam</b>', messages: [
    msg('assistant', 'Welcome. [PANEL_1_1]\nShall we? <script>alert(1)</script>'),
    msg('user', '<img src=x onerror=alert(1)> & "quotes" [link](https://example.com/"onmouseover=alert(1)) [x](javascript:alert(1))'),
    msg('assistant', 'Options [CHOICES: Choose]\n- One -- first\n- Two -- second\n[/CHOICES]')
  ] });
  for (const forWindow of [true, false]) {
    const html = ctx.buildTranscriptHTML(forWindow);
    assert.ok(!/<script/i.test(html), 'no script element');
    assert.ok(!/<img/i.test(html), 'no img element');
    assert.ok(!/<[^>]*\son(error|mouseover)=/i.test(html), 'no event-handler attribute inside a tag');
    assert.ok(!/href="javascript:/i.test(html), 'no javascript: links');
    assert.ok(html.includes('&lt;img src=x'), 'user markup shown as text');
    assert.ok(html.includes('&lt;b&gt;Sam&lt;/b&gt;'), 'client name escaped');
    assert.ok(!html.includes('[PANEL_1_1]'), 'signals are not copied');
    assert.ok(html.includes('The Direction Audit was offered here.'));
    assert.ok(html.includes('Options: One') && html.includes('Two'), 'choice tables become plain text');
  }
  assert.ok(ctx.buildTranscriptHTML(true).includes('Content-Security-Policy'), 'print window carries a CSP');
  assert.ok(!ctx.buildTranscriptHTML(false).includes('Content-Security-Policy'));
});

test('conversation copy leaves out the report request and raw report data, and says what it is', () => {
  const ctx = sandbox({ clientName: '', messages: [
    msg('user', 'Hello'),
    msg('user', 'The coaching session is now complete. Generate the Personal Awareness Report now. Output [REPORT_READY]'),
    msg('assistant', '[REPORT_READY]\n{"reportReady":true,"summary":"private json"}')
  ] });
  const html = ctx.buildTranscriptHTML(false);
  assert.ok(!html.includes('private json') && !html.includes('reportReady'));
  assert.ok(!html.includes('Generate the Personal Awareness Report'));
  assert.ok(html.includes('Your session report was created here.'));
  // export-only footer: adult-only and professional-advice wording, not a privacy or account-export statement
  assert.ok(html.includes('For adults aged 18 and over only.'));
  assert.ok(html.includes('not medical, psychological, legal or financial advice'));
  assert.ok(html.includes('Samaritans: 116 123 (free, 24/7)'));
  assert.ok(!/privacy|your data|account data|full export/i.test(html));
});

test('transcript download is never described as an account or privacy export', () => {
  const copy = between('function offerTranscript()', 'function startWithKey()');
  assert.ok(copy.includes('It is not an export of your account data.'));
  assert.ok(INDEX.includes('It is not an export of your account data.'));
  assert.ok(!/sent nowhere/i.test(INDEX), 'no unapproved privacy assurance');
  assert.ok(!/download (all )?my data|full (account )?export|privacy export/i.test(between('function wizTranscriptItems()', 'function startWithKey()')));
});

test('transcript request is answered by the page and is not sent to the model', () => {
  const ctx = sandbox({ messages: [] });
  assert.equal(ctx.wizAsksTranscript('can i have a transcript please'), true);
  assert.equal(ctx.wizAsksTranscript('download the whole conversation'), true);
  assert.equal(ctx.wizAsksTranscript('i want to talk about my job'), false);
  const send = between('async function sendMessage()', 'document.getElementById("userInput").addEventListener("keydown"');
  const transcriptIntercept = send.indexOf('if (wizAsksTranscript(text.toLowerCase())');
  const regularTextResponse = send.indexOf('await handleWIZResponse(text)');
  assert.ok(transcriptIntercept > send.indexOf('addMessage("user", text)'));
  assert.ok(regularTextResponse > transcriptIntercept, 'transcript intercept returns before the normal text response is awaited');
});

test('report text from the model is escaped before it reaches innerHTML', () => {
  const build = between('function buildReport(r)', 'async function generateReport()');
  for (const raw of ['+ r.name +', '+ r.summary +', '+ s +', '+ p +', '+ r.technique1.name +', '+ r.technique2.reason +', '+ a +', '+ r.closing +', '+ r.nextStep +', '+ ar.name +', '+ ar.topFocus +']) {
    assert.ok(!build.includes(raw), `unescaped ${raw}`);
  }
  assert.ok(build.includes('wizHtml(r.summary)') && build.includes('wizHtml(r.nextStep)'));
  assert.ok(build.includes("' + wizHtml(pwName) + '</h3>"), 'pathway heading escapes model supplied text');
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  assert.equal(sandbox({}).wizHtml(payload), '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
  assert.ok(build.includes('var escC = wizHtml;') && build.includes('var escW = wizHtml;') && build.includes('var esc = wizHtml;') && build.includes('var escR = wizHtml;'));
  assert.ok(build.includes('finishDomains();'));
});

test('report provider failure shows the retry message without a missing-session ReferenceError', async () => {
  const messages = [];
  const ctx = reportSandbox({ sessionId: 'session-a' }, async () => { throw new Error('provider unavailable'); },
    (_role, text) => messages.push(text), () => assert.fail('failed report must not render'));
  await ctx.generateReport();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /difficulty generating the full report/i);
});

test('report response from a switched session is discarded before rendering', async () => {
  let resolveReport;
  let builds = 0;
  const messages = [];
  const state = { sessionId: 'session-a' };
  const ctx = reportSandbox(state, () => new Promise(resolve => { resolveReport = resolve; }),
    (_role, text) => messages.push(text), () => { builds++; });
  const pending = ctx.generateReport();
  state.sessionId = 'session-b';
  resolveReport('{"summary":"old session report"}');
  await pending;
  assert.equal(builds, 0);
  assert.equal(state.reportData, undefined);
  assert.deepEqual(messages, []);
});

test('report score chart uses only the audit scores the person gave', () => {
  const build = between('function buildReport(r)', 'async function generateReport()');
  assert.ok(build.includes('wizAuditScores()') && !/(^|[^a-z])r\.scores/.test(build), 'model-estimated r.scores is not rendered');
  const labels = ['Physical','Mental','Financial','Social','Occupational','Family','Close Relationships','Personal Dev','Fun & Recreation','Spirituality'];
  const text = 'Here are my Direction Audit scores -- ' + labels.map((l, i) => `${l}: ${i + 1}/10`).join(', ') + '.';
  const ctx = sandbox({ auditScores: null, messages: [msg('user', 'hi'), msg('user', text)] });
  const got = ctx.wizAuditScores();
  assert.equal(got.length, 10);
  assert.equal(got[0].label, 'Physical');
  assert.equal(got[0].score, 1);
  assert.equal(got[9].score, 10);
  assert.equal(sandbox({ auditScores: null, messages: [msg('user', 'Here are my Direction Audit scores -- Physical: 5/10')] }).wizAuditScores().length, 0, 'partial or edited text gives no chart');
  assert.equal(sandbox({ auditScores: null, messages: [] }).wizAuditScores().length, 0);
});

test('Direction Audit offer: Start / Not now, only opens on Start, decline is remembered and sent as a turn', () => {
  const offer = between('function openAuditOrOffer(offerText)', 'var WIZ_AUDIT_LABELS');
  assert.ok(offer.includes("indexOf('?') >= 0"), 'offer shown only when WIZ asked a question');
  assert.ok(offer.includes("'Start the audit'") && offer.includes("'Not now'"));
  assert.ok(/go\.onclick[^]*showDirectionAudit\(\)/.test(offer));
  assert.ok(/skip\.onclick[^]*state\.auditDeclined = true;[^]*sendUserMessage\(/.test(offer));
  const handler = between('async function handleWIZResponse(userMsg)', 'async function sendMessage()');
  assert.ok(handler.includes("if (panelId === '1.1') { openAuditOrOffer(textBefore2); }"));
  assert.ok(handler.includes('openAuditOrOffer(textBefore);'));
  // saved chats: an earlier offer is not re-offered on reload; only an unanswered final one is
  assert.ok(INDEX.includes("if (panel[1] === '1_1') { if (isLast) openAuditOrOffer(before); }"));
});

test('sidebar progress marks earlier steps done and finishes at the report', () => {
  const dots = {};
  const ctx = vm.createContext({
    state: { assessedDomains: [] },
    document: { getElementById: id => (dots[id] = dots[id] || { className: '' }) }
  });
  vm.runInContext(between('var DOMAIN_ORDER', 'function makeContBtn('), ctx);
  ctx.activateDomain('C');
  assert.equal(dots['dot-A'].className, 'domain-dot done');
  assert.equal(dots['dot-B'].className, 'domain-dot done');
  assert.equal(dots['dot-C'].className, 'domain-dot active');
  assert.equal(dots['dot-D'].className, '', 'later steps are left alone');
  ctx.finishDomains();
  for (const k of 'ABCDEFG') assert.equal(dots['dot-' + k].className, 'domain-dot done');
});
