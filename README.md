# tiktok-blast

Two small Node.js tools for TikTok creator outreach, driving a real Chrome over
CDP (Playwright):

```
discover.mjs  →  discovered-*.csv  →  screen.mjs  →  creators.csv  →  blast.mjs
   find creators by keyword/hashtag     AI picks fits   outreach list    send the DMs
```

- **`discover.mjs`** — seed a hashtag (`#reviewbuku`) or keyword, harvest the
  creators posting under it, visit each profile, and score them on followers,
  avg/median views, engagement, region, and a contact phone pulled from the bio.
  Full docs: **[DISCOVER.md](./DISCOVER.md)**.
- **`screen.mjs`** — the agentic step: screenshots each creator's recent videos,
  uses an OpenAI **vision** model to read their content's style/tone/audience and
  a **text** model to score campaign fit and decide keep/skip — then writes the
  keepers straight to `creators.csv`. Goes beyond raw stats so the pipeline runs
  discovery-to-DM with no manual review. Needs `OPENAI_API_KEY`.
- **`blast.mjs`** — read `creators.csv` and send each pending creator a templated
  DM, then drop a public comment on their **least-popular recent video** nudging
  them to check the DM (DMs from non-followers land in the hidden Requests folder,
  so they're easy to miss). The low-view video is a proxy for "few comments" so
  the nudge is actually noticeable. Screenshots and records both steps as it goes.

---

## Requirements

- **Node.js 18+** and **Google Chrome** installed.
- `npm install` to get dependencies (Playwright, csv-parse, csv-stringify).

```bash
git clone https://github.com/dafex301/tiktok-blast.git
cd tiktok-blast
npm install
```

---

## Browser setup (one-time login per machine)

Both scripts attach to a **debug Chrome** you launch — `discover.mjs` on port
**9223**, `blast.mjs` on **9222** (so they never collide). The login lives in a
local, gitignored profile (`.discover-profile`), and **is never committed**
(see [Security](#security)).

**macOS / Linux:**
```bash
./launch-browser.sh           # port 9223 for discover.mjs
./launch-browser.sh 9222      # port 9222 for blast.mjs
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File launch-browser.ps1            # port 9223
powershell -ExecutionPolicy Bypass -File launch-browser.ps1 -Port 9222 # port 9222
```

A Chrome window opens — **log into TikTok once** in it (only the first time).
Leave it open while the scripts run.

---

## Usage

### Discover creators
```bash
node discover.mjs "#reviewbuku"
node discover.mjs "#reviewbuku" "review buku" "#booktokindonesia" \
  --min-followers=5000 --max-followers=500000 --target=50 --out=discovered_buku.csv
```
Output is a CSV whose **first 9 columns match `creators.csv`**, so good rows
paste straight into the blast list. See [DISCOVER.md](./DISCOVER.md) for every
flag (follower band, target count, sampling, pacing, uniqueness/exclusion, etc.).

Runs are resumable: if one stops or crashes below `--target`, re-run the same
command (or add `--resume`) and it continues from the cache toward the target.
For a big target, pass several seeds and a follower band, e.g.:
```bash
node discover.mjs "#reviewbuku" "#booktokindonesia" "rekomendasi buku" \
  --min-followers=10000 --max-followers=100000 --target=1000
```

### Blast DMs (+ comment nudge)
```bash
npm run dry        # dry run — finds the Message button + picks a video, sends nothing
npm run blast      # DM every pending row, then comment on their least-popular video
node blast.mjs --limit=5
node blast.mjs --no-comment      # DM only (old behavior)
node blast.mjs --comment-only    # skip DMs, only post comment nudges on already-DMed rows
```

**Rate limiting** (on by default — TikTok bans bursty automation):
- **Pacing:** randomized **30–90s** between creators. Override `--delay=min,max` (e.g. `--delay=20,60`).
- **Batch pauses:** rests **8–15 min** after roughly every **10** creators, to mimic a human stepping away. Tune with `--batch-every=N` / `--batch-pause=min,max` (minutes), or `--no-batch-pause` to disable.
- **Daily cap:** **50** creators/day, **persisted across runs** in `logs/daily-state.json` (per-machine, gitignored) so multiple runs in one day don't blow past it. Override `--daily-cap=N`. Resets at local midnight.

These defaults suit a **mature** account. New/low-trust accounts should warm up first and use much lower caps + longer delays.

The DM and comment steps are tracked separately, so the run is resumable per step:
- `Status` / `SentAt` — the DM (`SENT`, `NO_DM`, `SKIPPED`, …).
- `CommentStatus` / `CommentedAt` — the comment (`COMMENTED`, `COMMENT_DISABLED`,
  `COMMENT_FAILED`). The comment only fires **after** a DM actually sends, and only
  once. Re-running blast will post comments on rows already DMed in a prior run.

The comment text rotates among a few `{greeting}`-personalized variants (e.g.
*"Kak {name}, aku tertarik buat endorse nih, cek DM ya kak 🙏"*) — edit
`COMMENT_TEMPLATES` in `blast.mjs` to change them.

---

## Running on another machine (incl. Windows)

The **code is portable; the login is not** — and must not be committed (Chrome
encrypts cookies with a per-machine key, so a copied profile just logs you out
elsewhere). On each new machine:

```bash
git clone https://github.com/dafex301/tiktok-blast.git && cd tiktok-blast
npm install
# launch debug Chrome (see Browser setup above) and log into TikTok once
node discover.mjs "#reviewbuku"
```

**Windows: run it natively, not in WSL.** The scripts connect to Chrome on
`localhost`; native Windows makes that just work. WSL2 would force you to deal
with launching a GUI Chrome inside Linux and the fact that WSL's `localhost`
doesn't point at the Windows host — extra friction for no upside. Install
Node + Chrome for Windows, use `launch-browser.ps1`, and run the same
`node discover.mjs ...` commands from PowerShell.

---

## Security

- **Never commit the browser profile or cookies.** `.gitignore` blocks
  `.discover-profile/` and `.chrome-profile/`. They hold live TikTok/Google login
  sessions — committing them is account-takeover risk, and they don't work across
  machines anyway.
- **Generated discovery output is gitignored** (`discovered*.csv`,
  `logs/discover-*.log`, the cache) — it contains scraped third-party data
  including phone numbers. Keep it out of git.
- Pace your runs (`--delay`) and don't hammer TikTok; rapid automated activity
  risks rate-limits or bans on the account you're logged in as.

---

## Files

| File | What it is |
|------|------------|
| `discover.mjs` | Creator discovery (keyword/hashtag → scored CSV) |
| `blast.mjs` | DM sender (reads/writes `creators.csv`) |
| `creators.csv` | Your outreach list + per-creator status |
| `launch-browser.sh` / `.ps1` | One-command debug-Chrome launcher (mac/Linux / Windows) |
| `DISCOVER.md` | Full discovery docs |
