'use strict';

/**
 * Tests the Asana-driven phase logic: the Client Review / Revision bounce must
 * auto-number rounds, reuse the seeded round 1, and be idempotent on repeats.
 * Run with: node test/phase.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the store's data file to a throwaway dir.
process.env.MT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-test-'));

const store = require('../src/store');
const { stepLabel } = require('../src/phases');

store.load();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ✓', msg);
  } else {
    console.error('  ✗', msg);
    failures++;
  }
}

function currentLabel(videoId) {
  const v = store.getVideo(videoId);
  if (v.delivered) return 'Delivered';
  const step = v.timeline.find((s) => s.sid === v.currentStepId);
  return step ? stepLabel(step) : 'none';
}
function timelineLabels(videoId) {
  return store.getVideo(videoId).timeline.map(stepLabel).join(' | ');
}

// --- setup ---
const project = store.upsertAsanaProject({ asanaProjectGid: '999000111', clientName: 'Test' });
const video = store.upsertAsanaVideo(project.id, 'Test Video', 'task_1');

console.log('Phase progression:');
store.setVideoPhaseByKey(video.id, 'rough_edit');
assert(currentLabel(video.id) === 'Rough Edit', 'rough_edit → Rough Edit');

store.setVideoPhaseByKey(video.id, 'fine_edit');
assert(currentLabel(video.id) === 'Fine Edit', 'fine_edit → Fine Edit');

store.setVideoPhaseByKey(video.id, 'client_review');
assert(currentLabel(video.id) === 'Client Review 1', 'client_review reuses seeded round 1');

// idempotent repeat
store.setVideoPhaseByKey(video.id, 'client_review');
assert(currentLabel(video.id) === 'Client Review 1', 'repeat client_review stays on round 1 (idempotent)');

store.setVideoPhaseByKey(video.id, 'revision');
assert(currentLabel(video.id) === 'Revision 1', 'revision reuses seeded round 1');

store.setVideoPhaseByKey(video.id, 'client_review');
assert(currentLabel(video.id) === 'Client Review 2', 'bounce back → Client Review 2 (new round created)');

store.setVideoPhaseByKey(video.id, 'revision');
assert(currentLabel(video.id) === 'Revision 2', 'bounce → Revision 2');

store.setVideoPhaseByKey(video.id, 'client_review');
assert(currentLabel(video.id) === 'Client Review 3', 'bounce → Client Review 3');

console.log('  timeline:', timelineLabels(video.id));

store.setVideoPhaseByKey(video.id, 'final_cut');
assert(currentLabel(video.id) === 'Final Cut Delivery', 'final_cut → Final Cut Delivery');

store.setVideoPhaseByKey(video.id, 'delivered');
assert(currentLabel(video.id) === 'Delivered', 'delivered → Delivered flag set');
assert(store.getVideo(video.id).delivered === true, 'delivered boolean is true');

// going backwards clears delivered
store.setVideoPhaseByKey(video.id, 'fine_edit');
assert(store.getVideo(video.id).delivered === false, 'reverting a phase clears delivered');

console.log('\nDedup + linkage:');
const again = store.upsertAsanaVideo(project.id, 'Test Video Renamed', 'task_1');
assert(again.id === video.id, 'same Asana task GID reuses the same video');
assert(store.getVideo(video.id).title === 'Test Video Renamed', 'title updates from Asana task name');
const proj2 = store.upsertAsanaProject({ asanaProjectGid: '999000111' });
assert(proj2.id === project.id, 'same Asana project GID reuses the same project');
assert(store.findProjectByCodeOrGid('999000111').id === project.id, 'lookup by Asana GID works');

// cleanup
try { fs.rmSync(process.env.MT_DATA_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
