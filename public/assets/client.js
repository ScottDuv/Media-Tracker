'use strict';

/* Client-facing tracker: enter a code, poll for status, render steppers with
   hover/tap tooltips. Designed to run standalone or inside a WordPress iframe. */

const POLL_MS = 5000;
const $ = (sel) => document.querySelector(sel);

let phases = {};
let currentCode = null;
let pollTimer = null;

const relTime = (iso) => {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} day${h >= 48 ? 's' : ''} ago`;
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function loadPhases() {
  try {
    const res = await fetch('/api/phases');
    const data = await res.json();
    phases = data.phases || {};
  } catch (_) {
    phases = {};
  }
}

function stepHtml(step) {
  const def = phases[step.key] || {};
  const blurb = def.blurb || '';
  const initial = step.status === 'complete' ? '✓' : '';
  return `
    <div class="step ${step.status}" data-sid="${step.sid}">
      <div class="connector"></div>
      <div class="dot">${initial}</div>
      <div class="label" tabindex="0" role="button" aria-label="${esc(step.label)}: what to expect">${esc(step.label)}</div>
      <div class="tip" role="tooltip"><strong>${esc(step.label)}</strong>${esc(blurb)}</div>
    </div>`;
}

function cardHtml(video) {
  const done = video.delivered;
  return `
    <article class="card ${done ? 'done' : ''}">
      <div class="card-top">
        <div>
          <h2 class="card-title">${esc(video.title)}</h2>
          <div class="updated">Updated ${relTime(video.updatedAt)}</div>
        </div>
        <span class="status-pill ${done ? 'done' : ''}">${done ? 'Delivered' : esc(video.currentLabel)}</span>
      </div>
      <div class="bar"><span style="width:${video.progress}%"></span></div>
      <div class="stepper">${video.steps.map(stepHtml).join('')}</div>
    </article>`;
}

function wireTooltips(root) {
  // Tap-to-toggle on touch devices; hover handles desktop via CSS.
  root.querySelectorAll('.step .label').forEach((label) => {
    const step = label.closest('.step');
    const toggle = (e) => {
      e.preventDefault();
      const open = step.classList.contains('tip-open');
      root.querySelectorAll('.step.tip-open').forEach((s) => s.classList.remove('tip-open'));
      if (!open) step.classList.add('tip-open');
    };
    label.addEventListener('click', toggle);
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') toggle(e);
      if (e.key === 'Escape') step.classList.remove('tip-open');
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.step')) {
      root.querySelectorAll('.step.tip-open').forEach((s) => s.classList.remove('tip-open'));
    }
  });
}

function render(view) {
  $('#clientName').textContent = view.clientName ? `${view.clientName} — your videos` : 'Your videos';
  $('#codeLabel').textContent = view.code;
  const cards = $('#cards');
  cards.innerHTML = view.videos.map(cardHtml).join('');
  $('#empty').classList.toggle('hide', view.videos.length > 0);
  wireTooltips(cards);
  reportHeight();
}

/* When embedded in an iframe, tell the parent page our height so it can resize
   the iframe to fit (see the WordPress embed snippet in the README). */
function reportHeight() {
  if (window.parent === window) return;
  const h = document.documentElement.scrollHeight;
  window.parent.postMessage({ type: 'media-tracker:height', height: h }, '*');
}
window.addEventListener('resize', reportHeight);

async function poll() {
  if (!currentCode) return;
  try {
    const res = await fetch(`/api/tracker/${encodeURIComponent(currentCode)}`);
    if (res.status === 404) {
      showGate('We could not find a project with that code. Double-check it with your producer.');
      return;
    }
    if (!res.ok) return;
    render(await res.json());
  } catch (_) {
    /* transient network error — keep the last render, try again next tick */
  }
}

function startTracking(code) {
  currentCode = code;
  try { localStorage.setItem('mt_code', code); } catch (_) {}
  history.replaceState(null, '', `?code=${encodeURIComponent(code)}`);
  $('#gate').classList.add('hide');
  $('#tracker').classList.remove('hide');
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

function showGate(message) {
  clearInterval(pollTimer);
  currentCode = null;
  try { localStorage.removeItem('mt_code'); } catch (_) {}
  $('#tracker').classList.add('hide');
  $('#gate').classList.remove('hide');
  $('#gateErr').textContent = message || '';
  $('#codeInput').focus();
  reportHeight();
}

// ---- init ----
(async function init() {
  await loadPhases();

  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#codeInput').value.trim();
    if (!code) return;
    $('#gateErr').textContent = '';
    startTracking(code);
  });
  $('#changeCode').addEventListener('click', () => showGate(''));

  // Restore from URL (?code=) or last-used code.
  const params = new URLSearchParams(location.search);
  let saved = params.get('code');
  if (!saved) { try { saved = localStorage.getItem('mt_code'); } catch (_) {} }
  if (saved) {
    $('#codeInput').value = saved;
    startTracking(saved);
  }
})();
