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

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FRESH = args.includes("--fresh"); // use isolated profile + login instead of CDP
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TUNELAB_PROFILE = "Profile 16"; // tunelabid@gmail.com

// Gap between creators, in seconds. Override: --delay=min,max (e.g. --delay=4,10).
// Lower = faster but more bot-like (higher ban risk). Default 6-14s.
const delayArg = args.find((a) => a.startsWith("--delay="));
let [DELAY_MIN, DELAY_MAX] = [1, 5];
if (delayArg) {
  const p = delayArg.split("=")[1].split(",").map(Number);
  DELAY_MIN = p[0];
  DELAY_MAX = p[1] ?? p[0];
}
const MAX_PAGE_ATTEMPTS = 3; // reload-retries for the logged-out-page TikTok bug

// statuses that mean "leave it alone"
const DONE_STATUSES = new Set(["SENT", "SKIPPED", "SUBMITTED_RED_NOTICE", "NO_DM"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

function loadRows() {
  const text = readFileSync(CSV_PATH, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true });
}

function saveRows(rows) {
  const header = ["No", "Name", "Greeting", "Platform", "Followers", "Notes", "Link", "Status", "SentAt"];
  writeFileSync(CSV_PATH, stringify(rows, { header: true, columns: header }));
}

function greetingFor(row) {
  return (row.Greeting && row.Greeting.trim()) || row.Name.trim().split(/\s+/)[0];
}

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

async function main() {
  const rows = loadRows();
  const pending = rows.filter((r) => !DONE_STATUSES.has((r.Status || "").trim()));
  log(`run log: ${RUN_LOG}`);
  log(`${rows.length} rows total, ${pending.length} to process${DRY_RUN ? " (DRY RUN)" : ""}.`);
  log(`pacing between profiles: ${DELAY_MIN}-${DELAY_MAX}s`);

  const session = await getSession();
  log(`session ready (${FRESH ? "fresh profile" : "CDP @ " + CDP_URL})`);

  const total = Math.min(pending.length, LIMIT);
  let count = 0;
  const tally = {};
  for (const row of pending) {
    if (count >= LIMIT) break;
    count++;
    const greeting = greetingFor(row);
    log(`[${count}/${total}] ${row.Name} (${greeting}) -> ${row.Link}`);

    let res;
    for (let tries = 1; tries <= 2; tries++) {
      try {
        await ensureHealthy(session);
        res = await sendOne(session.page, row);
        break;
      } catch (err) {
        log(`    -> error: ${err.message.split("\n")[0]}`);
        if (tries === 1 && /closed/i.test(err.message)) {
          log(`    -> repairing session and retrying this creator`);
          continue;
        }
        res = { status: "ERROR", note: err.message.split("\n")[0] };
      }
    }

    row.Status = res.status;
    if (res.status === "SENT" || res.status === "SUBMITTED_RED_NOTICE") {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      row.SentAt = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    saveRows(rows); // persist after every creator -> resumable
    tally[res.status] = (tally[res.status] || 0) + 1;
    log(`[${count}/${total}] ${row.Name}: ${res.status} — ${res.note}`);

    // gap between creators
    if (count < total) {
      const wait = jitter(DELAY_MIN * 1000, DELAY_MAX * 1000);
      log(`    -> waiting ${(wait / 1000).toFixed(1)}s before next`);
      await sleep(wait);
    }
  }

  log(`done. tally: ${JSON.stringify(tally)}`);
  log(`review screenshots in ${LOG_DIR}/ and the run log ${RUN_LOG}`);
  await session.cleanup();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
