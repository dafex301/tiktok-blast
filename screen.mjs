import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { chromium } from "playwright";
import OpenAI from "openai";

// ============================================================================
// screen.mjs — agentic AI screening between discovery and the blast
//
// discover.mjs  →  discovered-*.csv  →  [ screen.mjs ]  →  creators.csv  →  blast.mjs
//                  raw, ranked by stats   AI picks the fits    ready to DM
//
// Stats only get you so far — a 50k-follower account can still be the wrong
// vibe for a campaign. This stage actually *looks* at each creator's content:
//
//   1. Vision — screenshots the profile's recent videos and asks an image model
//      to read the content's style, tone, topics, and who it's speaking to.
//      (https://developers.openai.com/api/docs/guides/images-vision)
//   2. Reasoning — hands that read + the creator's stats + the campaign brief to
//      a text model, which scores the fit 0-100, decides keep/skip, and writes a
//      one-line rationale + a suggested angle for the opening message.
//      (https://developers.openai.com/api/docs/guides/text)
//
// Keepers (>= --threshold) are written straight to creators.csv so blast.mjs can
// run with no manual review in between — discovery to first DM, hands-off.
//
// Drives the same debug Chrome as discover.mjs (CDP, port 9223) to grab the
// screenshots, and reads OPENAI_API_KEY from the environment for the models.
//
// Usage:
//   node screen.mjs                              # screen latest discovered-*.csv
//   node screen.mjs --in=discovered_buku.csv --threshold=70
//   node screen.mjs --in=discovered_buku.csv --out=creators.csv --shots=4
//
// Flags (all optional):
//   --in=path         input CSV (default: newest discovered-*.csv in cwd)
//   --out=path        where keepers are written      (default ./creators.csv)
//   --threshold=N     keep creators with fit >= N     (default 65)
//   --shots=N         # of recent-video thumbnails to show the vision model (4)
//   --limit=N         only screen the first N rows    (default all)
//   --delay=min,max   seconds between creators         (default 2,5)
//   --vision-model=M  image model     (default gpt-4.1-mini)
//   --text-model=M    reasoning model  (default gpt-5.5)
// ============================================================================

const LOG_DIR = "./logs";
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_LOG = `${LOG_DIR}/screen-${RUN_STAMP}.log`;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(RUN_LOG, line + "\n"); } catch {}
}

// --- the campaign the creators are being screened against -------------------
// Keep this in sync with the message template in blast.mjs — the model reads it
// to decide who actually fits, so the more concrete it is, the better the picks.
const CAMPAIGN = {
  product: "Nada",
  pitch:
    "Nada is an app that lets anyone make music or compose a song just by humming. " +
    "We want TikTok creators whose content and audience fit a music-creation tool — " +
    "music, singing, songwriting, instruments, or creative/DIY content with an " +
    "engaged Indonesian audience. A good fit makes music feel approachable and fun. " +
    "Pure dance-only, lip-sync-only, or off-topic niches (food, gaming, beauty) are weak fits " +
    "unless music is clearly central.",
};

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : def;
};
const OUT = flag("out", "./creators.csv");
const THRESHOLD = parseInt(flag("threshold", "65"), 10);
const SHOTS = parseInt(flag("shots", "4"), 10);
const LIMIT = flag("limit", "") ? parseInt(flag("limit"), 10) : Infinity;
const VISION_MODEL = flag("vision-model", "gpt-4.1-mini");
const TEXT_MODEL = flag("text-model", "gpt-5.5");
const CDP_URL = process.env.CDP_URL || "http://localhost:9223";
let [DELAY_MIN, DELAY_MAX] = (flag("delay", "2,5")).split(",").map(Number);
if (Number.isNaN(DELAY_MAX)) DELAY_MAX = DELAY_MIN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// newest discovered-*.csv in cwd, so `node screen.mjs` just works after a run.
function newestDiscovered() {
  const files = readdirSync(".").filter((f) => /^discovered.*\.csv$/.test(f));
  if (!files.length) return null;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
const IN = flag("in", "") || newestDiscovered();

const openai = new OpenAI(); // reads OPENAI_API_KEY from the environment

// --- CDP session (attach to the same debug Chrome discover.mjs uses) ---------
async function getSession() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error(`\nCould not reach Chrome at ${CDP_URL}. Launch the debug profile first:\n`);
    console.error(`  ./launch-browser.sh            # port 9223\n`);
    process.exit(1);
  }
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  return { browser, ctx, page, cleanup: async () => { await browser.close(); } };
}

// Visit a profile and screenshot up to `shots` recent-video thumbnails. Returns
// an array of base64 data URLs ready to drop into a vision request.
async function captureContent(page, link, shots) {
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-e2e="user-post-item"]', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.scrollBy(0, 700)); // nudge the grid to render
  await sleep(jitter(1000, 1800));
  const items = await page.$$('[data-e2e="user-post-item"]');
  const urls = [];
  for (const el of items.slice(0, shots)) {
    try {
      const buf = await el.screenshot();
      urls.push(`data:image/png;base64,${buf.toString("base64")}`);
    } catch { /* skip thumbnails that won't render */ }
  }
  return urls;
}

