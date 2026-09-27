'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { defaultTimeline, PHASES } = require('./phases');

/**
 * Tiny JSON-file data store. No external database required — the whole state
 * lives in one file that is written atomically. This is intentional: it keeps
 * the app to zero runtime dependencies and trivial to deploy. For higher write
 * volume, swap this module for a real database without touching the callers.
 */

const DATA_DIR = process.env.MT_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let state = { projects: {}, videos: {}, asana: { webhooks: {} } };
let writeQueued = false;

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.projects = state.projects || {};
      state.videos = state.videos || {};
      state.asana = state.asana || { webhooks: {} };
      state.asana.webhooks = state.asana.webhooks || {};
    } else {
      seed();
      persist();
    }
  } catch (err) {
    // Never crash on a corrupt file; start clean but keep the bad file for recovery.
    console.error('[store] failed to load data file:', err.message);
    try {
      fs.renameSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
    } catch (_) {
      /* ignore */
    }
    state = { projects: {}, videos: {}, asana: { webhooks: {} } };
    seed();
    persist();
  }
}

function persist() {
  // Debounce rapid writes into a single flush on the next tick.
  if (writeQueued) return;
  writeQueued = true;
  process.nextTick(() => {
    writeQueued = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, DATA_FILE); // atomic replace
    } catch (err) {
      console.error('[store] failed to persist:', err.message);
    }
  });
}

function seed() {
  // A demo project so the studio and client views have something to show.
  const project = {
    id: id('proj'),
    code: '2026728',
    clientName: 'Demo Client',
    createdAt: nowIso(),
  };
  state.projects[project.id] = project;

  const titles = ['Brand Anthem (60s)', 'Founder Interview', 'Product Explainer'];
  titles.forEach((title, i) => {
    const video = newVideoRecord(project.id, title);
    // Stagger the demo videos across the pipeline.
    const idx = [1, 3, 5][i]; // rough edit / revision 1 / final cut
    video.currentStepId = video.timeline[idx].sid;
    state.videos[video.id] = video;
  });
}

// ---- helpers -------------------------------------------------------------

function stampTimeline(timeline) {
  return timeline.map((s) => ({ sid: id('step'), key: s.key, cycle: s.cycle }));
}

