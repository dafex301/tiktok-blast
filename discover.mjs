import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { stringify } from "csv-stringify/sync";
import { parse } from "csv-parse/sync";
import { chromium } from "playwright";

// ============================================================================
// discover.mjs — keyword/hashtag-driven TikTok creator discovery
//
// Seeds from a hashtag (#reviewbuku) or a free-text keyword ("review buku"),
// harvests the creators posting under it, visits each profile, and scores them
// on followers / avg views / engagement / region. Output is a CSV whose first
// 9 columns match creators.csv, so good rows can be pasted straight into the
// blast list. Resumable: enriched profiles are cached to disk per run-set.
//
// Drives Chrome over CDP, same as blast.mjs. Default port 9223 (the slim
// fahrelga debug profile). Launch that Chrome first:
//
//   open -na "Google Chrome" --args --remote-debugging-port=9223 \
//     --user-data-dir="$HOME/chrome-debug-fahrelga" --profile-directory=Default \
//     --no-first-run --no-default-browser-check
//
// Usage:
//   node discover.mjs "#reviewbuku"
//   node discover.mjs "#reviewbuku" "review buku" "rekomendasi buku" --min-followers=5000 --max-followers=500000 --target=60
//   node discover.mjs "#reviewbuku" --scrolls=12 --sample=12 --delay=2,6 --out=discovered_buku.csv
//
// Flags (all optional, all have defaults):
//   --min-followers=N   keep only creators with >= N followers   (default 1000)
//   --max-followers=N   keep only creators with <= N followers   (default none)
//   --target=N          stop after enriching N qualifying creators(default 50)
//   --max-visits=N      hard cap on profiles visited             (default target*4)
//   --scrolls=N         scroll passes per seed when harvesting    (default 8)
//   --sample=N          # of recent videos to average for views   (default 12)
//   --delay=min,max     seconds between profile visits            (default 2,6)
//   --out=path          output CSV path        (default discovered-<stamp>.csv)
// ============================================================================

const LOG_DIR = "./logs";
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_LOG = `${LOG_DIR}/discover-${RUN_STAMP}.log`;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(RUN_LOG, line + "\n"); } catch {}
}

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const seeds = argv.filter((a) => !a.startsWith("--"));
if (seeds.length === 0) {
  console.error('Give at least one seed, e.g.  node discover.mjs "#reviewbuku" "review buku"');
  process.exit(1);
}
const MIN_FOLLOWERS = parseInt(flag("min-followers", "1000"), 10);
const MAX_FOLLOWERS = flag("max-followers", "") ? parseInt(flag("max-followers"), 10) : Infinity;
const TARGET = parseInt(flag("target", "50"), 10);
const MAX_VISITS = parseInt(flag("max-visits", String(TARGET * 4)), 10);
const SCROLLS = parseInt(flag("scrolls", "8"), 10);
const SAMPLE = parseInt(flag("sample", "12"), 10);
const OUT = flag("out", `discovered-${RUN_STAMP}.csv`);
const OUT_EXPLICIT = argv.some((a) => a.startsWith("--out="));
const RESUME = argv.includes("--resume"); // skip harvest, drain saved candidate queue
const EXCLUDE_PATH = flag("exclude", "./creators.csv"); // skip creators already here
const NO_EXCLUDE = argv.includes("--no-exclude");
const CACHE = `${LOG_DIR}/discover-cache.json`; // username -> enriched record (resumable)
// only these statuses are final — ERROR/transient are left uncached so a re-run
// (or --resume) retries them instead of skipping forever.
const TERMINAL = new Set(["OK", "PRIVATE", "NOT_FOUND", "NO_DATA"]);
const CDP_URL = process.env.CDP_URL || "http://localhost:9223";
let [DELAY_MIN, DELAY_MAX] = (flag("delay", "2,6")).split(",").map(Number);
if (Number.isNaN(DELAY_MAX)) DELAY_MAX = DELAY_MIN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// --- helpers ----------------------------------------------------------------
// "37.7K" -> 37700, "2.4M" -> 2400000, "1.1B" -> 1.1e9, "613" -> 613
function parseCount(s) {
  if (s == null) return null;
  const m = String(s).trim().replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
  return Math.round(n * mult);
}
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}
function mean(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  return a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : null;
}