// Stage 1 — vision: read the content's style, tone, topics, and audience.
async function describeContent(imageUrls, creator) {
  if (!imageUrls.length) return "No video thumbnails could be captured.";
  const res = await openai.responses.create({
    model: VISION_MODEL,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `These are recent TikTok video thumbnails from @${creator.Username} ("${creator.Name}").\n` +
            `Bio: ${creator.Bio || "(none)"}\n\n` +
            `In 2-3 sentences, describe this creator's content: the main topics, the ` +
            `style/tone, and who the audience seems to be. Note especially whether ` +
            `music, singing, or songwriting shows up.`,
        },
        ...imageUrls.map((url) => ({ type: "input_image", image_url: url })),
      ],
    }],
  });
  return res.output_text.trim();
}

// Stage 2 — reasoning: score the fit against the campaign and decide keep/skip.
async function judgeFit(summary, creator) {
  const res = await openai.responses.create({
    model: TEXT_MODEL,
    input:
      `Campaign — ${CAMPAIGN.product}: ${CAMPAIGN.pitch}\n\n` +
      `Creator @${creator.Username} ("${creator.Name}")\n` +
      `Followers: ${creator.Followers || "?"} · median views: ${creator.MedianViews || "?"} · ` +
      `engagement: ${creator.Engagement || "?"} · region hint: ${creator.RegionHint || "?"}\n` +
      `Content read: ${summary}\n\n` +
      `Decide how well this creator fits the campaign. Reply with ONLY a JSON object:\n` +
      `{"fit": <0-100 integer>, "keep": <true|false>, "reason": "<one sentence>", ` +
      `"angle": "<one-line hook for the opening DM, in Indonesian>"}`,
  });
  // models occasionally wrap JSON in prose/fences — grab the first {...} block.
  const raw = res.output_text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : raw);
  } catch {
    log(`    -> could not parse model JSON, treating as skip: ${raw.slice(0, 120)}`);
    return { fit: 0, keep: false, reason: "unparseable model response", angle: "" };
  }
}

// --- creators.csv (first 9 cols blast.mjs reads, + screening columns) --------
function writeKeepers(rows, outPath) {
  const header = [
    "No", "Name", "Greeting", "Platform", "Followers", "Notes", "Link", "Status", "SentAt",
    "FitScore", "FitReason", "Angle", "ContentSummary",
  ];
  const out = rows.map((r, i) => ({ ...r, No: i + 1 }));
  writeFileSync(outPath, stringify(out, { header: true, columns: header }));
}

async function main() {
  log(`run log: ${RUN_LOG}`);
  if (!IN || !existsSync(IN)) {
    console.error(`No input CSV. Pass --in=discovered-*.csv (none found in cwd).`);
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(`Set OPENAI_API_KEY in your environment first.`);
    process.exit(1);
  }
  log(`input: ${IN} · campaign: ${CAMPAIGN.product} · threshold: ${THRESHOLD} · vision: ${VISION_MODEL} · text: ${TEXT_MODEL}`);

  // only consider rows that came through discovery clean (blank Status = ready)
  const all = parse(readFileSync(IN, "utf8"), { columns: true, skip_empty_lines: true });
  const candidates = all.filter((r) => !r.Status || r.Status.trim() === "").slice(0, LIMIT);
  log(`${all.length} rows in, ${candidates.length} ready to screen`);

  const session = await getSession();
  log(`session ready (CDP @ ${CDP_URL})`);

  const kept = [];
  let i = 0;
  for (const c of candidates) {
    i++;
    log(`[${i}/${candidates.length}] @${c.Username} (${c.Followers || "?"} followers)`);
    try {
      const shots = await captureContent(session.page, c.Link, SHOTS);
      const summary = await describeContent(shots, c);
      const verdict = await judgeFit(summary, c);
      const keep = verdict.keep && verdict.fit >= THRESHOLD;
      log(`    -> fit ${verdict.fit} ${keep ? "KEEP" : "skip"} — ${verdict.reason}`);
      if (keep) {
        kept.push({
          Name: c.Name,
          Greeting: c.Greeting,
          Platform: c.Platform || "TikTok",
          Followers: c.Followers,
          Notes: c.Notes || "",
          Link: c.Link,
          Status: "", // blank = ready for blast.mjs
          SentAt: "",
          FitScore: verdict.fit,
          FitReason: verdict.reason,
          Angle: verdict.angle || "",
          ContentSummary: summary,
        });
      }
    } catch (e) {
      log(`    -> error, skipping: ${e.message.split("\n")[0]}`);
    }
    await sleep(jitter(DELAY_MIN * 1000, DELAY_MAX * 1000));
  }

  // best fits first, then write the blast list.
  kept.sort((a, b) => (b.FitScore || 0) - (a.FitScore || 0));
  writeKeepers(kept, OUT);
  log(`done. ${kept.length}/${candidates.length} creators passed screening -> ${OUT}`);
  log(`(first 9 columns are the blast list — run: npm run dry, then npm run blast)`);
  await session.cleanup();
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
