'use strict';

/* Studio (editor) console: create projects, add videos, and set each video's
   current phase. Talks to the protected /api/admin/* endpoints. */

const $ = (s) => document.querySelector(s);
let PHASES = {};

const PHASE_KEYS = ['transcription', 'rough_edit', 'fine_edit', 'client_review', 'revision', 'final_cut'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- auth ----
async function checkSession() {
  const { authed } = await api('GET', '/api/studio/session');
  showApp(authed);
  if (authed) loadProjects();
}

function showApp(authed) {
  $('#login').classList.toggle('hide', authed);
  $('#console').classList.toggle('hide', !authed);
}

// ---- rendering ----
function stepControls(video) {
  const currentSid = video.steps.find((s) => s.status === 'current')?.sid;
  const chips = video.steps
    .map((s) => {
      const cls = s.status === 'current' ? 'active' : s.status === 'complete' ? 'done' : '';
      const removable = (s.key === 'client_review' || s.key === 'revision');
      const x = removable
        ? `<span class="rm" title="Remove step" data-vid="${video.id}" data-rm="${s.sid}" style="margin-left:6px;cursor:pointer;">×</span>`
        : '';
      return `<button class="phase-chip ${cls}" data-vid="${video.id}" data-sid="${s.sid}" title="Set as current phase">${esc(s.label)}${x}</button>`;
    })
    .join('');
  return chips;
}

function videoRow(video) {
  const done = video.delivered;
  return `
    <div class="pv" data-vidrow="${video.id}">
      <div class="spread">
        <p class="pv-title">${esc(video.title)} <span class="muted" style="font-weight:400;">— ${done ? 'Delivered' : esc(video.currentLabel)}</span></p>
        <div class="row">
          <button class="phase-chip ${done ? 'done' : ''}" data-deliver="${video.id}" data-val="${done ? '0' : '1'}">${done ? 'Reopen' : 'Mark delivered'}</button>
          <button class="danger small" data-delvid="${video.id}">Delete</button>
        </div>
      </div>
      <div class="chipset" style="margin-bottom:8px;">${stepControls(video)}</div>
      <div class="row">
        <button class="ghost small" data-add="client_review" data-vid="${video.id}">+ Client Review</button>
        <button class="ghost small" data-add="revision" data-vid="${video.id}">+ Revision</button>
      </div>
    </div>`;
}

function projectPanel(p) {
  const origin = location.origin;
  const clientUrl = `${origin}/?code=${encodeURIComponent(p.code)}`;
  return `
    <div class="panel" data-proj="${p.id}">
      <div class="spread">
        <div>
          <h2>${esc(p.clientName || 'Untitled project')}</h2>
          <div class="muted">Code <span class="code-chip">${esc(p.code)}</span>
            · <a href="${clientUrl}" target="_blank" rel="noopener">client view</a></div>
        </div>
        <button class="danger small" data-delproj="${p.id}">Delete project</button>
      </div>
      <div style="margin:14px 0;">
        <form class="row" data-addvid="${p.id}" autocomplete="off">
          <input class="text" name="title" placeholder="New video title (e.g. Founder Interview)" required />
          <button type="submit">Add video</button>
        </form>
      </div>
      ${p.videos.length ? p.videos.map(videoRow).join('') : '<p class="muted">No videos yet.</p>'}
    </div>`;
}

async function loadProjects() {
  try {
    const { projects } = await api('GET', '/api/admin/projects');
    $('#projects').innerHTML = projects.length
      ? projects.map(projectPanel).join('')
      : '<p class="muted">No projects yet — create one above.</p>';
  } catch (err) {
    if (String(err.message).includes('authenticat')) return showApp(false);
    console.error(err);
  }
}

// ---- event delegation ----
document.addEventListener('click', async (e) => {
  const t = e.target;
  try {
    // remove a review/revision step (click the ×, stop the chip handler)
    if (t.dataset.rm) {
      e.stopPropagation();
      await api('DELETE', `/api/admin/videos/${t.dataset.vid}/steps/${t.dataset.rm}`);
      return loadProjects();
    }
    // set current phase
    if (t.classList.contains('phase-chip') && t.dataset.sid) {
      await api('PATCH', `/api/admin/videos/${t.dataset.vid}`, { currentStepId: t.dataset.sid, delivered: false });
      return loadProjects();
    }
    // add step
    if (t.dataset.add) {
      await api('POST', `/api/admin/videos/${t.dataset.vid}/steps`, { key: t.dataset.add });
      return loadProjects();
    }
    // mark delivered / reopen
    if (t.dataset.deliver) {
      await api('PATCH', `/api/admin/videos/${t.dataset.deliver}`, { delivered: t.dataset.val === '1' });
      return loadProjects();
    }
    // delete video
    if (t.dataset.delvid) {
      if (!confirm('Delete this video tracker?')) return;
      await api('DELETE', `/api/admin/videos/${t.dataset.delvid}`);
      return loadProjects();
    }
    // delete project
    if (t.dataset.delproj) {
      if (!confirm('Delete this project and all of its video trackers?')) return;
      await api('DELETE', `/api/admin/projects/${t.dataset.delproj}`);
      return loadProjects();
    }
    if (t.id === 'logout') {
      await api('POST', '/api/studio/logout');
      return showApp(false);
    }
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  // add video
  if (f.dataset.addvid) {
    e.preventDefault();
    const title = f.querySelector('[name="title"]').value.trim();
    if (!title) return;
    try {
      await api('POST', `/api/admin/projects/${f.dataset.addvid}/videos`, { title });
      f.reset();
      loadProjects();
    } catch (err) { alert(err.message); }
  }
});

// login
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('POST', '/api/studio/login', { password: $('#password').value });
    showApp(true);
    loadProjects();
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

// new project
$('#projForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#projErr').textContent = '';
  try {
    await api('POST', '/api/admin/projects', {
      code: $('#projCode').value.trim(),
      clientName: $('#projClient').value.trim(),
    });
    $('#projCode').value = '';
    $('#projClient').value = '';
    loadProjects();
  } catch (err) {
    $('#projErr').textContent = err.message;
  }
});

// ---- init ----
(async function init() {
  try {
    const { phases } = await api('GET', '/api/phases');
    PHASES = phases;
  } catch (_) {}
  checkSession();
})();
