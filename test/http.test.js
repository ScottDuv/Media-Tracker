'use strict';

/**
 * In-process HTTP routing tests. Drives the exported request handler with mock
 * req/res objects, so no TCP port is bound. Covers studio auth gating, the
 * Asana webhook handshake + signature verification, and the tracker route.
 * Run with: node test/http.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

process.env.MT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-http-'));
process.env.STUDIO_PASSWORD = 'test123';
process.env.MT_SECRET = 'devsecret';

const { handleRequest } = require('../server');
const store = require('../src/store');

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

function mockReq({ method, path: p, headers = {}, body }) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = p;
  req.headers = Object.assign({ host: 'localhost' }, headers);
  if (body !== undefined) req.push(body);
  req.push(null);
  return req;
}

function call(opts) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      _done: false,
      writeHead(status, headers) {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
        return this;
      },
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(chunk) {
        if (chunk) this.body += chunk;
        if (!this._done) {
          this._done = true;
          resolve({ status: this.statusCode, headers: this.headers, body: this.body });
        }
      },
    };
    handleRequest(mockReq(opts), res);
  });
}

(async function run() {
  // Login
  const login = await call({
    method: 'POST',
    path: '/api/studio/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test123' }),
  });
  assert(login.status === 200, 'login with correct password → 200');
  const setCookie = login.headers['Set-Cookie'] || '';
  const cookie = setCookie.split(';')[0];
  assert(/^mt_studio=/.test(cookie), 'login sets mt_studio cookie');

  // Admin gating
  const noAuth = await call({ method: 'GET', path: '/api/admin/asana/status' });
  assert(noAuth.status === 401, 'admin status without cookie → 401');

  const status = await call({
    method: 'GET',
    path: '/api/admin/asana/status',
    headers: { cookie },
  });
  const statusJson = JSON.parse(status.body);
  assert(status.status === 200, 'admin status with cookie → 200');
  assert(statusJson.configured === false, 'asana reports not configured (no ASANA_TOKEN)');
  assert(statusJson.fieldName === 'Tracker Phase', 'asana field name is "Tracker Phase"');

  // Connect without token → 400
  const connect = await call({
    method: 'POST',
    path: '/api/admin/asana/connect',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ project: '123' }),
  });
  assert(connect.status === 400, 'connect without ASANA_TOKEN → 400');

  // Webhook handshake echoes the secret
  const handshake = await call({
    method: 'POST',
    path: '/api/hooks/asana',
    headers: { 'x-hook-secret': 'abc123secret' },
  });
  assert(handshake.status === 200, 'webhook handshake → 200');
  assert(handshake.headers['X-Hook-Secret'] === 'abc123secret', 'handshake echoes X-Hook-Secret');

  // Event with a bad signature → 401
  const badSig = await call({
    method: 'POST',
    path: '/api/hooks/asana',
    headers: { 'x-hook-signature': 'deadbeef', 'content-type': 'application/json' },
    body: JSON.stringify({ events: [] }),
  });
  assert(badSig.status === 401, 'event with bad signature → 401');

  // Event with a valid signature → 200 (reconcile runs in background, tolerates no token)
  store.saveWebhook('555000', { gid: 'wh_1', secret: 's3cr3t', mtProjectId: 'x' });
  const evBody = JSON.stringify({ events: [{ resource: { gid: 't1', resource_type: 'task' } }] });
  const goodSig = crypto.createHmac('sha256', 's3cr3t').update(evBody).digest('hex');
  const okSig = await call({
    method: 'POST',
    path: '/api/hooks/asana',
    headers: { 'x-hook-signature': goodSig, 'content-type': 'application/json' },
    body: evBody,
  });
  assert(okSig.status === 200, 'event with valid signature → 200');

  // Demo tracker route
  const demo = await call({ method: 'GET', path: '/api/tracker/2026728' });
  assert(demo.status === 200, 'demo tracker code 2026728 → 200');
  const unknown = await call({ method: 'GET', path: '/api/tracker/nope' });
  assert(unknown.status === 404, 'unknown code → 404');

  try {
    fs.rmSync(process.env.MT_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
