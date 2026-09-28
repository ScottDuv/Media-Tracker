'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./src/store');
const auth = require('./src/auth');
const asana = require('./src/asana');
const sync = require('./src/sync');
const { PHASES, stepLabel } = require('./src/phases');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

store.load();

// ---- view builders -------------------------------------------------------

/** Derive the client-facing view of a video (step statuses, progress, labels). */
function videoView(video) {
  const currentIdx = video.timeline.findIndex((s) => s.sid === video.currentStepId);
  const steps = video.timeline.map((s, i) => {
    let status;
    if (video.delivered) status = 'complete';
    else if (i < currentIdx) status = 'complete';
    else if (i === currentIdx) status = 'current';
    else status = 'upcoming';
    return { sid: s.sid, key: s.key, label: stepLabel(s), status };
  });
  const total = steps.length;
  const completed = steps.filter((s) => s.status === 'complete').length;
  const progress = total ? Math.round(((completed + (video.delivered ? 0 : 0.5)) / total) * 100) : 0;
  const current = steps.find((s) => s.status === 'current');
  return {
    id: video.id,
    title: video.title,
    updatedAt: video.updatedAt,
    delivered: video.delivered,
    asanaLinked: !!video.asanaTaskId,
    currentLabel: video.delivered ? 'Delivered' : current ? current.label : 'Not started',
    progress: video.delivered ? 100 : progress,
    steps,
  };
}

function trackerView(project) {
  return {
    code: project.code,
    clientName: project.displayName || project.clientName,
    videos: store.listVideos(project.id).map(videoView),
  };
}

