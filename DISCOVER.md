# discover.mjs — TikTok creator discovery

Find TikTok creators by **keyword or hashtag**, score them on the metrics that
matter for outreach (followers, avg/median views, engagement, region), and
write a CSV that drops straight into the blast list.

This is the upstream half of the pipeline:

```
discover.mjs  →  discovered-*.csv  →  (review/edit)  →  creators.csv  →  blast.mjs
```

---

## How it works

1. **Harvest** — opens each seed and scrolls to collect creator handles:
   - `#hashtag` → `https://www.tiktok.com/tag/<tag>`
   - free text → `https://www.tiktok.com/search?q=<keyword>`
   - a full URL → used as-is

   It pulls every `@username` out of the video links on the page, deduping
   across all seeds. It stops scrolling a seed early once two passes in a row
   surface no new creators.

2. **Enrich** — visits each creator's profile and reads:
   display name, followers, following, total likes, bio, and the view counts of
   recent videos. From the recent-video views it computes **average** and
   **median** views, and an **engagement ratio** (`median views ÷ followers`).

3. **Filter + rank** — keeps creators inside your follower band, sorts by a
   **score** (`reach × engagement`, engagement capped so a tiny viral account
   can't dominate), flags a **region hint** from the bio/name
   (🇮🇩 or "Jakarta/indo" → `ID`; foreign flags or city names → `non-ID?`),
   and pulls a **contact phone** out of the bio if one is there (see below).

### Uniqueness

Results are deduped two ways so the creators you get are genuinely new:

- **Within a run** — the same handle is only harvested/visited once, even if it
  shows up under multiple seeds or many times in one feed.
- **Against people you already have** — before enriching, it drops any handle
  already present in `creators.csv` (matched on the `@handle` in the `Link`
  column). So it never re-surfaces someone you've already contacted. Point it at
  a different file with `--exclude=path`, or turn it off with `--no-exclude`.

### Getting *X* accounts

`--target=X` makes the run keep enriching until **X qualifying** creators are
kept (then it stops). If the seeds don't yield X new candidates, it keeps what
it found and logs a note — add more seeds or raise `--scrolls` to go deeper.

### Contact phone extraction

Creators often put a "CP" / WhatsApp number in their bio. The script extracts
Indonesian mobiles in the common formats — `0812-3456-7890`, `+62 857 1234 5678`,
`(+62) 81287688118`, `wa.me/6281234567890` — normalizes them to `+62…`, and puts
them in the **`ContactPerson`** column (comma-separated if there's more than one).
Bios without a number leave the column blank.

---

## Setup (one time)

The script drives a **debug Chrome** over CDP — the same approach as `blast.mjs`,
but on **port 9223** (blast uses 9222, so they never collide).

**Easiest:** use the launch helper, which opens Chrome on a local, gitignored
profile and waits for it to come up:

```bash
./launch-browser.sh        # log into TikTok once in the window (first time only)
```

Leave that window open while the script runs.

> On this machine there's also a slim pre-logged-in profile at
> `~/chrome-debug-fahrelga` if you'd rather use it:
> ```bash
> open -na "Google Chrome" --args --remote-debugging-port=9223 \
>   --user-data-dir="$HOME/chrome-debug-fahrelga" --profile-directory=Default \
>   --no-first-run --no-default-browser-check
> ```
> Either way, if the window isn't logged into TikTok, log in once — the session
> persists in that profile dir.

> Override the endpoint with `CDP_URL=http://localhost:PORT` if you want to
> point at a different debug Chrome.

### Running on another machine

The code is portable; the **login is not** (and must not be committed). Chrome's
cookies are encrypted with a per-machine key in the OS keychain, so copying a
profile across machines just logs you out — and pushing login cookies to git is
a security risk. So on each new machine you log in once:

```bash
git clone <this repo> && cd tiktok-blast
npm install
npx playwright install chromium   # if Playwright's browser isn't present
./launch-browser.sh               # opens Chrome on a local, gitignored profile
# -> log into TikTok once in that window (only needed the first time)
node discover.mjs "#reviewbuku"
```

`launch-browser.sh` uses `./.discover-profile` (gitignored), so each machine
keeps its own session and nothing sensitive is ever committed. The login
persists in that folder, so subsequent runs just need the browser open — no
re-login. On Windows, the script prints the equivalent PowerShell command.

---

## Usage

```bash
# simplest: one hashtag, defaults for everything
node discover.mjs "#reviewbuku"

# several seeds (hashtags + free text), with a follower band and a target count
node discover.mjs "#reviewbuku" "review buku" "rekomendasi buku" \
  --min-followers=5000 --max-followers=500000 --target=60

# tune harvest depth, sampling, pacing, and output name
node discover.mjs "#reviewbuku" --scrolls=12 --sample=12 --delay=2,6 --out=discovered_buku.csv
```

### Flags

All optional; every one has a sensible default.

| Flag | Default | What it does |
|------|---------|--------------|
| `--min-followers=N` | `1000` | Keep only creators with **≥ N** followers |
| `--max-followers=N` | none (∞) | Keep only creators with **≤ N** followers |
| `--target=N` | `50` | Stop after keeping **N** qualifying creators |
| `--max-visits=N` | `target × 4` | Hard cap on profiles visited (safety stop) |
| `--scrolls=N` | `8` | Scroll passes per seed during harvest |
| `--sample=N` | `12` | How many recent videos to average for views |
| `--delay=min,max` | `2,6` | Seconds (random) between profile visits — be polite |
| `--out=path` | `discovered-<stamp>.csv` | Output CSV path |
| `--exclude=path` | `./creators.csv` | Skip handles already in this CSV (uniqueness) |
| `--no-exclude` | off | Don't exclude anyone — discover even known creators |

Seeds are any non-`--` arguments. A leading `#` makes it a hashtag; anything
else is treated as a search keyword (or a URL if it starts with `http`).

---

## Output

### `discovered-<timestamp>.csv` (or your `--out` path)

Written to the project root. **The first 9 columns match `creators.csv`**, so
qualifying rows paste straight into the blast list. Extra metric columns follow.

| Column | Notes |
|--------|-------|
| `No` | Row number (sorted best-first by `Score`) |
| `Name` | Display name |
| `Greeting` | First name guessed from the display name (used by `blast.mjs`) |
| `Platform` | Always `TikTok` |
| `Followers` | Numeric (e.g. `37700`) |
| `Notes` | **Left blank** for your own annotations — metrics live in their own columns |
| `Link` | `https://www.tiktok.com/@username` |
| `Status` | **Blank = ready to blast.** Otherwise `PRIVATE` / `NOT_FOUND` / `NO_DATA` / `ERROR` |
| `SentAt` | Empty (filled in later by `blast.mjs`) |
| `ContactPerson` | Phone number(s) pulled from the bio, normalized to `+62…` (blank if none) |
| `Username` | TikTok handle |
| `Following` | Numeric |
| `Likes` | Total likes on the account |
| `AvgViews` | Mean of sampled recent-video views |
| `MedianViews` | Median of sampled views (more robust than mean) |
| `Engagement` | `MedianViews ÷ Followers` (e.g. `0.237` = 23.7%) |
| `RegionHint` | `ID`, `ID?`, `non-ID?`, a country code, or blank |
| `Score` | Ranking score: reach × engagement (capped) |
| `Bio` | Profile bio (flattened to one line) |

> Filtering only uses the follower band. Region is a **hint, not a filter** —
> nothing is auto-dropped for region, so eyeball `RegionHint`/`Bio` before
> sending if you only want Indonesian creators.

### `logs/discover-<timestamp>.log`

Full run log: every harvest scroll, profile visit, and keep/skip decision.

### `logs/discover-cache.json`

Resumable cache — one enriched record per username, saved **after every profile
visit**. Re-running reuses these, so you never re-scrape a profile you've already
seen. Delete this file to force a fresh scrape.

---

## Promoting to the blast list

1. Open the output CSV, sort/skim by `Score`, `Engagement`, `RegionHint`.
2. Delete rows you don't want; tidy `Greeting` if needed.
3. Copy the first 9 columns of the keepers into `creators.csv`.
4. Run `blast.mjs` as usual (it reads/writes only those 9 columns).

---

## Tips & gotchas

- **Some profiles return no views.** Photo-only or very sparse accounts have no
  per-video view counts; they get `Score 0` and sort to the bottom. That's
  expected, not a bug.
- **Tiny accounts can top the ranking** when a video goes viral (high
  engagement ratio). The score caps the engagement multiplier so they don't
  completely dominate, but check follower counts before deciding.
- **Go slow on big runs.** Keep `--delay` at the default or higher and avoid
  huge `--target` values in one sitting — rapid profile hits look bot-like.
- **Cleanup.** When you're done with all of this, reclaim disk with
  `rm -rf ~/chrome-debug-fahrelga` (62 MB) — and the old
  `~/chrome-debug-tunelab` (~4.8 GB) if you no longer need the blast profile.
```