function newVideoRecord(projectId, title, asanaTaskId = null) {
  const timeline = stampTimeline(defaultTimeline());
  return {
    id: id('vid'),
    projectId,
    title,
    asanaTaskId,
    timeline,
    currentStepId: timeline[0].sid,
    delivered: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// ---- projects ------------------------------------------------------------

function listProjects() {
  return Object.values(state.projects).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
}

function getProject(projectId) {
  return state.projects[projectId] || null;
}

function findProjectByCode(code) {
  const norm = String(code || '').trim();
  return Object.values(state.projects).find((p) => p.code === norm) || null;
}

function createProject({ code, clientName, displayName }) {
  const norm = String(code || '').trim();
  if (!norm) throw new Error('A project code is required.');
  if (findProjectByCode(norm)) throw new Error('That project code is already in use.');
  const project = {
    id: id('proj'),
    code: norm,
    clientName: String(clientName || '').trim(),
    displayName: String(displayName || '').trim(),
    asanaProjectGid: null,
    createdAt: nowIso(),
  };
  state.projects[project.id] = project;
  persist();
  return project;
}

function updateProject(projectId, { code, clientName }) {
  const project = state.projects[projectId];
  if (!project) throw new Error('Project not found.');
  if (code !== undefined) {
    const norm = String(code).trim();
    if (!norm) throw new Error('A project code is required.');
    const clash = findProjectByCode(norm);
    if (clash && clash.id !== projectId) throw new Error('That project code is already in use.');
    project.code = norm;
  }
  if (clientName !== undefined) project.clientName = String(clientName).trim();
  persist();
  return project;
}

function updateProjectFields(projectId, patch) {
  const project = state.projects[projectId];
  if (!project) throw new Error('Project not found.');
  if (patch.displayName !== undefined) project.displayName = String(patch.displayName).trim();
  if (patch.clientName !== undefined) project.clientName = String(patch.clientName).trim();
  if (patch.code !== undefined) {
    const norm = String(patch.code).trim();
    if (!norm) throw new Error('A project code is required.');
    const clash = findProjectByCode(norm);
    if (clash && clash.id !== projectId) throw new Error('That project code is already in use.');
    project.code = norm;
  }
  persist();
  return project;
}

function deleteProject(projectId) {
  if (!state.projects[projectId]) throw new Error('Project not found.');
  delete state.projects[projectId];
  for (const v of Object.values(state.videos)) {
    if (v.projectId === projectId) delete state.videos[v.id];
  }
  persist();
}

// ---- videos --------------------------------------------------------------

function listVideos(projectId) {
  return Object.values(state.videos)
    .filter((v) => v.projectId === projectId)
    .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
}

function getVideo(videoId) {
  return state.videos[videoId] || null;
}

function createVideo(projectId, title) {
  if (!state.projects[projectId]) throw new Error('Project not found.');
  const clean = String(title || '').trim();
  if (!clean) throw new Error('A video title is required.');
  const video = newVideoRecord(projectId, clean);
  state.videos[video.id] = video;
  persist();
  return video;
}

function updateVideo(videoId, patch) {
  const video = state.videos[videoId];
  if (!video) throw new Error('Video not found.');
  if (patch.title !== undefined) {
    const clean = String(patch.title).trim();
    if (!clean) throw new Error('A video title is required.');
    video.title = clean;
  }
  if (patch.currentStepId !== undefined) {
    if (patch.currentStepId !== null && !video.timeline.some((s) => s.sid === patch.currentStepId)) {
      throw new Error('That step does not belong to this video.');
    }
    video.currentStepId = patch.currentStepId;
  }
  if (patch.delivered !== undefined) video.delivered = !!patch.delivered;
  video.updatedAt = nowIso();
  persist();
  return video;
}

function deleteVideo(videoId) {
  if (!state.videos[videoId]) throw new Error('Video not found.');
  delete state.videos[videoId];
  persist();
}

/**
 * Add a repeatable step (client_review or revision). The cycle number is
 * assigned automatically based on how many of that phase already exist, and
 * the new step is inserted just before Final Cut Delivery so the timeline
 * stays sensible.
 */
function addStep(videoId, key) {
  const video = state.videos[videoId];
  if (!video) throw new Error('Video not found.');
  if (key !== 'client_review' && key !== 'revision') {
    throw new Error('Only Client Review and Revision steps can be added.');
  }
  const existing = video.timeline.filter((s) => s.key === key).length;
  const step = { sid: id('step'), key, cycle: existing + 1 };
  const finalIdx = video.timeline.findIndex((s) => s.key === 'final_cut');
  if (finalIdx === -1) video.timeline.push(step);
  else video.timeline.splice(finalIdx, 0, step);
  video.updatedAt = nowIso();
  persist();
  return video;
}

function removeStep(videoId, sid) {
  const video = state.videos[videoId];
  if (!video) throw new Error('Video not found.');
  const step = video.timeline.find((s) => s.sid === sid);
  if (!step) throw new Error('Step not found.');
  const def = require('./phases').PHASES[step.key];
  if (!def || !def.repeatable) {
    throw new Error('Only Client Review and Revision steps can be removed.');
  }
  video.timeline = video.timeline.filter((s) => s.sid !== sid);
  if (video.currentStepId === sid) {
    video.currentStepId = video.timeline.length ? video.timeline[0].sid : null;
  }
  // Renumber remaining instances of that phase so the labels stay 1..N.
  let n = 0;
  for (const s of video.timeline) {
    if (s.key === step.key) s.cycle = ++n;
  }
  video.updatedAt = nowIso();
  persist();
  return video;
}

// ---- Asana linkage -------------------------------------------------------

function findProjectByCodeOrGid(input) {
  const norm = String(input || '').trim();
  if (!norm) return null;
  return (
    Object.values(state.projects).find((p) => p.code === norm || p.asanaProjectGid === norm) || null
  );
}

function getProjectByAsanaGid(gid) {
  const norm = String(gid || '').trim();
  return Object.values(state.projects).find((p) => p.asanaProjectGid === norm) || null;
}

/** Find or create a Media Tracker project bound to an Asana project GID. */
function upsertAsanaProject({ asanaProjectGid, clientName, displayName }) {
  const gid = String(asanaProjectGid).trim();
  const existing = getProjectByAsanaGid(gid);
  if (existing) return existing;
  // Default the client code to the Asana GID; fall back stays the GID if a
  // friendly code ever collides (GIDs are globally unique).
  let code = gid;
  if (findProjectByCode(code)) code = gid;
  const project = {
    id: id('proj'),
    code,
    asanaProjectGid: gid,
    clientName: String(clientName || '').trim(),
    displayName: String(displayName || '').trim(),
    createdAt: nowIso(),
  };
  state.projects[project.id] = project;
  persist();
  return project;
}

function getVideoByAsanaTaskId(taskId) {
  const norm = String(taskId || '').trim();
  return Object.values(state.videos).find((v) => v.asanaTaskId === norm) || null;
}

/** Find or create a video bound to an Asana task GID. */
function upsertAsanaVideo(projectId, title, asanaTaskId) {
  const existing = getVideoByAsanaTaskId(asanaTaskId);
  if (existing) {
    if (title && title !== existing.title) {
      existing.title = title;
      existing.updatedAt = nowIso();
      persist();
    }
    return existing;
  }
  const video = newVideoRecord(projectId, String(title || 'Untitled video').trim(), String(asanaTaskId));
  state.videos[video.id] = video;
  persist();
  return video;
}

/**
 * Move a video to the phase named by `phaseKey` (from an Asana dropdown).
 * Non-repeatable phases jump to their single step. Repeatable phases
 * (client_review / revision) advance to the next unused round, or create the
 * next numbered round if none remains — this is what auto-numbers the
 * Client Review / Revision bounce. 'delivered' marks the whole video done.
 * Idempotent: a repeated event for the current phase is a no-op.
 */
function setVideoPhaseByKey(videoId, phaseKey) {
  const video = state.videos[videoId];
  if (!video) throw new Error('Video not found.');

  if (phaseKey === 'delivered') {
    video.delivered = true;
    const fc = video.timeline.find((s) => s.key === 'final_cut');
    if (fc) video.currentStepId = fc.sid;
    video.updatedAt = nowIso();
    persist();
    return video;
  }

  const def = PHASES[phaseKey];
  if (!def) throw new Error(`Unknown phase: ${phaseKey}`);
  video.delivered = false;

  const currentIdx = video.timeline.findIndex((s) => s.sid === video.currentStepId);
  const currentStep = video.timeline[currentIdx];

  if (!def.repeatable) {
    let step = video.timeline.find((s) => s.key === phaseKey);
    if (!step) {
      step = { sid: id('step'), key: phaseKey, cycle: null };
      video.timeline.push(step);
    }
    video.currentStepId = step.sid;
  } else if (!currentStep || currentStep.key !== phaseKey) {
    // Advance to the next existing round of this phase after the current step…
    let next = null;
    for (let i = currentIdx + 1; i < video.timeline.length; i++) {
      if (video.timeline[i].key === phaseKey) {
        next = video.timeline[i];
        break;
      }
    }
    if (next) {
      video.currentStepId = next.sid;
    } else {
      // …or create the next numbered round just before Final Cut Delivery.
      const count = video.timeline.filter((s) => s.key === phaseKey).length;
      const step = { sid: id('step'), key: phaseKey, cycle: count + 1 };
      const finalIdx = video.timeline.findIndex((s) => s.key === 'final_cut');
      if (finalIdx === -1) video.timeline.push(step);
      else video.timeline.splice(finalIdx, 0, step);
      video.currentStepId = step.sid;
    }
  }
  // else: already on this repeatable phase → no-op (duplicate event)

  video.updatedAt = nowIso();
  persist();
  return video;
}

// ---- Asana webhook records ----

function saveWebhook(projectGid, rec) {
  state.asana.webhooks[String(projectGid)] = rec; // { gid, secret, mtProjectId }
  persist();
}

function listWebhooks() {
  return { ...state.asana.webhooks };
}

function getWebhookByProject(projectGid) {
  return state.asana.webhooks[String(projectGid)] || null;
}

function deleteWebhookRecord(projectGid) {
  delete state.asana.webhooks[String(projectGid)];
  persist();
}

module.exports = {
  load,
  listProjects,
  getProject,
  findProjectByCode,
  createProject,
  updateProject,
  updateProjectFields,
  deleteProject,
  listVideos,
  getVideo,
  createVideo,
  updateVideo,
  deleteVideo,
  addStep,
  removeStep,
  // Asana
  findProjectByCodeOrGid,
  getProjectByAsanaGid,
  upsertAsanaProject,
  getVideoByAsanaTaskId,
  upsertAsanaVideo,
  setVideoPhaseByKey,
  saveWebhook,
  listWebhooks,
  getWebhookByProject,
  deleteWebhookRecord,
};
