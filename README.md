# Media Tracker

A Domino's-style "pizza tracker" for video post-production. Clients type in a
project code and watch their videos move through the pipeline in real time;
the studio sets each video's phase from a private console.

- **Zero runtime dependencies.** Pure Node.js (built-in modules only). No build
  step, no database server, no `npm install`. Deploy with `node server.js`.
- **Embeddable anywhere.** The client view drops into any WordPress site
  (including WordPress.com) with a single `<iframe>`.

---

## Phases

| Phase | Repeats? | Notes |
|-------|----------|-------|
| Transcription | no | |
| Rough Edit | no | |
| Fine Edit | no | |
| **Client Review** | **yes** | numbered — Client Review 1, 2, … |
| **Revision** | **yes** | numbered — Revision 1, 2, … |
| Final Cut Delivery | no | |

Client Review and Revision are the two phases the process bounces between. Each
time the studio adds one, it is automatically numbered and inserted before
Final Cut Delivery, so a real timeline reads e.g.:

```
Transcription · Rough Edit · Fine Edit · Client Review 1 · Revision 1 · Client Review 2 · Revision 2 · Final Cut Delivery
```

Every phase has a plain-English blurb (defined in `src/phases.js`) that clients
see in a tooltip when they hover (desktop) or tap (mobile) a phase label.

---

## Quick start

```bash
# from the repo root
STUDIO_PASSWORD=your-studio-password node server.js
```

Then open:

- **Client tracker:** http://localhost:3000/ — enter code `2026728` (a demo
  project is seeded on first run)
- **Studio console:** http://localhost:3000/studio — sign in with the password
  you set

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `STUDIO_PASSWORD` | `changeme` | Password for the studio side. **Set this in production.** |
| `MT_SECRET` | random each boot | HMAC secret for signing login cookies. Set a fixed value so logins survive restarts. |
| `MT_DATA_DIR` | `./data` | Where `data.json` is stored. Point this at a persistent disk in production. |
| `NODE_ENV` | — | Set to `production` to make the login cookie `Secure` + `SameSite=None`. |

Data lives in `data/data.json`, written atomically. It is `.gitignore`d. Back
up that one file and you have backed up everything.

---

## How it works

**Client side (`/`)** — Self-contained page. Client enters a project code; the
page polls `GET /api/tracker/:code` every 5 seconds and re-renders the
steppers. The code is remembered (URL `?code=` + `localStorage`) so a bookmark
or refresh lands straight on their trackers.

**Studio side (`/studio`)** — Password-protected console. Create projects,
assign each a client code, add videos, and set each video's current phase by
clicking a phase chip. Add extra Client Review / Revision rounds with one
button; mark a video **Delivered** when it ships.

**API** (JSON):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/phases` | public | Phase labels + tooltip blurbs |
| `GET` | `/api/tracker/:code` | public | A project's videos + step statuses |
| `POST` | `/api/studio/login` | public | `{password}` → sets cookie |
| `GET` | `/api/admin/projects` | studio | Projects with nested videos |
| `POST` | `/api/admin/projects` | studio | `{code, clientName}` |
| `POST` | `/api/admin/projects/:id/videos` | studio | `{title}` |
| `PATCH` | `/api/admin/videos/:id` | studio | `{currentStepId?, title?, delivered?}` |
| `POST` | `/api/admin/videos/:id/steps` | studio | `{key: "client_review"\|"revision"}` |
| `DELETE` | `/api/admin/videos/:id/steps/:sid` | studio | remove a review/revision round |

The public tracker endpoint never exposes internal IDs beyond what the view
needs, and returns `404` for unknown codes.

---

## Embedding in WordPress

The client view is built to live in an `<iframe>`. This works on **every**
WordPress tier, including WordPress.com plans that can't run PHP plugins.

1. Deploy this app somewhere with HTTPS (see below), e.g.
   `https://tracker.valleystrategy.co`.
2. Create the page `valleystrategy.co/media-tracker`.
3. Add a **Custom HTML** block with:

```html
<iframe
  id="media-tracker"
  src="https://tracker.valleystrategy.co/"
  title="Project Tracker"
  style="width:100%; border:0; min-height:520px;"
  loading="lazy"></iframe>

<script>
  // Auto-resize the iframe to its content (the app posts its height).
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'media-tracker:height') {
      document.getElementById('media-tracker').style.height = e.data.height + 'px';
    }
  });
</script>
```

The code-entry box lives *inside* the iframe, so the whole client experience
(enter code → see trackers) happens on your WordPress page. You can also
deep-link a specific client straight to their trackers by pointing the `src` at
`https://tracker.valleystrategy.co/?code=2026728`.

