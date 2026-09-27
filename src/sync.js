'use strict';

const store = require('./store');
const asana = require('./asana');
const { phaseKeyFromLabel } = require('./phases');

/**
 * Orchestrates the Asana ↔ Media Tracker sync: connecting a project (provision
 * the field, register a webhook, import existing videos) and reconciling
 * incoming webhook events into tracker phase changes.
 */

// Secret captured by the webhook endpoint during Asana's handshake POST.
// connectProject() reads it immediately after createWebhook resolves.
const handshake = { secret: null };

/** "Evermay - 19-video Package ($9000)" → "Evermay" (keep pricing off client view). */
function cleanClientName(asanaName) {
  const s = String(asanaName || '').trim();
  const idx = s.indexOf(' - ');
  return (idx > 0 ? s.slice(0, idx) : s).trim();
}

async function connectProject(input) {
  const gid = asana.parseProjectGid(input);
  const proj = await asana.getProject(gid);
  const workspaceGid = proj.workspace && proj.workspace.gid;
  if (!workspaceGid) throw new Error('Could not resolve the Asana workspace for that project.');

  // Make sure the "Tracker Phase" field exists and is on this project.
  const fieldGid = await asana.ensureTrackerPhaseField(workspaceGid);
  await asana.addFieldToProject(gid, fieldGid);

  const mtProject = store.upsertAsanaProject({
    asanaProjectGid: gid,
    clientName: cleanClientName(proj.name),
    displayName: cleanClientName(proj.name),
  });

  // Register the webhook (skip if already connected).
  let webhook = store.getWebhookByProject(gid);
  if (!webhook) {
    handshake.secret = null;
    const created = await asana.createWebhook(gid); // resolves only after the handshake
    const secret = handshake.secret;
    handshake.secret = null;
    if (!secret) {
      throw new Error(
        'Asana webhook handshake did not complete — confirm PUBLIC_BASE_URL is this app’s public HTTPS URL and reachable.'
      );
    }
    store.saveWebhook(gid, { gid: created.gid, secret, mtProjectId: mtProject.id });
    webhook = store.getWebhookByProject(gid);
  }

  const imported = await importProjectTasks(gid, mtProject.id);
  return { project: mtProject, webhookGid: webhook.gid, imported };
}

async function importProjectTasks(gid, mtProjectId) {
  const tasks = await asana.listProjectTasks(gid);
  let n = 0;
  for (const task of tasks || []) {
    const label = asana.trackerPhaseLabel(task);
    if (!label) continue; // not a tracked video (e.g. the Pre/Pro/Post tasks)
    const key = phaseKeyFromLabel(label);
    if (!key) continue;
    const video = store.upsertAsanaVideo(mtProjectId, task.name, task.gid);
    store.setVideoPhaseByKey(video.id, key);
    n++;
  }
  return n;
}

async function disconnectProject(gid) {
  const wh = store.getWebhookByProject(gid);
  if (wh && wh.gid) {
    try {
      await asana.deleteWebhook(wh.gid);
    } catch (_) {
      /* webhook may already be gone on Asana's side */
    }
  }
  store.deleteWebhookRecord(gid);
}

/** Identify which connected project an event belongs to by verifying its signature. */
function findProjectBySignature(rawBody, signature) {
  const hooks = store.listWebhooks();
  for (const [projectGid, rec] of Object.entries(hooks)) {
    if (asana.verifySignature(rec.secret, rawBody, signature)) return projectGid;
  }
  return null;
}

async function handleEvents(projectGid, events) {
  const wh = store.getWebhookByProject(projectGid);
  if (!wh) return;
  const seen = new Set();
  for (const ev of events || []) {
    const res = ev.resource || {};
    if (res.resource_type !== 'task' || !res.gid) continue;
    if (seen.has(res.gid)) continue; // collapse duplicate events for one task
    seen.add(res.gid);
    try {
      await reconcileTask(res.gid, wh.mtProjectId);
    } catch (err) {
      console.error('[asana] reconcile failed for task', res.gid, err.message);
    }
  }
}

async function reconcileTask(taskGid, mtProjectId) {
  let task;
  try {
    task = await asana.getTask(taskGid);
  } catch (_) {
    return; // task deleted or unreadable — leave any existing video untouched
  }
  const label = asana.trackerPhaseLabel(task);
  if (!label) return; // no Tracker Phase set → not a tracked video
  const key = phaseKeyFromLabel(label);
  if (!key) return;
  const video = store.upsertAsanaVideo(mtProjectId, task.name, taskGid);
  store.setVideoPhaseByKey(video.id, key);
}

/** Connected projects for the studio console. */
function listConnected() {
  const hooks = store.listWebhooks();
  return Object.entries(hooks).map(([gid, rec]) => {
    const project = store.getProjectByAsanaGid(gid);
    return {
      asanaProjectGid: gid,
      webhookGid: rec.gid,
      code: project ? project.code : gid,
      displayName: project ? project.displayName || project.clientName : '',
    };
  });
}

module.exports = {
  handshake,
  cleanClientName,
  connectProject,
  disconnectProject,
  importProjectTasks,
  findProjectBySignature,
  handleEvents,
  reconcileTask,
  listConnected,
};
