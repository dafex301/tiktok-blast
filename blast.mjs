import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { chromium } from "playwright";

const CSV_PATH = "./creators.csv";
const PROFILE_DIR = "./.chrome-profile"; // persistent login lives here
const LOG_DIR = "./logs";

// --- logger: timestamped lines to console + logs/run-<stamp>.log -------------
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_LOG = `${LOG_DIR}/run-${RUN_STAMP}.log`;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(RUN_LOG, line + "\n"); } catch {}
}

// --- message template -------------------------------------------------------
// {greeting} is replaced per row (the Greeting column in creators.csv).
const TEMPLATE = `Halo Kak {greeting}, salam kenal. Kami dari tim Nada. Kami perhatikan konten-konten musik di akun Kakak punya karakter yang menarik. Kebetulan saat ini kami sedang mempersiapkan promosi untuk Nada, sebuah aplikasi untuk bikin musik atau compose lagu hanya lewat humming (senandung). Melihat profil Kakak, kami merasa karakter konten dan audiens Kakak sangat cocok dengan aplikasi ini, dan kami tertarik untuk mengajak Kakak berkolaborasi. Jika berkenan, boleh kami minta informasi rate card terbarunya untuk slot TikTok Collab? Terima kasih banyak sebelumnya.`;

// --- comment templates ------------------------------------------------------
// Posted as a public comment on the creator's latest video to nudge them to
// check the DM (which lands in the hidden "Requests" folder when we don't
// follow them). Rotated at random to look less bot-like; {greeting} = name.
const COMMENT_TEMPLATES = [
  "Kak {greeting}, aku tertarik buat endorse nih, cek DM ya kak 🙏",
  "Halo Kak {greeting}, ada penawaran kolaborasi buat Kakak, cek DM ya 🙌",
  "Kak {greeting} cek DM dong, ada tawaran endorse buat Kakak ✨",
  "Hai Kak {greeting}, kami tertarik endorse, udah kirim DM ya, cek inbox 😊",
  "Kak {greeting}, tertarik kolab/endorse nih, cek DM ya kak 🙏",
];
function pickComment(greeting) {
  const t = COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
  return t.replace("{greeting}", greeting);
}

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FRESH = args.includes("--fresh"); // use isolated profile + login instead of CDP
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";

// Commenting upgrade: after a DM is sent, also drop a public comment on the
// creator's LEAST-popular recent video, nudging them to check the DM (DMs from
// non-followers land in the hidden Requests folder so they're easy to miss).
// We pick the lowest-view recent video as a proxy for "few comments" so our
// comment is actually noticeable instead of buried under a viral video.
const NO_COMMENT = args.includes("--no-comment");     // DM only (old behavior)
const COMMENT_ONLY = args.includes("--comment-only"); // skip DM, only comment
const DO_COMMENT = !NO_COMMENT;
const COMMENT_VIDEO_TRIES = 3; // least-popular videos to try before giving up
// When a captcha appears, pause and let the human running this solve it by hand,
// then continue. Only halt the run if it's still unsolved past this window.
const CAPTCHA_WAIT_S = Number((args.find((a) => a.startsWith("--captcha-wait=")) || "").split("=")[1]) || 240;

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TUNELAB_PROFILE = "Profile 16"; // tunelabid@gmail.com

// Gap between creators, in seconds. Override: --delay=min,max (e.g. --delay=20,60).
// Randomized (never a fixed interval — a fixed sleep is itself a bot signal).
// Default 30-90s to mimic natural spacing.
const delayArg = args.find((a) => a.startsWith("--delay="));
let [DELAY_MIN, DELAY_MAX] = [30, 90];
if (delayArg) {
  const p = delayArg.split("=")[1].split(",").map(Number);
  DELAY_MIN = p[0];
  DELAY_MAX = p[1] ?? p[0];
}

// Daily cap on creators acted on, PERSISTED across runs (logs/daily-state.json)
// so several runs in one day don't blow past it. Override: --daily-cap=N.
const dailyCapArg = args.find((a) => a.startsWith("--daily-cap="));
const DAILY_CAP = dailyCapArg ? parseInt(dailyCapArg.split("=")[1], 10) : 50;