// Region/language hint from bio + display name. Indonesian is the target; flag
// anything that looks like it's from elsewhere so you can eyeball before DMing.
const FLAGS = {
  "🇮🇩": "ID", "🇲🇾": "MY", "🇸🇬": "SG", "🇵🇭": "PH", "🇹🇭": "TH",
  "🇻🇳": "VN", "🇮🇳": "IN", "🇺🇸": "US", "🇬🇧": "GB", "🇲🇨": "MC",
  "🇧🇳": "BN", "🇰🇷": "KR", "🇯🇵": "JP", "🇨🇳": "CN", "🇦🇺": "AU",
};
const ID_WORDS = /\b(indo|indonesia|jakarta|bandung|surabaya|yogyakarta|jogja|medan|bekasi|depok|tangerang|wib)\b/i;
const NON_ID_HINT = /\b(malaysia|kuala lumpur|singapore|manila|philippines|bangkok|thai|vietnam|hanoi)\b/i;
function regionHint(text) {
  text = text || "";
  const flags = [...new Set([...text].map((c) => FLAGS[c]).filter(Boolean))];
  if (flags.length) return flags.includes("ID") ? "ID" : flags.join("/");
  if (ID_WORDS.test(text)) return "ID?";
  if (NON_ID_HINT.test(text)) return "non-ID?";
  return ""; // unknown
}

// Pull a contact phone number out of a bio. Creators often drop a "CP" / WA
// number like "+62 812-3456-7890", "0812 3456 7890", or a wa.me link. We grab
// candidates, normalize to +62 international form, and keep only valid
// Indonesian mobiles (which start +628…). Returns "" if none, comma-joins multi.
function extractContact(text) {
  if (!text) return "";
  const cands = new Set();
  // wa.me / whatsapp / "phone=" links
  for (const m of text.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\S*?phone=|whatsapp[^\d+]{0,8})(\+?\d[\d\s().-]{7,16})/gi))
    cands.add(m[1]);
  // bare numbers: +62… / 62… / 08… — allow a short gap after the prefix so
  // "(+62) 812…", "+62 857…", "62-812…", "0812…" all match.
  for (const m of text.matchAll(/(?:\+?62|0)[\s().-]{0,4}8[\d\s().-]{7,14}\d/g))
    cands.add(m[0]);
  const out = [];
  for (const raw of cands) {
    let d = raw.replace(/[^\d]/g, "");      // digits only
    if (d.startsWith("0")) d = "62" + d.slice(1); // 08xx → 628xx
    else if (d.startsWith("8")) d = "62" + d;      // 8xx  → 628xx
    if (/^628\d{7,12}$/.test(d)) out.push("+" + d);
  }
  return [...new Set(out)].join(", ");
}

// --- CDP session (attach to debug Chrome; never kills your real browser) -----
async function getSession() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error(`\nCould not reach Chrome at ${CDP_URL}. Launch the debug profile first:\n`);
    console.error(`  open -na "Google Chrome" --args --remote-debugging-port=9223 \\`);
    console.error(`    --user-data-dir="$HOME/chrome-debug-fahrelga" --profile-directory=Default \\`);
    console.error(`    --no-first-run --no-default-browser-check\n`);
    process.exit(1);
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  return { browser, ctx, page, cleanup: async () => { await browser.close(); } };
}

// Repair a dead session in place: reconnect if the CDP browser dropped, or open
// a fresh tab if our page crashed. Mirrors blast.mjs so a mid-run Chrome hiccup
// doesn't kill the whole sweep.
async function ensureHealthy(session) {
  try {
    if (!session.browser.isConnected()) {
      log(`    -> browser disconnected; reconnecting over CDP`);
      Object.assign(session, await getSession());
    } else if (session.page.isClosed()) {
      log(`    -> tab was closed; opening a fresh one`);
      session.page = await session.ctx.newPage();
    }
  } catch (e) {
    log(`    -> repair failed (${e.message.split("\n")[0]}); reconnecting`);
    Object.assign(session, await getSession());
  }
}

