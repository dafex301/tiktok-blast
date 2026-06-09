# HANDOFF — continuing on another machine

> Context bridge for a fresh Claude Code session on a different PC.
> **New session: read this file + `git log --oneline -5`, then help run the comment batch.**

## TL;DR
- Project: **tiktok-blast** — TikTok creator outreach. Pipeline: `discover.mjs → screen.mjs → creators.csv → blast.mjs`.
- This session upgraded **`blast.mjs`** so that, after sending a DM, it also posts a **public comment** on the creator's **least-popular recent video** nudging them to check the DM (DMs from non-followers land in the hidden Requests folder).
- **Verified working** on macOS from the `nada.tunelab` account. Latest commit pushed: **`9f5814e`**.
- Repo: `https://github.com/dafex301/tiktok-blast.git`

## What changed this session
- `504f968` — added the comment step (rotating, `{greeting}`-personalized templates; separate `CommentStatus`/`CommentedAt` columns so it's independently resumable; flags `--no-comment`, `--comment-only`).
- `9f5814e` — **fix**: the comment step wasn't actually posting. Root causes + fixes:
  - Open the collapsed comment panel via the **button with accessible name `/add comments/`** (NOT `[data-e2e="comment-icon"]` — the raw svg isn't clickable and the click hung 30s).
  - The Draft.js editor is **overlapped by the video player**, so a normal `.click()` stalls on Playwright's obscured-element check → use **`click({ force: true })` then `keyboard.type`** (Draft.js ignores programmatic value-setting).
  - The Post button `[data-e2e="comment-post"]` starts `disabled=""` until text is present.
- Confirmed end-to-end: one real comment landed at the top of `@keylazzahra`'s lowest-view video, from `Nada by TuneLab`.

## Setup on the new PC (one-time)
Prereqs: **Node 18+** and **Google Chrome**.

```bash
git clone https://github.com/dafex301/tiktok-blast.git   # or: git pull
cd tiktok-blast
npm install
npx playwright install chromium     # if the Playwright browser isn't present
```

**Launch the debug Chrome on port 9222 (blast's default CDP port) and log in:**
```bash
# macOS / Linux
./launch-browser.sh 9222
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File launch-browser.ps1 -Port 9222
```
In the window that opens, **log into TikTok as `Nada by TuneLab` (handle `nada.tunelab`)**.
⚠️ The login does **NOT** transfer from the other machine — Chrome encrypts cookies with a per-machine key. You must log in once here, by hand.

**Confirm the right account is logged in:**
```bash
node check-login.mjs        # expect: { "handle": "nada.tunelab", "loggedIn": true }
```

## Running
```bash
npm run dry                              # dry run — picks a video, posts nothing
node blast.mjs --comment-only --limit=1  # one real comment (do this first to sanity-check)
node blast.mjs --limit=5                 # DM + comment, small batch
npm run blast                            # full run over all pending rows
```
Flags: `--no-comment` (DM only), `--comment-only` (skip DM), `--limit=N`, `--delay=min,max`.
Port override: `CDP_URL=http://localhost:9224 node blast.mjs ...` (or launch on a different port).

## Current campaign state (`creators.csv`)
- 35 rows. **DMs: all `SENT`.** Comments: `Keyla = COMMENTED` (the test), the other **34 are blank**.
- `node blast.mjs --comment-only` will comment on those 34 SENT-but-not-yet-commented rows.
- ⚠️ **Run on ONE machine at a time.** `creators.csv` is the source of truth and is updated after every row. After a run, **commit `creators.csv` back and push** so the other machine stays in sync — otherwise the two copies diverge and creators get double-touched.

## Open decisions / cautions
- **No daily cap in the script.** Commenting from a fresh account on ~30 profiles back-to-back (right after DMing) is a spam-flag risk. Recommend small batches (`--limit=5`) with longer `--delay` (e.g. `--delay=8,20`). *(Not yet implemented — ask if you want a hard daily cap added.)*
- **Account match matters:** the comment must come from the same account that sent the DMs (`nada.tunelab`). A nudge from a different account points at a DM the creator can't find.
- `blast.mjs:32` hardcodes the **macOS** Chrome path — only used by `--fresh` mode. On Windows/Linux, don't use `--fresh` without editing that line; the default CDP flow is fine everywhere.

## Key selectors (so you don't re-derive them)
- Open panel: `getByRole("button", { name: /add comments/i })`
- Editor: `[data-e2e="comment-input"] div[contenteditable="true"]` (a.k.a. `.public-DraftEditor-content`) — Draft.js, force-click + keyboard.type.
- Post: `[data-e2e="comment-post"]:not([disabled])`
- Comment count: `[data-e2e="comment-count"]`; grid view count: `[data-e2e="video-views"]`.
- Video pick: lowest view count (proxy for fewest comments) among the first 15 grid videos; tries up to 3 candidates.