// ---- http helpers --------------------------------------------------------

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('Invalid JSON body');
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, relPath) {
  // Resolve safely inside PUBLIC_DIR (prevent path traversal).
  const full = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!full.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(full, (err, buf) => {
    if (err) return sendText(res, 404, 'Not found');
    const type = CONTENT_TYPES[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function requireStudio(req, res) {
  if (auth.isAuthed(req)) return true;
  sendJson(res, 401, { error: 'Not authenticated.' });
  return false;
}

// ---- request handling ----------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  try {
    // --- static pages ---
    if (method === 'GET' && (pathname === '/' || pathname === '/embed')) {
      return serveStatic(res, 'index.html');
    }
    if (method === 'GET' && pathname === '/studio') {
      return serveStatic(res, 'studio.html');
    }
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && pathname.startsWith('/assets/')) {
      return serveStatic(res, pathname);
    }

    // --- public API ---
    if (method === 'GET' && pathname === '/api/phases') {
      const out = {};
      for (const [k, v] of Object.entries(PHASES)) {
        out[k] = { label: v.label, blurb: v.blurb, repeatable: v.repeatable };
      }
      return sendJson(res, 200, { phases: out });
    }

    const trackerMatch = pathname.match(/^\/api\/tracker\/(.+)$/);
    if (method === 'GET' && trackerMatch) {
      const project = store.findProjectByCodeOrGid(trackerMatch[1]);
      if (!project) return sendJson(res, 404, { error: 'No project found for that code.' });
      return sendJson(res, 200, trackerView(project));
    }

    // --- Asana webhook (public; authenticated by handshake + HMAC signature) ---
    if (method === 'POST' && pathname === '/api/hooks/asana') {
      const raw = await readRaw(req);
      // 1) Handshake: Asana sends X-Hook-Secret once, which we echo back. The
      //    nonce in the query correlates the secret to the connect that started it.
      const secretHeader = req.headers['x-hook-secret'];
      if (secretHeader) {
        sync.captureHandshake(url.searchParams.get('c'), secretHeader);
        res.writeHead(200, { 'X-Hook-Secret': secretHeader });
        return res.end();
      }
      // 2) Event delivery: verify signature, then reconcile in the background.
      const signature = req.headers['x-hook-signature'];
      const projectGid = sync.findProjectBySignature(raw, signature);
      if (!projectGid) return sendJson(res, 401, { error: 'Invalid signature.' });
      let events = [];
      try {
        events = (JSON.parse(raw || '{}').events) || [];
      } catch (_) {
        /* ignore malformed body */
      }
      // Acknowledge immediately (Asana expects a fast 200); process after.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      sync.handleEvents(projectGid, events).catch((err) =>
        console.error('[asana] handleEvents error:', err.message)
      );
      return;
    }

    // --- studio auth ---
    if (method === 'POST' && pathname === '/api/studio/login') {
      const body = await readBody(req);
      if (!auth.checkPassword(body.password)) {
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(auth.mintToken()) });
    }
    if (method === 'POST' && pathname === '/api/studio/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
    }
    if (method === 'GET' && pathname === '/api/studio/session') {
      return sendJson(res, 200, { authed: auth.isAuthed(req) });
    }

    // --- studio admin (protected) ---
    if (pathname.startsWith('/api/admin/')) {
      if (!requireStudio(req, res)) return;

      // Asana integration
      if (method === 'GET' && pathname === '/api/admin/asana/status') {
        return sendJson(res, 200, {
          configured: asana.isConfigured(),
          publicBaseUrl: asana.publicBaseUrl(),
          fieldName: asana.FIELD_NAME,
          connected: sync.listConnected(),
        });
      }
      if (method === 'POST' && pathname === '/api/admin/asana/connect') {
        if (!asana.isConfigured()) {
          return sendJson(res, 400, { error: 'Set ASANA_TOKEN on the server first.' });
        }
        const body = await readBody(req);
        const result = await sync.connectProject(body.project);
        return sendJson(res, 200, {
          asanaProjectGid: result.project.asanaProjectGid,
          code: result.project.code,
          displayName: result.project.displayName || result.project.clientName,
          imported: result.imported,
        });
      }
      if (method === 'POST' && pathname === '/api/admin/asana/disconnect') {
        const body = await readBody(req);
        const gid = asana.parseProjectGid(body.asanaProjectGid || body.project);
        await sync.disconnectProject(gid);
        return sendJson(res, 200, { ok: true });
      }

      // Projects
      if (method === 'GET' && pathname === '/api/admin/projects') {
        const projects = store.listProjects().map((p) => ({
          ...p,
          videos: store.listVideos(p.id).map(videoView),
        }));
        return sendJson(res, 200, { projects });
      }
      if (method === 'POST' && pathname === '/api/admin/projects') {
        const body = await readBody(req);
        const project = store.createProject(body);
        return sendJson(res, 201, { project });
      }
      let m = pathname.match(/^\/api\/admin\/projects\/([^/]+)$/);
      if (m) {
        if (method === 'PATCH') {
          const body = await readBody(req);
          return sendJson(res, 200, { project: store.updateProjectFields(m[1], body) });
        }
        if (method === 'DELETE') {
          store.deleteProject(m[1]);
          return sendJson(res, 200, { ok: true });
        }
      }
      m = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/videos$/);
      if (m && method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 201, { video: videoView(store.createVideo(m[1], body.title)) });
      }

      // Videos
      m = pathname.match(/^\/api\/admin\/videos\/([^/]+)$/);
      if (m) {
        if (method === 'PATCH') {
          const body = await readBody(req);
          return sendJson(res, 200, { video: videoView(store.updateVideo(m[1], body)) });
        }
        if (method === 'DELETE') {
          store.deleteVideo(m[1]);
          return sendJson(res, 200, { ok: true });
        }
      }
      m = pathname.match(/^\/api\/admin\/videos\/([^/]+)\/steps$/);
      if (m && method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { video: videoView(store.addStep(m[1], body.key)) });
      }
      m = pathname.match(/^\/api\/admin\/videos\/([^/]+)\/steps\/([^/]+)$/);
      if (m && method === 'DELETE') {
        return sendJson(res, 200, { video: videoView(store.removeStep(m[1], m[2])) });
      }

      return sendJson(res, 404, { error: 'Unknown admin endpoint.' });
    }

    return sendText(res, 404, 'Not found');
  } catch (err) {
    // Store validation errors are user-facing; treat as 400.
    return sendJson(res, 400, { error: err.message || 'Request failed.' });
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Media Tracker running on http://localhost:${PORT}`);
    console.log(`  Client tracker : http://localhost:${PORT}/`);
    console.log(`  Studio side    : http://localhost:${PORT}/studio`);
  });
}

module.exports = { server, handleRequest };
