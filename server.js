'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./src/store');
const auth = require('./src/auth');
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
    currentLabel: video.delivered ? 'Delivered' : current ? current.label : 'Not started',
    progress: video.delivered ? 100 : progress,
    steps,
  };
}

function trackerView(project) {
  return {
    code: project.code,
    clientName: project.clientName,
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
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

const server = http.createServer(async (req, res) => {
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
      const project = store.findProjectByCode(trackerMatch[1]);
      if (!project) return sendJson(res, 404, { error: 'No project found for that code.' });
      return sendJson(res, 200, trackerView(project));
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
          return sendJson(res, 200, { project: store.updateProject(m[1], body) });
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
});

server.listen(PORT, () => {
  console.log(`Media Tracker running on http://localhost:${PORT}`);
  console.log(`  Client tracker : http://localhost:${PORT}/`);
  console.log(`  Studio side    : http://localhost:${PORT}/studio`);
});

module.exports = server;
