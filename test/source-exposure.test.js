'use strict';
// Source-exposure containment tests. Local HTTP only: no live model, DB or provider
// calls, and no secrets are read. /api/chat is never exercised with a valid request.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = require('../server.js');

let server;
let port;

test.before(async () => {
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => new Promise(r => server.close(r)));

// Raw request so the path reaches the server exactly as written (no client-side normalisation).
function raw(method, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SOURCE_MARKERS = ['WIZ_SYSTEM', 'require(', 'express', 'claude-sonnet'];
function assertNoLeak(res, label) {
  // Express echoes the requested path in its default 404 page ("Cannot GET /x"); ignore that echo.
  const body = res.body.replace(/Cannot [A-Z]+ [^<]*/g, '');
  for (const m of SOURCE_MARKERS) assert.ok(!body.includes(m), `${label}: body leaked "${m}"`);
  assert.notEqual(res.body, serverSrc);
}

test('homepage served with no-cache and real index.html content', async () => {
  const res = await raw('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-cache, must-revalidate');
  assert.equal(res.body, fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
});

test('/index.html still served with no-cache', async () => {
  const res = await raw('GET', '/index.html');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache, must-revalidate');
  assert.match(res.body, /<html/i);
});

test('health endpoint', async () => {
  const res = await raw('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});

test('index references no local static assets beyond the app routes', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const local = [...html.matchAll(/\b(?:src|href)="(?!https?:|data:|tel:|mailto:|#|'\s*\+)([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(local, [], 'index.html now references local assets; extend the public allowlist');
  assert.ok(html.includes('fetch(path'));
});

const DENIED = [
  // server source
  '/server.js', '/server%2ejs', '/server%2Ejs', '/server%252ejs', '/server%252Ejs',
  '/SERVER.JS', '/Server.Js', '/%73erver.js', '/%2573erver.js', '/server.js/', '/server.js?x=1',
  '/server.js%00', '/server.js%20', '/server.js.', '/./server.js', '//server.js',
  '/foo/../server.js', '/foo/%2e%2e/server.js', '/%2e%2e/server.js', '/..%2fserver.js',
  '/%2e/server.js', '/server%2ejs/', '/server.js;.html', '/server.js/index.html',
  // config / metadata
  '/package.json', '/package%2ejson', '/package%252ejson', '/PACKAGE.JSON', '/package-lock.json',
  '/nixpacks.toml', '/NIXPACKS.TOML', '/nixpacks%2etoml', '/.env', '/%2eenv', '/%252eenv', '/.ENV',
  '/.env.local', '/.git', '/.git/config', '/%2egit/config', '/.gitignore', '/README.md', '/readme.md',
  '/docs/P0-VERIFICATION.md', '/test/source-exposure.test.js', '/test/', '/docs/', '/node_modules/express/package.json',
];

for (const p of DENIED) {
  test(`denied GET ${p}`, async () => {
    const res = await raw('GET', p);
    assert.ok(res.status === 404 || res.status === 400, `expected 404/400, got ${res.status}`);
    assertNoLeak(res, p);
  });
}

test('denied HEAD for server source', async () => {
  for (const p of ['/server.js', '/server%2ejs', '/SERVER.JS']) {
    const res = await raw('HEAD', p);
    assert.equal(res.status, 404, p);
    assert.equal(res.body, '');
  }
});

test('malformed paths are handled safely (no crash, no leak, 4xx only)', async () => {
  const paths = ['/%', '/%zz', '/%E0%A4%A', '/%c0%ae%c0%ae/server.js', '/server%', '/server.js%',
    '/%00', '/\server.js', '/..\server.js', '/' + 'a'.repeat(5000), '/%2e%2e%2f%2e%2e%2fserver.js'];
  for (const p of paths) {
    const res = await raw('GET', p);
    assert.ok(res.status >= 400 && res.status < 500, `${p}: got ${res.status}`);
    assertNoLeak(res, p);
  }
  // server still healthy afterwards
  assert.equal((await raw('GET', '/health')).status, 200);
});

test('HEAD works on public routes with no body', async () => {
  for (const p of ['/', '/index.html', '/health']) {
    const res = await raw('HEAD', p);
    assert.equal(res.status, 200, p);
    assert.equal(res.body, '');
  }
  assert.equal((await raw('HEAD', '/')).headers['cache-control'], 'no-cache, must-revalidate');
});

test('unsupported methods do not serve content', async () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const p of ['/', '/index.html', '/health', '/server.js']) {
      const res = await raw(m, p);
      assert.equal(res.status, 404, `${m} ${p}`);
      assertNoLeak(res, `${m} ${p}`);
    }
  }
});

test('OPTIONS preflight returns 204 (existing CORS behaviour preserved)', async () => {
  const res = await raw('OPTIONS', '/server.js');
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
});

test('GET /api/chat is not a readable route', async () => {
  const res = await raw('GET', '/api/chat');
  assert.equal(res.status, 404);
});

test('server.js keeps required invariants and no static root serving', () => {
  assert.ok(!/express\.static\s*\(/.test(serverSrc), 'express.static must not be used on the app root');
  assert.ok(serverSrc.includes("model: 'claude-sonnet-4-6'"));
  assert.equal((serverSrc.match(/var WIZ_SYSTEM = /g) || []).length, 1);
});

test('requiring server.js does not start a listener', () => {
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
});