// Batch pauses: after roughly every BATCH_EVERY creators, rest a randomized
// number of minutes to mimic a human stepping away. Override: --batch-pause=min,max
// (minutes), or --no-batch-pause to disable. Set --batch-every=N to change cadence.
const NO_BATCH_PAUSE = args.includes("--no-batch-pause");
const batchEveryArg = args.find((a) => a.startsWith("--batch-every="));
const BATCH_EVERY = batchEveryArg ? parseInt(batchEveryArg.split("=")[1], 10) : 10;
let [BATCH_PAUSE_MIN, BATCH_PAUSE_MAX] = [8, 15]; // minutes
const batchPauseArg = args.find((a) => a.startsWith("--batch-pause="));
if (batchPauseArg) {
  const p = batchPauseArg.split("=")[1].split(",").map(Number);
  BATCH_PAUSE_MIN = p[0];
  BATCH_PAUSE_MAX = p[1] ?? p[0];
}

const MAX_PAGE_ATTEMPTS = 3; // reload-retries for the logged-out-page TikTok bug

// statuses that mean "leave it alone"
const DONE_STATUSES = new Set(["SENT", "SKIPPED", "SUBMITTED_RED_NOTICE", "NO_DM"]);
// comment statuses that mean "don't re-comment on re-run"
const COMMENT_DONE_STATUSES = new Set(["COMMENTED", "COMMENT_DISABLED"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

function loadRows() {
  const text = readFileSync(CSV_PATH, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true });
}

function saveRows(rows) {
  const header = ["No", "Name", "Greeting", "Platform", "Followers", "Notes", "Link", "Status", "SentAt", "CommentStatus", "CommentedAt"];
  writeFileSync(CSV_PATH, stringify(rows, { header: true, columns: header }));
}

function greetingFor(row) {
  return (row.Greeting && row.Greeting.trim()) || row.Name.trim().split(/\s+/)[0];
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --- persisted per-day action counter (for the daily cap) -------------------
const DAILY_STATE = `${LOG_DIR}/daily-state.json`;
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function loadDaily() {
  try {
    const s = JSON.parse(readFileSync(DAILY_STATE, "utf8"));
    if (s.date === todayStr()) return s; // stale (previous day) -> reset
  } catch {}
  return { date: todayStr(), count: 0 };
}
function saveDaily(s) {
  try { writeFileSync(DAILY_STATE, JSON.stringify(s)); } catch {}
}

// --- per-row state predicates ----------------------------------------------
const norm = (s) => (s || "").trim();
const dmDone = (r) => DONE_STATUSES.has(norm(r.Status));
const dmSentOk = (r) => ["SENT", "SUBMITTED_RED_NOTICE"].includes(norm(r.Status));
const commentDone = (r) => COMMENT_DONE_STATUSES.has(norm(r.CommentStatus));
// only comment after the DM actually went out, and only once
const needsComment = (r) => DO_COMMENT && dmSentOk(r) && !commentDone(r);
const needsWork = (r) => (COMMENT_ONLY ? needsComment(r) : !dmDone(r) || needsComment(r));

async function ensureLoggedIn(page) {
  await page.goto("https://www.tiktok.com/messages?lang=en", { waitUntil: "domcontentloaded" });
  // The composer / Messages heading only renders when authenticated.
  try {
    await page.getByText("Messages", { exact: true }).first().waitFor({ timeout: 8000 });
    return true;
  } catch {
    console.log("\n>>> Not logged in. A browser window is open — please log into TikTok");
    console.log(">>> (the tunelabid account). Waiting up to 5 minutes...\n");
    await page.getByText("Messages", { exact: true }).first().waitFor({ timeout: 5 * 60 * 1000 });
    return true;
  }
}

// Best-effort: did the last outgoing message fail to deliver (red notice)?
// Returns "red_notice" | "ok" | "unknown". Screenshots are the ground truth —
// always eyeball ./logs if unsure. Selector may need tuning if TikTok reskins.
async function checkDelivery(page) {
  try {
    const fail = page
      .locator('[class*="essage"]')
      .locator('svg, [aria-label]')
      .filter({ hasText: /resend|not sent|failed|send again|tidak terkirim/i });
    if ((await fail.count()) > 0) return "red_notice";
    const failText = page.getByText(/not delivered|tap to retry|failed to send|tidak terkirim/i);
    if ((await failText.count()) > 0) return "red_notice";
    return "ok";
  } catch {
    return "unknown";
  }
}

async function sendOne(page, row) {
  const link = row.Link.trim();
  const greeting = greetingFor(row);
  const message = TEMPLATE.replace("{greeting}", greeting);

  // Open profile -> Message -> composer. TikTok sometimes renders the page in a
  // half-logged-out state where the Message button or composer never mounts; a
  // reload fixes it. Retry the whole acquisition up to MAX_PAGE_ATTEMPTS.
  let composer = null;
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    try {
      log(`    -> opening profile ${link} (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`);
      await page.goto(link, { waitUntil: "domcontentloaded" });
      await sleep(jitter(1000, 1800)); // let the SPA hydrate / auth settle

      log(`    -> looking for Message button`);
      const msgBtn = page.getByRole("button", { name: "Message", exact: true });
      await msgBtn.waitFor({ timeout: 9000 });
      log(`    -> Message button found`);

      if (DRY_RUN) return { status: "DRY_RUN", note: `would send to ${greeting}` };

      await msgBtn.click();
      log(`    -> clicked Message, waiting for composer`);
      const c = page
        .getByRole("textbox")
        .or(page.locator('div[contenteditable="true"]'))
        .first();
      await c.waitFor({ timeout: 12000 });
      await c.click();
      log(`    -> composer ready`);
      composer = c;
      break;
    } catch (e) {
      if (/closed/i.test(e.message)) throw e; // page/browser died -> let main repair+retry
      log(`    -> attempt ${attempt} failed (${e.message.split("\n")[0]})`);
      if (attempt < MAX_PAGE_ATTEMPTS) {
        log(`    -> reloading and retrying`);
        await sleep(jitter(1200, 2200));
      }
    }
  }
  if (!composer) {
    return { status: "NO_DM", note: "Message/composer not ready after retries (DM locked or persistent load issue)" };
  }

  // Type human-ish and send.
  log(`    -> typing message (${message.length} chars)`);
  await composer.type(message, { delay: jitter(8, 25) });
  await sleep(jitter(300, 700));
  log(`    -> pressing Enter to send`);
  await page.keyboard.press("Enter");

  // Let it settle, screenshot, check delivery.
  await sleep(jitter(2000, 3500));
  const shot = `${LOG_DIR}/${row.No}-${greeting.replace(/\W+/g, "_")}.png`;
  await page.screenshot({ path: shot });
  log(`    -> screenshot saved ${shot}`);
  const delivery = await checkDelivery(page);
  log(`    -> delivery check: ${delivery}`);

  if (delivery === "red_notice") {
    return { status: "SUBMITTED_RED_NOTICE", note: `screenshot: ${shot}` };
  }
  return { status: "SENT", note: `delivery=${delivery}; screenshot: ${shot}` };
}

// Read the creator's recent videos off their profile grid and rank them by
// view count ascending. Lowest views ~= fewest comments ~= our comment is
// noticeable (not buried). Pinned/viral videos have huge view counts so they
// naturally sort to the end and get skipped. Returns [{href, views}, ...].
async function pickCandidates(page) {
  await page.waitForSelector('a[href*="/video/"]', { timeout: 15000 });
  await sleep(jitter(600, 1200)); // let lazy view-count labels paint
  const items = await page.evaluate(() => {
    const parse = (s) => {
      if (!s) return Infinity; // unknown -> treat as "many", sort last
      const t = s.trim().toUpperCase();
      const n = parseFloat(t.replace(/[^0-9.]/g, ""));
      if (isNaN(n)) return Infinity;
      if (t.includes("M")) return n * 1e6;
      if (t.includes("K")) return n * 1e3;
      return n;
    };
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const href = a.href.split("?")[0];
      if (seen.has(href)) continue;
      seen.add(href);
      const v =
        a.querySelector('[data-e2e="video-views"]') ||
        a.parentElement?.querySelector('[data-e2e="video-views"]');
      out.push({ href, views: parse(v && v.textContent) });
      if (out.length >= 15) break;
    }
    return out;
  });
  return items.sort((a, b) => a.views - b.views);
}

