import { chromium } from "playwright";

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
try {
  await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // Pull logged-in identity from the rehydration blob if present.
  const info = await page.evaluate(() => {
    const out = { handle: null, nickname: null, loggedIn: null };
    try {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (el) {
        const data = JSON.parse(el.textContent);
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const user = scope["webapp.app-context"]?.user || scope["webapp.user-detail"]?.userInfo?.user;
        if (user) {
          out.handle = user.uniqueId || user.secUid || null;
          out.nickname = user.nickName || user.nickname || null;
          out.loggedIn = !!user.uniqueId;
        }
      }
    } catch (e) { out.err = String(e); }
    // Fallback: look for a profile link / login button in the DOM.
    if (out.loggedIn === null) {
      const loginBtn = document.querySelector('[data-e2e="top-login-button"], [data-e2e="nav-login"]');
      const profileLink = document.querySelector('a[href^="/@"]');
      out.loggedIn = !loginBtn && !!profileLink;
      if (profileLink) out.handle = profileLink.getAttribute("href");
    }
    return out;
  });

  console.log(JSON.stringify(info, null, 2));
} finally {
  await page.close();
  await browser.close(); // CDP close = disconnect only; does not kill Chrome
}
