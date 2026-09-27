'use strict';

const https = require('https');
const crypto = require('crypto');

const { ASANA_PHASE_OPTIONS } = require('./phases');

/**
 * Thin Asana REST client (https built-in, no SDK). Talks to the Asana API on
 * behalf of the studio using a Personal Access Token.
 *
 * Configure via env:
 *   ASANA_TOKEN       a Personal Access Token (Asana → Settings → Apps →
 *                     Personal access tokens). Required for any Asana feature.
 *   PUBLIC_BASE_URL   this app's public https origin, e.g.
 *                     https://tracker.valleystrategy.co (used as the webhook
 *                     target). Required to register webhooks.
 */

const API_HOST = 'app.asana.com';
const API_BASE = '/api/1.0';
const TOKEN = process.env.ASANA_TOKEN || '';
const FIELD_NAME = 'Tracker Phase';

function isConfigured() {
  return !!TOKEN;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

/** Low-level JSON request to the Asana API. Resolves the parsed `data`. */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new Error('ASANA_TOKEN is not set on the server.'));
    const payload = body ? JSON.stringify({ data: body }) : null;
    const req = https.request(
      {
        host: API_HOST,
        path: `${API_BASE}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (_) {
            return reject(new Error(`Asana returned invalid JSON (HTTP ${res.statusCode}).`));
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed.data);
          const msg =
            (parsed.errors && parsed.errors[0] && parsed.errors[0].message) ||
            `Asana API error (HTTP ${res.statusCode}).`;
          reject(new Error(msg));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Accept an Asana project URL or a bare GID and return the numeric GID. */
function parseProjectGid(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  // Match the project id in URLs like app.asana.com/0/<gid>/... or /1/<ws>/project/<gid>
  const m = s.match(/project\/(\d+)/) || s.match(/\/0\/(\d+)/) || s.match(/(\d{8,})/);
  if (m) return m[1];
  throw new Error('Could not read an Asana project ID from that input.');
}

// ---- reads ----

function getProject(gid) {
  return request('GET', `/projects/${gid}?opt_fields=name,workspace.name`);
}

const TASK_FIELDS =
  'opt_fields=name,completed,resource_subtype,projects.gid,' +
  'custom_fields.name,custom_fields.enum_value.name,custom_fields.type';

function getTask(gid) {
  return request('GET', `/tasks/${gid}?${TASK_FIELDS}`);
}

function listProjectTasks(projectGid) {
  return request('GET', `/projects/${projectGid}/tasks?${TASK_FIELDS}&limit=100`);
}

/** Read the "Tracker Phase" option label off a task object, or null. */
function trackerPhaseLabel(task) {
  const fields = (task && task.custom_fields) || [];
  const field = fields.find((f) => (f.name || '').trim().toLowerCase() === FIELD_NAME.toLowerCase());
  if (!field || field.type !== 'enum') return null;
  return field.enum_value ? field.enum_value.name : null;
}

// ---- custom field provisioning ----

/**
 * Find the workspace's "Tracker Phase" enum field, creating it if missing.
 * Returns the field GID.
 */
async function ensureTrackerPhaseField(workspaceGid) {
  const existing = await request(
    'GET',
    `/workspaces/${workspaceGid}/custom_fields?opt_fields=name,resource_type&limit=100`
  );
  const found = (existing || []).find(
    (f) => (f.name || '').trim().toLowerCase() === FIELD_NAME.toLowerCase()
  );
  if (found) return found.gid;
  const created = await request('POST', '/custom_fields', {
    workspace: workspaceGid,
    name: FIELD_NAME,
    resource_subtype: 'enum',
    type: 'enum',
    enum_options: ASANA_PHASE_OPTIONS.map((name) => ({ name })),
  });
  return created.gid;
}

/** Attach the field to a project (idempotent — Asana no-ops if already set). */
async function addFieldToProject(projectGid, fieldGid) {
  try {
    await request('POST', `/projects/${projectGid}/addCustomFieldSetting`, {
      custom_field: fieldGid,
      is_important: true,
    });
  } catch (err) {
    // Already-added yields a harmless error; only rethrow unexpected ones.
    if (!/already/i.test(err.message)) throw err;
  }
}

// ---- webhooks ----

/**
 * Create a webhook on a project targeting this app. Asana performs a handshake
 * POST to `target` synchronously; the caller's server must echo the
 * X-Hook-Secret header on that request (see server.js). Returns the webhook
 * record (includes gid).
 */
function createWebhook(projectGid) {
  const target = `${publicBaseUrl()}/api/hooks/asana`;
  if (!publicBaseUrl()) throw new Error('PUBLIC_BASE_URL is not set on the server.');
  return request('POST', '/webhooks', {
    resource: projectGid,
    target,
    filters: [
      { resource_type: 'task', action: 'changed' },
      { resource_type: 'task', action: 'added' },
      { resource_type: 'task', action: 'removed' },
      { resource_type: 'task', action: 'deleted' },
    ],
  });
}

function deleteWebhook(webhookGid) {
  return request('DELETE', `/webhooks/${webhookGid}`);
}

/** Verify an event request's X-Hook-Signature against a webhook secret. */
function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  FIELD_NAME,
  isConfigured,
  publicBaseUrl,
  parseProjectGid,
  getProject,
  getTask,
  listProjectTasks,
  trackerPhaseLabel,
  ensureTrackerPhaseField,
  addFieldToProject,
  createWebhook,
  deleteWebhook,
  verifySignature,
};
