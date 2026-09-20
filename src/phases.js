'use strict';

/**
 * Canonical post-production phases for the Media Tracker.
 *
 * `client_review` and `revision` are "repeatable" — the studio can add more
 * than one of each, and every instance is numbered (Client Review 1,
 * Revision 1, Client Review 2, ...). The other phases appear exactly once.
 *
 * `blurb` is the client-facing text shown in the hover / tap tooltip.
 */
const PHASES = {
  transcription: {
    key: 'transcription',
    label: 'Transcription',
    repeatable: false,
    blurb:
      'We transcribe every word of your footage. This makes the raw material searchable, ' +
      'powers accurate captions later, and gives the editor a fast way to find the best takes. ' +
      'Nothing is cut yet — we are just reading the room.',
  },
  rough_edit: {
    key: 'rough_edit',
    label: 'Rough Edit',
    repeatable: false,
    blurb:
      'We assemble the strongest takes into a first structural draft — story order, pacing, and ' +
      'length. Expect placeholder audio and no polish. The goal here is the shape of the story, ' +
      'not the finish.',
  },
  fine_edit: {
    key: 'fine_edit',
    label: 'Fine Edit',
    repeatable: false,
    blurb:
      'We refine the approved structure: tightening timing, color grading, mixing audio, and adding ' +
      'graphics, titles, and transitions. This is where the video starts to look and sound finished.',
  },
  client_review: {
    key: 'client_review',
    label: 'Client Review',
    repeatable: true,
    blurb:
      'The current cut is ready for you to watch. We pause here and wait for your notes — this stage ' +
      'stays active until we hear back from you. Share your feedback in one consolidated round so we ' +
      'can turn it around efficiently.',
  },
  revision: {
    key: 'revision',
    label: 'Revision',
    repeatable: true,
    blurb:
      'We are applying the changes from your latest round of feedback. Once these edits are complete, ' +
      'the video moves back to Client Review so you can confirm everything looks right.',
  },
  final_cut: {
    key: 'final_cut',
    label: 'Final Cut Delivery',
    repeatable: false,
    blurb:
      'Your finished video is exported and delivered in the formats you need (web, social, broadcast, ' +
      'archive). This is the last stage — once it is complete, the project is done.',
  },
};

/** Fixed display order used to sort a video's timeline sensibly. */
const PHASE_ORDER = [
  'transcription',
  'rough_edit',
  'fine_edit',
  'client_review',
  'revision',
  'final_cut',
];

/** The steps every new video starts with, in order. */
function defaultTimeline() {
  return [
    { key: 'transcription', cycle: null },
    { key: 'rough_edit', cycle: null },
    { key: 'fine_edit', cycle: null },
    { key: 'client_review', cycle: 1 },
    { key: 'revision', cycle: 1 },
    { key: 'final_cut', cycle: null },
  ];
}

/** Human label for a step, including the cycle number when it applies. */
function stepLabel(step) {
  const def = PHASES[step.key];
  if (!def) return step.key;
  if (def.repeatable && step.cycle) return `${def.label} ${step.cycle}`;
  return def.label;
}

module.exports = { PHASES, PHASE_ORDER, defaultTimeline, stepLabel };