function seedUrl(seed) {
  const s = seed.trim();
  if (s.startsWith("#")) return `https://www.tiktok.com/tag/${encodeURIComponent(s.slice(1))}`;
  if (/^https?:\/\//.test(s)) return s;
  return `https://www.tiktok.com/search?q=${encodeURIComponent(s)}`;
}

// Phase 1: scroll a seed page and collect unique @usernames from video links.
async function harvest(page, seed) {
  const url = seedUrl(seed);
  log(`harvest "${seed}" -> ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(jitter(3000, 4500));
  const found = new Set();
  let stagnant = 0;
  for (let i = 0; i <= SCROLLS; i++) {
    const users = await page.evaluate(() => {
      const hrefs = [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.getAttribute("href") || "");
      return [...new Set(hrefs.map((h) => (h.match(/@([^/?]+)\//) || [])[1]).filter(Boolean))];
    });
    const before = found.size;
    users.forEach((u) => found.add(u));
    log(`    scroll ${i}/${SCROLLS}: ${found.size} unique creators so far`);
    if (found.size === before) stagnant++; else stagnant = 0;
    if (stagnant >= 2) { log(`    no new creators after 2 scrolls — stopping harvest`); break; }
    // Real in-page scroll — page.mouse.wheel fires at (0,0) and never triggers
    // TikTok's infinite scroll. Jump to the bottom to load the next batch.
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await sleep(jitter(1400, 2600));
  }
  // drop our own debug account / numeric-id artifacts
  return [...found].filter((u) => u && !/^\d+$/.test(u) && !/^MS4w/.test(u));
}

// Phase 2: visit one profile and pull stats. Returns null on private/blocked/404.
async function enrich(page, username) {
  const link = `https://www.tiktok.com/@${username}`;
  await page.goto(link, { waitUntil: "domcontentloaded" });
  // header (follower counts) mounts fast; the video grid + per-video view
  // counts lazy-render, so wait for a post item then nudge-scroll to trigger it.
  await page.waitForSelector('[data-e2e="followers-count"]', { timeout: 9000 }).catch(() => {});
  await page.waitForSelector('[data-e2e="user-post-item"]', { timeout: 6000 }).catch(() => {});
  await page.evaluate(() => window.scrollBy(0, 1000)); // trigger lazy view counts
  await sleep(jitter(1200, 2000));
  const raw = await page.evaluate((sample) => {
    const t = (s) => document.querySelector(s)?.textContent ?? null;
    const views = [...document.querySelectorAll('[data-e2e="user-post-item"]')]
      .slice(0, sample)
      .map((v) => v.querySelector('[data-e2e="video-views"]')?.textContent
        || v.querySelector("strong")?.textContent || null)
      .filter(Boolean);
    return {
      handle: t('[data-e2e="user-subtitle"]'),
      name: t('[data-e2e="user-title"]'),
      following: t('[data-e2e="following-count"]'),
      followers: t('[data-e2e="followers-count"]'),
      likes: t('[data-e2e="likes-count"]'),
      bio: t('[data-e2e="user-bio"]'),
      private: !!document.querySelector('[data-e2e="user-page-private"], [data-e2e="private-account"]'),
      notFound: /Couldn.t find this account|page isn.t available/i.test(document.body.innerText.slice(0, 2000)),
      viewsRaw: views,
    };
  }, SAMPLE);

  if (raw.notFound) return { username, link, status: "NOT_FOUND" };
  const followers = parseCount(raw.followers);
  if (followers == null && !raw.private) return { username, link, status: "NO_DATA" };

  const viewNums = raw.viewsRaw.map(parseCount).filter(Number.isFinite);
  const avgViews = mean(viewNums);
  const medViews = median(viewNums);
  // engagement proxy: median views relative to follower base
  const engagement = followers && medViews != null ? +(medViews / followers).toFixed(3) : null;
  // score: reach (median views) tempered by an engagement multiplier (capped)
  const score = medViews != null
    ? Math.round(medViews * Math.min(Math.max(engagement ?? 0.3, 0.1), 2))
    : 0;

  return {
    username,
    link,
    status: raw.private ? "PRIVATE" : "OK",
    name: (raw.name || username).trim(),
    followers,
    following: parseCount(raw.following),
    likes: parseCount(raw.likes),
    avgViews,
    medViews,
    engagement,
    score,
    region: regionHint(`${raw.name || ""} ${raw.bio || ""}`),
    contact: extractContact(`${raw.name || ""} ${raw.bio || ""}`),
    bio: (raw.bio || "").replace(/\s+/g, " ").trim(),
    sampleN: viewNums.length,
  };
}

// --- cache (resumable across runs) ------------------------------------------
function loadCache() {
  if (!existsSync(CACHE)) return {};
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function saveCache(c) { writeFileSync(CACHE, JSON.stringify(c, null, 2)); }

// --- campaign state (the candidate queue + output path, per seed set) --------
// Lets you stop/crash and resume toward the target without re-harvesting, and
// keeps re-runs of the same seeds writing to the same CSV.
function stateKey() {
  const k = seeds.map((s) => s.trim().toLowerCase()).sort().join("|")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return k || "default";
}
const STATE = `${LOG_DIR}/discover-state-${stateKey()}.json`;
function loadState() {
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; }
}
function saveState(s) { writeFileSync(STATE, JSON.stringify(s, null, 2)); }

// Usernames to skip so results are unique vs. people you already have/contacted.
// Reads the @handle out of each Link (or the Username column) in creators.csv.
function loadExcluded() {
  if (NO_EXCLUDE || !existsSync(EXCLUDE_PATH)) return new Set();
  try {
    const rows = parse(readFileSync(EXCLUDE_PATH, "utf8"), { columns: true, skip_empty_lines: true });
    const set = new Set();
    for (const r of rows) {
      const h = ((r.Link || "").match(/@([^/?]+)/) || [])[1] || (r.Username || "");
      if (h) set.add(h.trim().toLowerCase());
    }
    return set;
  } catch { return new Set(); }
}

function greetingFor(name, username) {
  const first = (name || "").trim().split(/[\s|·•\-—]+/)[0].replace(/[^\p{L}\p{N}]/gu, "");
  return first && first.length >= 2 ? first : username;
}

// Write blast-compatible CSV (first 9 cols == creators.csv) + metric columns.
function writeOut(records, outPath) {
  const header = [
    "No", "Name", "Greeting", "Platform", "Followers", "Notes", "Link", "Status", "SentAt",
    "ContactPerson", "Username", "Following", "Likes", "AvgViews", "MedianViews", "Engagement", "RegionHint", "Score", "Bio",
  ];
  const rows = records.map((r, i) => ({
    No: i + 1,
    Name: r.name || r.username,
    Greeting: greetingFor(r.name, r.username),
    Platform: "TikTok",
    Followers: r.followers ?? "",
    Notes: "", // left blank for your own annotations — metrics live in their own columns
    Link: r.link,
    Status: r.status === "OK" ? "" : r.status, // blank = ready for blast
    SentAt: "",
    ContactPerson: r.contact || "",
    Username: r.username,
    Following: r.following ?? "",
    Likes: r.likes ?? "",
    AvgViews: r.avgViews ?? "",
    MedianViews: r.medViews ?? "",
    Engagement: r.engagement ?? "",
    RegionHint: r.region,
    Score: r.score,
    Bio: r.bio || "",
  }));
  writeFileSync(outPath, stringify(rows, { header: true, columns: header }));
}

async function main() {
  log(`run log: ${RUN_LOG}`);
  log(`seeds: ${seeds.join(" | ")}`);
  log(`filters: followers ${MIN_FOLLOWERS}..${MAX_FOLLOWERS === Infinity ? "∞" : MAX_FOLLOWERS}, target ${TARGET}, maxVisits ${MAX_VISITS}, sample ${SAMPLE}`);

  const session = await getSession();
  log(`session ready (CDP @ ${CDP_URL})`);

  // Resume context: reuse the same output file + candidate queue across runs of
  // the same seed set, so a stop/crash can be continued toward the target.
  const prior = loadState();
  const outPath = OUT_EXPLICIT ? OUT : (prior?.out || OUT);
  const candidates = new Set(prior?.candidates || []);

  // Phase 1: harvest unique usernames across all seeds (skipped on --resume).
  if (RESUME) {
    if (!candidates.size) { log(`--resume but no saved candidates for these seeds (${STATE}) — run once without --resume first.`); }
    log(`resume: skipping harvest, ${candidates.size} candidates from prior run`);
  } else {
    for (const seed of seeds) {
      try {
        await ensureHealthy(session);
        (await harvest(session.page, seed)).forEach((u) => candidates.add(u));
      } catch (e) {
        log(`    harvest error on "${seed}": ${e.message.split("\n")[0]}`);
      }
      await sleep(jitter(DELAY_MIN * 1000, DELAY_MAX * 1000));
    }
  }
  saveState({ seeds, out: outPath, candidates: [...candidates], updatedAt: RUN_STAMP });

  // Uniqueness: drop anyone already in creators.csv (already contacted/owned).
  const excluded = loadExcluded();
  const list = [...candidates].filter((u) => !excluded.has(u.toLowerCase()));
  log(`${candidates.size} unique candidates; ${candidates.size - list.length} already known → ${list.length} to consider`
    + (excluded.size ? ` (excluding ${excluded.size} from ${EXCLUDE_PATH})` : ""));
  if (list.length < TARGET) {
    log(`note: only ${list.length} candidates < target ${TARGET} — add more seeds or raise --scrolls to reach ${TARGET}`);
  }

  // Phase 2: enrich each (cached results reused; retries + session repair on
  // transient errors; ERROR is NOT cached so a re-run picks it up again).
  const cache = loadCache();
  const kept = [];
  let visits = 0;
  for (const username of list) {
    if (kept.length >= TARGET) { log(`reached target (${TARGET}) — stopping`); break; }
    if (visits >= MAX_VISITS) { log(`hit max-visits (${MAX_VISITS}) — stopping`); break; }

    let rec = cache[username];
    if (rec && rec._v === 1) {
      log(`  cached: @${username}`);
    } else {
      visits++;
      log(`[visit ${visits}] @${username}`);
      for (let tries = 1; tries <= 2; tries++) {
        try {
          await ensureHealthy(session);
          rec = await enrich(session.page, username);
          break;
        } catch (e) {
          const msg = e.message.split("\n")[0];
          log(`    -> error: ${msg}`);
          if (tries === 1 && /closed|disconnect|crash|Target|Navigation|timeout|detached/i.test(e.message)) {
            log(`    -> repairing session and retrying @${username}`);
            await ensureHealthy(session);
            await sleep(jitter(1500, 3000));
            continue;
          }
          rec = { username, link: `https://www.tiktok.com/@${username}`, status: "ERROR", note: msg };
        }
      }
      if (TERMINAL.has(rec.status)) { rec._v = 1; cache[username] = rec; saveCache(cache); }
      await sleep(jitter(DELAY_MIN * 1000, DELAY_MAX * 1000));
    }

    // filter
    const ok = rec.status === "OK"
      && rec.followers != null
      && rec.followers >= MIN_FOLLOWERS
      && rec.followers <= MAX_FOLLOWERS;
    if (ok) {
      kept.push(rec);
      log(`    -> KEEP (${rec.followers} followers, med ${rec.medViews ?? "?"} views, eng ${rec.engagement ?? "?"}, region ${rec.region || "?"})  [${kept.length}/${TARGET}]`);
    } else {
      log(`    -> skip (${rec.status}${rec.followers != null ? `, ${rec.followers} followers` : ""})`);
    }
  }

  // Phase 3: rank by score (reach × engagement), write output.
  kept.sort((a, b) => (b.score || 0) - (a.score || 0));
  writeOut(kept, outPath);
  log(`done. kept ${kept.length}/${TARGET} creators -> ${outPath}`);
  if (kept.length < TARGET) {
    log(`below target — re-run the same command (or add 'node discover.mjs ${seeds.map((s) => `"${s}"`).join(" ")} --resume') to continue; cached profiles are reused.`);
  }
  log(`(first 9 columns match creators.csv — paste good rows straight into the blast list)`);
  await session.cleanup();
}

main().catch((e) => { log(`FATAL: ${e.message}`); log(`progress is saved — re-run to continue (cached profiles are reused).`); process.exit(1); });