// TikTok throws a slider/puzzle captcha when it suspects automation. We can't
// solve it, so detect it and halt the run rather than blindly marking success.
async function isCaptcha(page) {
  try {
    return await page.evaluate(() => {
      const sels = [
        ".captcha_verify_container",
        ".captcha-verify-container",
        ".secsdk-captcha-drag-icon",
        "#captcha-verify-image",
        'div[id*="captcha"]',
      ];
      if (sels.some((s) => document.querySelector(s))) return true;
      return /drag the slider to fit the puzzle|geser.*puzzle|verify to continue/i.test(
        document.body?.innerText || ""
      );
    });
  } catch {
    return false;
  }
}

// Poll until the captcha is gone (the human solved it) or we time out.
async function waitForCaptchaCleared(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let logged = 0;
  while (Date.now() < deadline) {
    if (!(await isCaptcha(page))) return true;
    const leftS = Math.ceil((deadline - Date.now()) / 1000);
    if (Date.now() - logged > 20000) { log(`    -> [comment] still waiting for captcha to be solved (~${leftS}s left)...`); logged = Date.now(); }
    await sleep(2500);
  }
  return false;
}

// Pull the @handle out of a profile or video URL, lowercased. e.g.
// https://www.tiktok.com/@petrovacatherina/video/123 -> "petrovacatherina"
function handleFromUrl(url) {
  const m = (url || "").match(/@([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

// After the DM, post a public comment on the least-popular recent video so the
// creator sees a nudge to check their DM. Tries up to COMMENT_VIDEO_TRIES of
// the lowest-view videos in case the first has comments disabled.
async function commentOnVideo(page, row) {
  const greeting = greetingFor(row);
  const text = pickComment(greeting);
  const link = row.Link.trim();

  // Load the profile and rank videos by view count.
  let candidates = [];
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS && !candidates.length; attempt++) {
    try {
      log(`    -> [comment] opening profile ${link} (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`);
      await page.goto(link, { waitUntil: "domcontentloaded" });
      await sleep(jitter(1200, 2000));
      candidates = await pickCandidates(page);
    } catch (e) {
      if (/closed/i.test(e.message)) throw e;
      log(`    -> [comment] profile attempt ${attempt} failed (${e.message.split("\n")[0]})`);
      if (attempt < MAX_PAGE_ATTEMPTS) await sleep(jitter(1200, 2200));
    }
  }
  if (!candidates.length) {
    return { status: "COMMENT_FAILED", note: "no videos found on profile" };
  }

  // Guard: the videos must actually belong to the target creator. When a profile
  // is renamed/deactivated/private, TikTok can redirect to the logged-in user's
  // own feed — commenting there nudges the wrong (or our own) account. Drop any
  // candidate whose handle doesn't match the target, and bail if none remain.
  const targetHandle = handleFromUrl(link);
  if (targetHandle) {
    const matched = candidates.filter((c) => handleFromUrl(c.href) === targetHandle);
    if (!matched.length) {
      const got = [...new Set(candidates.map((c) => handleFromUrl(c.href)).filter(Boolean))].join(", ") || "unknown";
      return {
        status: "COMMENT_WRONG_PROFILE",
        note: `@${targetHandle} did not load — videos belonged to: ${got}. Skipped to avoid commenting on the wrong account.`,
      };
    }
    candidates = matched;
  }

  if (DRY_RUN) {
    const c = candidates[0];
    return { status: "COMMENT_DRY_RUN", note: `would comment on ${c.href} (~${c.views} views): "${text}"` };
  }

  // Try the least-popular videos until one accepts a comment.
  const tryList = candidates.slice(0, COMMENT_VIDEO_TRIES);
  for (let i = 0; i < tryList.length; i++) {
    const cand = tryList[i];
    try {
      log(`    -> [comment] video ${i + 1}/${tryList.length}: ${cand.href} (~${cand.views} views)`);
      await page.goto(cand.href, { waitUntil: "domcontentloaded" });
      await sleep(jitter(1500, 2500));

      // The comment panel is collapsed by default; the reliable opener is the
      // button whose accessible name is "Read or add comments" (clicking the raw
      // comment-icon svg hangs). Clicking it mounts the composer + post button.
      try {
        const opener = page.getByRole("button", { name: /add comments/i }).first();
        await opener.waitFor({ state: "visible", timeout: 9000 });
        await opener.click({ timeout: 6000 });
      } catch {
        // fallback for layouts/locales without that aria label
        try { await page.locator('[data-e2e="comment-icon"]').first().click({ timeout: 4000 }); } catch {}
      }
      await sleep(jitter(1000, 1800));

      const box = page
        .locator('[data-e2e="comment-input"] div[contenteditable="true"]')
        .or(page.locator(".public-DraftEditor-content"))
        .first();
      await box.waitFor({ state: "visible", timeout: 8000 });

      let ccount = null;
      try {
        ccount = norm(await page.locator('[data-e2e="comment-count"]').first().textContent());
      } catch {}

      // The editor is visible but the video player overlaps it, so a normal
      // click hangs on Playwright's "is it obscured" check — force-click to
      // focus, then type via the keyboard (Draft.js ignores programmatic value).
      await box.scrollIntoViewIfNeeded().catch(() => {});
      await box.click({ force: true });
      log(`    -> [comment] typing on video with ${ccount ?? "?"} comments (${text.length} chars)`);
      await page.keyboard.type(text, { delay: jitter(8, 25) });
      await sleep(jitter(400, 900));

      // The Post button stays disabled="" until text is present; wait for the
      // enabled one, then click. Fall back to Enter if it never enables.
      let posted = false;
      try {
        const postBtn = page.locator('[data-e2e="comment-post"]:not([disabled])').first();
        await postBtn.waitFor({ state: "visible", timeout: 5000 });
        await postBtn.click({ timeout: 5000 });
        posted = true;
      } catch {}
      if (!posted) await page.keyboard.press("Enter");

      await sleep(jitter(1800, 3000));
      const shot = `${LOG_DIR}/${row.No}-${greeting.replace(/\W+/g, "_")}-comment.png`;
      await page.screenshot({ path: shot }).catch(() => {});

      // Posting often triggers a slider captcha. We can't solve it, but the
      // human running this can — pause and wait for them to clear it, then
      // finalize. Only halt if it's left unsolved past CAPTCHA_WAIT_S.
      if (await isCaptcha(page)) {
        log(`    -> [comment] CAPTCHA — solve the slider in the browser now; waiting up to ${CAPTCHA_WAIT_S}s...`);
        const solved = await waitForCaptchaCleared(page, CAPTCHA_WAIT_S * 1000);
        if (!solved) {
          return {
            status: "COMMENT_CAPTCHA",
            note: `captcha not solved within ${CAPTCHA_WAIT_S}s on ${cand.href} — run halted; solve it and re-run. screenshot: ${shot}`,
          };
        }
        log(`    -> [comment] captcha cleared — finalizing post`);
        await sleep(jitter(1000, 1800));
        // Solving usually completes the pending submit; if our text is still in
        // the editor, click Post once more to actually send it.
        try {
          const editor = page
            .locator('[data-e2e="comment-input"] div[contenteditable="true"]')
            .or(page.locator(".public-DraftEditor-content"))
            .first();
          const leftover = (await editor.innerText().catch(() => "")).trim();
          if (leftover) {
            const postBtn = page.locator('[data-e2e="comment-post"]:not([disabled])').first();
            await postBtn.click({ timeout: 5000 }).catch(() => {});
            await sleep(jitter(1500, 2500));
          }
        } catch {}
        await page.screenshot({ path: shot }).catch(() => {});
        if (await isCaptcha(page)) {
          return { status: "COMMENT_CAPTCHA", note: `captcha reappeared on ${cand.href} — halting; solve it and re-run. screenshot: ${shot}` };
        }
      }

      // Confirm the post really landed: the editor clears AND/OR a "Comment
      // posted" toast appears. On error we treat it as NOT confirmed (retryable)
      // rather than assuming success.
      let cleared = false;
      try { cleared = !(await box.innerText()).trim(); } catch { cleared = false; }
      let toast = false;
      try { toast = await page.evaluate(() => /comment posted/i.test(document.body?.innerText || "")); } catch {}
      const confirmed = cleared || toast;
      log(`    -> [comment] screenshot saved ${shot} (confirmed=${confirmed})`);
      if (!confirmed) {
        return {
          status: "COMMENT_FAILED",
          note: `post not confirmed (editor not cleared, no success toast) on ${cand.href}; screenshot: ${shot}`,
        };
      }
      return {
        status: "COMMENTED",
        note: `"${text}" on ${cand.href} (${ccount ?? "?"} comments, ~${cand.views} views); confirmed=${confirmed}; screenshot: ${shot}`,
      };
    } catch (e) {
      if (/closed/i.test(e.message)) throw e;
      log(`    -> [comment] video ${i + 1} failed (${e.message.split("\n")[0]}); trying next`);
      await sleep(jitter(1000, 1800));
    }
  }
  // Exhausted candidates — treat as retryable (could be transient load issues),
  // not a permanent skip. Re-running blast will try this creator again.
  return { status: "COMMENT_FAILED", note: "no commentable video after trying least-popular candidates" };
}

// Returns { page, cleanup }. Default: attach to your real Chrome over CDP
// (reuses the logged-in tunelabid session, no login). --fresh uses an
// isolated profile that you log into once.
async function getSession() {
  if (FRESH) {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await ensureLoggedIn(page);
    return { page, cleanup: () => ctx.close() };
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error(`\nCould not reach Chrome at ${CDP_URL}.`);
    console.error("Relaunch the debug Chrome on the copied profile:\n");
    console.error(`  open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug-tunelab" --no-first-run --no-default-browser-check\n`);
    console.error("Then re-run this. (Or use --fresh to log into an isolated profile instead.)");
    process.exit(1);
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage(); // our own tab; leaves your other tabs alone
  // CDP browser.close() just disconnects — it does NOT kill your Chrome.
  const session = { browser, ctx, page, cleanup: async () => { await browser.close(); } };
  return session;
}

// Repair a dead session in place: reconnect if the browser dropped, or open a
// fresh tab if our page crashed (the "Target ... has been closed" cascade).
async function ensureHealthy(session) {
  if (FRESH) return; // persistent context: nothing to reconnect to
  if (!session.browser.isConnected()) {
    log(`    -> browser disconnected; reconnecting over CDP`);
    const next = await getSession();
    Object.assign(session, next);
    return;
  }
  if (session.page.isClosed()) {
    log(`    -> tab was closed; opening a fresh one`);
    session.page = await session.ctx.newPage();
  }
}

// Run one step (DM or comment) with session-repair retry. `fn` is (page,row)->res.
async function runStep(session, row, fn, label) {
  let res;
  for (let tries = 1; tries <= 2; tries++) {
    try {
      await ensureHealthy(session);
      res = await fn(session.page, row);
      break;
    } catch (err) {
      log(`    -> [${label}] error: ${err.message.split("\n")[0]}`);
      if (tries === 1 && /closed/i.test(err.message)) {
        log(`    -> repairing session and retrying ${label}`);
        continue;
      }
      res = { status: label === "comment" ? "COMMENT_FAILED" : "ERROR", note: err.message.split("\n")[0] };
    }
  }
  return res;
}

async function main() {
  const rows = loadRows();
  const pending = rows.filter(needsWork);
  log(`run log: ${RUN_LOG}`);
  const mode = COMMENT_ONLY ? "comment-only" : DO_COMMENT ? "DM + comment" : "DM only";
  log(`${rows.length} rows total, ${pending.length} to process — mode: ${mode}${DRY_RUN ? " (DRY RUN)" : ""}.`);

  // Daily cap, persisted across runs. Dry runs don't count toward it.
  const daily = loadDaily();
  const remainingToday = DRY_RUN ? Infinity : Math.max(0, DAILY_CAP - daily.count);
  if (!DRY_RUN) {
    log(`daily cap: ${DAILY_CAP}/day — ${daily.count} done today (${daily.date}), ${remainingToday} left`);
    if (remainingToday === 0) {
      log(`daily cap already reached for ${daily.date}; nothing to do. (override with --daily-cap=N)`);
      return; // no session launched
    }
  }
  log(`pacing between profiles: ${DELAY_MIN}-${DELAY_MAX}s` +
    (NO_BATCH_PAUSE ? "; batch pauses off" : `; batch pause ${BATCH_PAUSE_MIN}-${BATCH_PAUSE_MAX} min every ~${BATCH_EVERY}`));

  const session = await getSession();
  log(`session ready (${FRESH ? "fresh profile" : "CDP @ " + CDP_URL})`);

  const total = Math.min(pending.length, LIMIT, remainingToday);
  let count = 0;
  let nextBatchAt = jitter(BATCH_EVERY - 2, BATCH_EVERY + 3); // first pause ~BATCH_EVERY, randomized
  const tally = {};
  const bump = (s) => (tally[s] = (tally[s] || 0) + 1);
  for (const row of pending) {
    if (count >= total) break;
    count++;
    const greeting = greetingFor(row);
    log(`[${count}/${total}] ${row.Name} (${greeting}) -> ${row.Link}  (today ${daily.count}/${DAILY_CAP})`);

    // --- DM step ---
    if (!COMMENT_ONLY && !dmDone(row)) {
      const res = await runStep(session, row, sendOne, "dm");
      row.Status = res.status;
      if (dmSentOk(row)) row.SentAt = stamp();
      saveRows(rows); // persist after every step -> resumable
      bump(res.status);
      log(`[${count}/${total}] ${row.Name}: DM ${res.status} — ${res.note}`);
    }

    // --- comment step (only after a DM actually went out) ---
    if (needsComment(row)) {
      await sleep(jitter(1500, 3000)); // small gap between DM and comment
      const cres = await runStep(session, row, commentOnVideo, "comment");
      row.CommentStatus = cres.status;
      if (cres.status === "COMMENTED") row.CommentedAt = stamp();
      saveRows(rows);
      bump(cres.status);
      log(`[${count}/${total}] ${row.Name}: COMMENT ${cres.status} — ${cres.note}`);

      // A captcha means TikTok is actively challenging us — stop the run so we
      // don't burn the account. This row stays retryable; re-run after solving.
      if (cres.status === "COMMENT_CAPTCHA") {
        log(`    -> CAPTCHA detected — halting run. Solve the puzzle in the debug browser, then re-run to resume.`);
        break;
      }
    }

    // count this creator toward the persisted daily cap
    if (!DRY_RUN) { daily.count++; saveDaily(daily); }

    // gap before the next creator: batch pause every ~BATCH_EVERY, else normal delay
    if (count < total) {
      if (!NO_BATCH_PAUSE && count >= nextBatchAt) {
        const mins = BATCH_PAUSE_MIN + Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN);
        log(`    -> batch pause: resting ${mins.toFixed(1)} min after ${count} creators this run`);
        await sleep(mins * 60 * 1000);
        nextBatchAt = count + jitter(BATCH_EVERY - 2, BATCH_EVERY + 3);
      } else {
        const wait = jitter(DELAY_MIN * 1000, DELAY_MAX * 1000);
        log(`    -> waiting ${(wait / 1000).toFixed(1)}s before next`);
        await sleep(wait);
      }
    }
  }

  log(`done. tally: ${JSON.stringify(tally)}`);
  if (!DRY_RUN) log(`daily total now ${daily.count}/${DAILY_CAP} for ${daily.date}`);
  log(`review screenshots in ${LOG_DIR}/ and the run log ${RUN_LOG}`);
  await session.cleanup();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
