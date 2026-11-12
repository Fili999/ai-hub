// Security regression for the local web server: authentication of every route, CSRF (Origin / Content-Type /
// Sec-Fetch-Site), DNS rebinding (Host), request limits, path parameters and information exposure.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../ui/server.mjs';
import { cleanupAfter, makeHub, snapshotTree } from './helpers.mjs';

cleanupAfter();

const SERVER_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'server.mjs'), 'utf8');
// /api/health is public on purpose (the launcher polls it) and returns nothing but {ok, name}
const ROUTES = [...SERVER_SRC.matchAll(/^\s*'(GET|POST) (\/api\/[\w/-]+)'/gm)].map((m) => ({ method: m[1], path: m[2] })).filter((r) => r.path !== '/api/health');
const POSTS = ROUTES.filter((r) => r.method === 'POST');
const GETS = ROUTES.filter((r) => r.method === 'GET');

/** Low level request: full control over headers (Host, Origin, ...) and body. */
const raw = (app, { method = 'GET', url = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 'closed', error: e.code, data: '' }));
    if (body !== undefined) req.write(body);
    req.end();
  });
const ok = (app, extra = {}) => ({ 'X-Hub-Token': app.token, Host: `127.0.0.1:${app.port}`, ...extra });
const post = (app, headers = {}) => ({ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json', ...headers });

async function withServer(fn, opts = {}) {
  const root = makeHub();
  const app = await startServer({ root, port: 0, quiet: true, ...opts });
  try {
    await fn(app, root);
  } finally {
    await app.close();
  }
}

test('route inventory is read from the source, so a new route is automatically covered', () => {
  assert.ok(POSTS.length >= 15, `found ${POSTS.length} POST routes`);
  assert.ok(GETS.length >= 10, `found ${GETS.length} GET routes`);
});

test('every API route refuses a request without the session token, and nothing on disk changes', () =>
  withServer(async (app, root) => {
    const before = snapshotTree(root);
    for (const r of ROUTES) {
      const res = await raw(app, { method: r.method, url: r.path, headers: r.method === 'POST' ? post(app, { Host: `127.0.0.1:${app.port}` }) : { Host: `127.0.0.1:${app.port}` }, body: r.method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${r.method} ${r.path} without token`);
      const wrong = await raw(app, { method: r.method, url: r.path, headers: { ...(r.method === 'POST' ? post(app) : {}), Host: `127.0.0.1:${app.port}`, 'X-Hub-Token': 'x'.repeat(app.token.length) }, body: r.method === 'POST' ? '{}' : undefined });
      assert.equal(wrong.status, 401, `${r.method} ${r.path} with a wrong token`);
    }
    assert.deepEqual(snapshotTree(root), before);
  }));

test('every POST route refuses: no Origin, foreign Origin, look-alike Origin, wrong/missing Content-Type (CSRF)', () =>
  withServer(async (app, root) => {
    const before = snapshotTree(root);
    const base = ok(app);
    const cases = [
      [{ 'Content-Type': 'application/json' }, 403, 'no Origin'],
      [{ 'Content-Type': 'application/json', Origin: 'http://evil.example' }, 403, 'foreign Origin'],
      [{ 'Content-Type': 'application/json', Origin: `http://127.0.0.1.evil.example:${app.port}` }, 403, 'look-alike Origin'],
      [{ 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${app.port}.evil.example` }, 403, 'look-alike Origin 2'],
      [{ 'Content-Type': 'application/json', Origin: 'null' }, 403, 'null Origin (sandboxed iframe / file:)'],
      [{ 'Content-Type': 'application/json', Origin: `https://127.0.0.1:${app.port}` }, 403, 'https Origin'],
      [{ Origin: `http://127.0.0.1:${app.port}` }, 415, 'no Content-Type'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'text/plain' }, 415, 'text/plain (simple request)'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, 415, 'form'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'multipart/form-data; boundary=x' }, 415, 'multipart'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/jsonx' }, 415, 'application/jsonx'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json-patch+json' }, 415, 'json-patch'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'text/json' }, 415, 'text/json'],
      [{ Origin: `http://127.0.0.1:${app.port}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, 403, 'Sec-Fetch-Site cross-site'],
    ];
    for (const r of POSTS) {
      for (const [h, status, why] of cases) {
        const res = await raw(app, { method: 'POST', url: r.path, headers: { ...base, ...h }, body: '{}' });
        assert.equal(res.status, status, `${r.path}: ${why}`);
      }
    }
    assert.deepEqual(snapshotTree(root), before);
  }));

test('JSON with charset and same-site fetch metadata are accepted (no false positives)', () =>
  withServer(async (app) => {
    const h = { ...ok(app), ...post(app, { 'Content-Type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin' }) };
    const res = await raw(app, { method: 'POST', url: '/api/link', headers: h, body: JSON.stringify({ agent: 'producer', skill: 'seo-audit' }) });
    assert.equal(res.status, 200, res.data);
    assert.equal((await raw(app, { url: '/api/health', headers: { Host: `localhost:${app.port}` } })).status, 200);
    assert.equal((await raw(app, { url: '/api/health', headers: { Host: `localhost:${app.port}` } })).data.includes(app.token), false, 'the public health route reveals nothing');
    assert.equal((await raw(app, { url: '/api/state', headers: ok(app, { Host: `LOCALHOST:${app.port}`, 'Sec-Fetch-Site': 'same-origin' }) })).status, 200);
  }));

test('cross-site reads: a foreign Origin or Sec-Fetch-Site: cross-site is refused even with a valid token', () =>
  withServer(async (app) => {
    for (const h of [{ Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }]) {
      for (const r of GETS) {
        const res = await raw(app, { url: r.path, headers: ok(app, h) });
        assert.equal(res.status, 403, `${r.path} ${JSON.stringify(h)}`);
      }
    }
  }));

test('DNS rebinding: any Host other than 127.0.0.1:<port> / localhost:<port> gets 421 on pages, reads and writes', () =>
  withServer(async (app, root) => {
    const before = snapshotTree(root);
    const hosts = ['evil.example', `evil.example:${app.port}`, `127.0.0.1.evil.example:${app.port}`, `localhost.evil.example:${app.port}`, `localhost:${app.port + 1}`, '127.0.0.1', '127.0.0.1:80', `[::1]:${app.port}`, `0.0.0.0:${app.port}`, `127.0.0.1:${app.port}@evil.example`, `evil.example#127.0.0.1:${app.port}`];
    for (const host of hosts) {
      const h = { ...post(app), 'X-Hub-Token': app.token, Host: host };
      for (const [method, url] of [['GET', '/'], ['GET', '/api/state'], ['POST', '/api/link'], ['GET', '/js/app.js']]) {
        const res = await raw(app, { method, url, headers: h, body: method === 'POST' ? '{"agent":"producer","skill":"seo-audit"}' : undefined });
        assert.ok([421, 400, 'closed'].includes(res.status), `Host ${JSON.stringify(host)} ${method} ${url} → ${res.status}`);
        assert.ok(!String(res.data).includes(app.token), 'token never served to a foreign Host');
      }
    }
    // HTTP/1.0 without Host header at all
    const noHost = await new Promise((resolve) => {
      const s = net.connect(app.port, '127.0.0.1', () => s.write(`GET / HTTP/1.0\r\n\r\n`));
      let data = '';
      s.on('data', (c) => (data += c));
      s.on('close', () => resolve(data));
      setTimeout(() => s.destroy(), 1500);
    });
    assert.match(noHost, /^HTTP\/1\.\d 421/);
    assert.ok(!noHost.includes(app.token));
    assert.deepEqual(snapshotTree(root), before);
  }));

test('token handling: only /api/events accepts it in the URL; odd tokens give 401, never a crash', () =>
  withServer(async (app) => {
    const base = { Host: `127.0.0.1:${app.port}` };
    for (const r of GETS.filter((g) => g.path !== '/api/events')) {
      assert.equal((await raw(app, { url: `${r.path}?t=${app.token}`, headers: base })).status, 401, `${r.path} must not take the token from the URL`);
    }
    const ev = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: app.port, path: `/api/events?t=${app.token}`, headers: base }, (res) => {
        resolve(res.statusCode);
        res.destroy();
      });
      req.on('error', () => resolve('closed'));
    });
    assert.equal(ev, 200);
    for (const bad of ['é'.repeat(app.token.length), 'é'.repeat(app.token.length / 2), 'ÿ'.repeat(app.token.length), '', ' '.repeat(app.token.length), `${app.token}x`, app.token.slice(1), app.token.toLowerCase() === app.token ? app.token.toUpperCase() : app.token.toLowerCase()]) {
      const res = await raw(app, { url: '/api/state', headers: { ...base, 'X-Hub-Token': Buffer.from(bad, 'latin1').toString('latin1') } });
      assert.equal(res.status, 401, JSON.stringify(bad).slice(0, 30));
      assert.ok(!/Internal server error/i.test(res.data));
    }
    // two token headers: not accepted
    assert.equal((await raw(app, { url: '/api/state', headers: { ...base, 'X-Hub-Token': [app.token, app.token] } })).status, 401);
  }));

test('request limits: oversized, malformed and wrongly shaped bodies', () =>
  withServer(async (app) => {
    const h = ok(app, post(app));
    const big = await raw(app, { method: 'POST', url: '/api/link', headers: h, body: JSON.stringify({ agent: 'x'.repeat(300 * 1024) }) });
    assert.ok(big.status === 413 || big.status === 'closed', `oversized → ${big.status}`);
    for (const body of ['{', '[]', 'null', '"str"', '1', '{"agent": }', '\u0000']) {
      const res = await raw(app, { method: 'POST', url: '/api/link', headers: h, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // field validation: wrong types and over-long strings
    for (const b of [{ agent: 1, skill: 2 }, { agent: ['a'], skill: 'b' }, { agent: 'x'.repeat(500), skill: 'y' }, { agent: '../../etc/passwd', skill: 'y' }, { agent: 'a b', skill: 'y' }]) {
      const res = await raw(app, { method: 'POST', url: '/api/link', headers: h, body: JSON.stringify(b) });
      assert.equal(res.status, 400, JSON.stringify(b).slice(0, 50));
    }
    assert.equal((await raw(app, { url: '/api/state', headers: ok(app) })).status, 200, 'server still healthy');
  }));

test('path parameters: install sources and sub-paths cannot reach local files or inject options', () =>
  withServer(async (app, root) => {
    const before = snapshotTree(root);
    const h = ok(app, post(app));
    const bad = [
      { source: '/etc' }, { source: 'file:///etc' }, { source: '.' }, { source: '..' }, { source: root }, { source: '--upload-pack=touch /tmp/pwn' },
      { source: 'ext::sh -c id' }, { source: 'owner/repo', ref: '--upload-pack=x' }, { source: 'owner/repo', ref: '-x' }, { source: 'owner/repo', path: '../../etc' },
      { source: 'owner/repo', path: 'a/../../b' }, { source: 'owner/repo', path: '-rf' }, { source: 'owner/repo', kind: 'script' },
      { source: 'owner/repo', ref: 'a'.repeat(300) }, { source: ['owner/repo'] }, {},
    ];
    for (const b of bad) {
      for (const url of ['/api/install/preview', '/api/install/scan', '/api/install']) {
        const res = await raw(app, { method: 'POST', url, headers: h, body: JSON.stringify({ ...b, only: ['x'], package: false }) });
        assert.ok([400, 422].includes(res.status), `${url} ${JSON.stringify(b)} → ${res.status} ${res.data.slice(0, 80)}`);
      }
    }
    for (const b of [{ kind: 'skill', name: '../../etc' }, { kind: 'skill', name: 'a/b' }, { kind: 'skill', name: '..' }, { kind: 'dir', name: 'x' }, { kind: 'skill', name: 'x'.repeat(200) }]) {
      for (const url of ['/api/remove', '/api/approve']) {
        const res = await raw(app, { method: 'POST', url, headers: h, body: JSON.stringify(b) });
        assert.equal(res.status, 400, `${url} ${JSON.stringify(b)}`);
      }
    }
    const upd = await raw(app, { method: 'POST', url: '/api/update', headers: h, body: JSON.stringify({ names: ['--force', '../x', 'a b'] }) });
    assert.equal(upd.status, 400);
    assert.deepEqual(snapshotTree(root), before);
  }));

test('static files: traversal, encodings, backslashes and NUL never serve files outside ui/public', () =>
  withServer(async (app) => {
    const paths = ['/../server.mjs', '/..%2fserver.mjs', '/%2e%2e/server.mjs', '/%2e%2e%2f%2e%2e%2fpackage.json', '/js/../../server.mjs', '/js/%2e%2e/%2e%2e/server.mjs', '/js%5c..%5c..%5cserver.mjs', '/%00', '/%00.js', '/js/app.js%00.png', '//etc/passwd', '/%', '/%E0%A4%A', '/js/', '/.%2e/.%2e/package.json', '/%252e%252e/server.mjs'];
    for (const p of paths) {
      const res = await raw(app, { url: p, headers: { Host: `127.0.0.1:${app.port}` } });
      assert.ok([400, 403, 404].includes(res.status), `${p} → ${res.status}`);
      assert.ok(!res.data.includes('startServer') && !res.data.includes('"name": "ai-hub"') && !res.data.includes('root:'), p);
    }
    assert.equal((await raw(app, { method: 'PUT', url: '/index.html', headers: { Host: `127.0.0.1:${app.port}` } })).status, 405);
  }));

test('errors do not expose stack traces, source paths or the token', () =>
  withServer(async (app, root) => {
    const res = await raw(app, { url: '/api/nope', headers: ok(app) });
    assert.equal(res.status, 404);
    const bad = await raw(app, { method: 'POST', url: '/api/teams/save', headers: ok(app, post(app)), body: JSON.stringify({ team: { id: {} } }) });
    for (const r of [res, bad]) {
      assert.ok(!/\bat \w+.*\(.*:\d+:\d+\)/.test(r.data), 'no stack trace');
      assert.ok(!r.data.includes(root) && !r.data.includes(app.token));
    }
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS headers: other origins cannot read responses');
  }));

test('the event stream is capped, so open connections cannot exhaust the process', () =>
  withServer(async (app) => {
    const open = [];
    const statuses = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: app.port, path: `/api/events?t=${app.token}`, headers: { Host: `127.0.0.1:${app.port}` } }, (res) => {
          statuses.push(res.statusCode);
          if (res.statusCode === 200) open.push(res);
          else res.resume();
          resolve();
        });
        req.on('error', resolve);
      });
    }
    open.forEach((r) => r.destroy());
    assert.ok(statuses.includes(429), 'connections beyond the cap are refused');
    assert.ok(statuses.filter((s) => s === 200).length >= 8, 'normal use (a few tabs) still works');
  }));

test('concurrent writes through the API stay consistent (serialized)', () =>
  withServer(async (app, root) => {
    const h = ok(app, post(app));
    const calls = [];
    for (let i = 0; i < 12; i++) {
      calls.push(raw(app, { method: 'POST', url: '/api/link', headers: h, body: JSON.stringify({ agent: 'producer', skill: i % 2 ? 'seo-audit' : 'sottotitoli' }) }));
      calls.push(raw(app, { method: 'POST', url: '/api/settings', headers: h, body: JSON.stringify({ values: { 'memory.mode': i % 2 ? 'off' : 'propose' } }) }));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    for (const f of ['registry.json', 'settings.json']) JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); // never half-written
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), []);
  }));
