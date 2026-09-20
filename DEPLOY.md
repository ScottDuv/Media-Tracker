# Deploying Media Tracker to Railway

A start-to-finish guide to running this app at `tracker.valleystrategy.co` on
Railway, with persistent file storage. Budget ~30-45 minutes the first time.

Railway auto-detects this Node app (via `package.json` → `npm start`), and
`railway.json` pins the start command, a `/health` check, and restart policy.
The app reads Railway's injected `PORT` automatically - nothing to configure
there.

---

## 0. One decision first: which branch does Railway deploy?

Railway redeploys automatically whenever the branch it watches gets a new push.
You want it watching **`main`**, so "push to main = live." The finished code is
currently on the `claude/video-editing-progress-tracker-8btdp6` branch.

- **Recommended:** merge that branch into `main` (I can open a PR and merge, or
  merge it directly), then point Railway at `main`.
- **Quick alternative:** point Railway at the feature branch for now and merge
  later. Works, but it's cleaner to deploy from `main`.

---

## 1. Create the Railway project

1. Sign in at [railway.com](https://railway.com) (GitHub login is easiest).
2. **New Project → Deploy from GitHub repo → `ScottDuv/Media-Tracker`.**
   Authorize Railway to see the repo if prompted.
3. Railway starts a first build immediately. Let it finish - it will boot, but
   we still need to add the env vars and the storage volume below before it's
   truly ready. In **Settings → Source**, confirm the deployed **branch** is the
   one you chose in step 0.

---

## 2. Add a persistent volume (so data survives redeploys)

This is the important one. Without it, every redeploy wipes your projects.

1. In the service, go to the **Variables/Settings** area and click
   **+ New Volume** (Railway may label it "Add Volume").
2. Set the **mount path** to:

   ```
   /data
   ```

3. Save. Railway attaches a small persistent disk mounted at `/data`. The app
   writes its single `data.json` there (see the `MT_DATA_DIR` variable next).

---

## 3. Set environment variables

Open the service's **Variables** tab and add these:

| Variable | Value | Notes |
|----------|-------|-------|
| `STUDIO_PASSWORD` | *(your chosen studio password)* | The login for `/studio`. Make it strong. |
| `MT_SECRET` | *(a long random string)* | Signs login cookies. Generate one - see below. |
| `MT_DATA_DIR` | `/data` | Points storage at the volume from step 2. |
| `NODE_ENV` | `production` | Hardens the auth cookie (Secure + SameSite=None). |

**Generate `MT_SECRET`** - run this locally and paste the output as the value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

(Keep `MT_SECRET` stable. If you change it later, everyone signed into `/studio`
is logged out - harmless, just re-log-in.)

After saving variables, Railway redeploys automatically.

---

## 4. Get a public URL and smoke-test

1. In **Settings → Networking**, click **Generate Domain**. Railway gives you a
   URL like `media-tracker-production.up.railway.app`.
2. Visit it:
   - `https://<your-url>/` → the client tracker (try demo code `2026728`).
   - `https://<your-url>/studio` → sign in with `STUDIO_PASSWORD`.
3. In the studio, create a real project, add a video, change its phase. Then
   trigger a redeploy (push a commit, or Railway's **Redeploy** button) and
   confirm your project is **still there** afterward. That proves the volume
   works. Delete the demo project whenever you like.

---

## 5. Point `tracker.valleystrategy.co` at it

1. In Railway **Settings → Networking → Custom Domain**, enter
   `tracker.valleystrategy.co`. Railway shows you a **CNAME target** (something
   like `abcd1234.up.railway.app`). Copy it.
2. In **WordPress.com → Upgrades → Domains → `valleystrategy.co` → DNS records**,
   add a record:
   - **Type:** `CNAME`
   - **Name/Host:** `tracker`
   - **Value/Points to:** *(the CNAME target Railway gave you)*
3. Save. DNS usually resolves within minutes (up to a couple hours). Railway
   auto-issues an HTTPS certificate once it sees the record - the custom-domain
   row turns green when it's live.

Your main `valleystrategy.co` WordPress site is untouched; only the `tracker`
subdomain routes to Railway.

---

## 6. Embed it in the WordPress page

On `valleystrategy.co/media-tracker`, add a **Custom HTML** block:

```html
<iframe
  id="media-tracker"
  src="https://tracker.valleystrategy.co/"
  title="Project Tracker"
  style="width:100%; border:0; min-height:520px;"
  loading="lazy"></iframe>

<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'media-tracker:height') {
      document.getElementById('media-tracker').style.height = e.data.height + 'px';
    }
  });
</script>
```

The code-entry box lives inside the iframe, so clients enter their code right on
your page.

---

## 7. Ongoing updates (the easy part)

Once this is set up, shipping changes is just:

```
push to main  →  Railway rebuilds  →  live in ~1-2 minutes
```

I make the change, we push, and it deploys itself. No manual steps, no
downtime beyond a few seconds' restart. Your data on the `/data` volume is
untouched by deploys.

---

## Cost expectation

Railway's Hobby plan is ~$5/month and includes usage credit; a low-traffic
always-on service like this typically stays within that. The volume is billed
by size (you need well under 1 GB). No cold starts on the paid plan, so clients
never wait for the app to wake.

## Troubleshooting

- **App won't start / crash loop:** check **Deployments → Logs**. A missing
  `MT_DATA_DIR` volume is the usual culprit - confirm the volume is mounted at
  `/data`.
- **Data disappeared after a deploy:** the volume isn't mounted, or
  `MT_DATA_DIR` isn't `/data`. Re-check steps 2 and 3.
- **Custom domain stuck "pending":** DNS hasn't propagated or the CNAME name is
  wrong (it should be exactly `tracker`, not the full domain). Give it time,
  then re-verify.
- **Studio login won't stick:** make sure `NODE_ENV=production` and you're on
  `https://` (the secure cookie requires it).
