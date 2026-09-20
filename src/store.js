'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { defaultTimeline } = require('./phases');

/**
 * Tiny JSON-file data store. No external database required — the whole state
 * lives in one file that is written atomically. This is intentional: it keeps
 * the app to zero runtime dependencies and trivial to deploy. For higher write
 * volume, swap this module for a real database without touching the callers.
 */

const DATA_DIR = process.env.MT_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let state = { projects: {}, videos: {} };
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
    state = { projects: {}, videos: {} };
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

function newVideoRecord(projectId, title) {
  const timeline = stampTimeline(defaultTimeline());
  return {
    id: id('vid'),
    projectId,
    title,
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

function createProject({ code, clientName }) {
  const norm = String(code || '').trim();
  if (!norm) throw new Error('A project code is required.');
  if (findProjectByCode(norm)) throw new Error('That project code is already in use.');
  const project = {
    id: id('proj'),
    code: norm,
    clientName: String(clientName || '').trim(),
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

module.exports = {
  load,
  listProjects,
  getProject,
  findProjectByCode,
  createProject,
  updateProject,
  deleteProject,
  listVideos,
  getVideo,
  createVideo,
  updateVideo,
  deleteVideo,
  addStep,
  removeStep,
};