> **Brand color:** the accent (currently Domino's red) is a single CSS variable.
> Edit `--accent` in `public/assets/styles.css` to match Valley's palette.

### Self-hosted WordPress? Two upgrades are available

If `valleystrategy.co` is self-hosted (not WordPress.com), you can optionally:

- Register a `[media_tracker]` shortcode that outputs the iframe snippet, so
  editors drop `[media_tracker]` into any page.
- Later, replace the iframe with a thin PHP plugin that calls this same API,
  for a fully native look. The backend here is designed to support that without
  changes.

Say the word and I'll add the shortcode plugin (`media-tracker-embed.php`).

---

## Deployment notes

> **Deploying to Railway?** Follow [`DEPLOY.md`](./DEPLOY.md) for a click-by-click
> walkthrough (persistent volume, env vars, custom domain, WordPress embed).

This is a long-running Node process. Any of these work:

- A small VPS / container behind Nginx or Caddy for TLS (`node server.js`
  under `pm2`, `systemd`, or a Docker container).
- A platform host (Render, Railway, Fly.io, a DigitalOcean App, etc.).

Checklist for production:

- [ ] Set `STUDIO_PASSWORD` and a fixed `MT_SECRET`.
- [ ] Set `NODE_ENV=production` (hardens the auth cookie).
- [ ] Point `MT_DATA_DIR` at a **persistent** volume so `data.json` survives
      restarts/redeploys.
- [ ] Serve over HTTPS (required for the iframe cookie and for mixed-content
      rules on your HTTPS WordPress site).
- [ ] Restrict `/studio` and `/api/admin/*` to the studio (they're already
      password-gated; you can add an IP allowlist at the proxy for defense in
      depth).

---

## Automating phase updates (roadmap)

Right now the studio sets phases manually — which is the reliable v1. Here are
two automation paths, in the order I'd recommend building them.

### Option A — Asana (recommended first)

Asana is the natural source of truth because the studio already moves tasks
between stages there. Mechanism:

1. In Asana, model each **video** as a task (or a project whose sections are the
   phases). Add a custom field `Project Code` and `Video Title`, or map Asana
   task GIDs to Media Tracker video IDs once.
2. Create an Asana **webhook** pointing at a new endpoint here, e.g.
   `POST /api/hooks/asana`. Asana fires it whenever a task changes section
   ("Rough Edit" → "Fine Edit") or a custom field updates.
3. The handler maps the Asana section name → a Media Tracker phase and calls the
   same internal `updateVideo` / `addStep` logic the studio buttons use. Moving
   a card to "Client Review" in Asana would add the next numbered Client Review
   round automatically.

Pros: no editor behavior change, near-real-time, uses tools already in the
workflow. Cons: needs a one-time mapping between Asana tasks and tracker videos,
and an Asana Business plan for custom-field rules (webhooks themselves are on
all paid tiers). *(An Asana connector is already available in this workspace, so
we can prototype the mapping quickly.)*

### Option B — Final Cut Pro

Final Cut has no live status API, so automation there is event-based rather than
continuous. Practical hooks:

- **Share/Export destinations:** FCP can run a post-export shell script
  (via a custom Compressor/Automator "Share Destination" or a Keyboard
  Maestro/`fcpx`-XML watcher). Wire that script to `POST` a phase change — e.g.
  "exported a review copy" → advance to the next Client Review; "exported the
  final master" → Final Cut Delivery.
- **Roles/keywords in FCPXML:** a watched-folder script can parse exported
  FCPXML and infer phase from a keyword/role naming convention.

Pros: reflects what the editor actually did in the app. Cons: relies on the
editor exporting through the configured destination; less granular than Asana
for the review/revision loop. I'd treat FCP as a complement to Asana (auto-fire
"Final Cut Delivery" on final export), not the primary driver.

### Recommendation

Ship the manual v1 (this repo). Add the Asana webhook next for hands-off phase
changes, and optionally add the FCP final-export hook for the delivery step.
Keep the manual controls regardless — they're the override when reality doesn't
match the tool.

---

## Project layout

```
server.js              HTTP server, routing, static files, API
src/phases.js          Phase definitions + client-facing tooltip text
src/store.js           JSON-file data store (projects, videos, timeline)
src/auth.js            Studio password login (HMAC-signed cookie)
public/index.html      Client tracker (embeddable)
public/studio.html     Studio console
public/assets/         styles.css, client.js, studio.js
data/data.json         Persisted state (gitignored, auto-seeded)
```

## Security & limitations (v1)

- Single shared studio password. Fine for one studio; add per-user accounts if
  multiple editors need separate logins or an audit trail.
- Project codes are the only gate on the client side (like a Domino's order
  number). They're unguessable enough for status, but don't put anything
  confidential in a video title. Use longer/random codes if needed.
- The JSON store is single-process. For multi-instance scaling, swap
  `src/store.js` for a real database — the interface is small and isolated.
