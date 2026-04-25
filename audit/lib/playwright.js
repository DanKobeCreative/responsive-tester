// Playwright helpers shared across the audit + cross-browser runners.
// Kept separate from util.js because util.js is Playwright-free.

// Navigate with retry on transient connection errors. Hetzner-fronted
// staging hosts (fail2ban) sometimes drop a connection mid-run; a flat
// retry with exponential backoff has been enough every time so far.
// Waits networkidle (5s cap) + fonts.ready + 500ms so GSAP / ScrollTrigger
// / Lenis have settled before the caller takes a screenshot.
export async function gotoStable(page, url, opts = {}) {
  const { navigationTimeoutMs = 30000, settleMs = 500 } = opts;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: navigationTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(settleMs);
      return;
    } catch (e) {
      lastErr = e;
      if (!/ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE/.test(e.message)) throw e;
      await page.waitForTimeout(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Scroll the viewport top-to-bottom one screen at a time so GSAP /
// ScrollTrigger / IntersectionObserver / Lenis-driven reveals all fire
// before the screenshot is taken. Without this, full-page captures show
// below-the-fold content as opacity-0 or pre-translation because no
// scroll events have ever occurred. Returns to the top so full-page
// screenshots start where the user would.
export async function triggerScrollAnimations(page, { pause = 300 } = {}) {
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  let scrolled = 0;

  while (scrolled < scrollHeight) {
    scrolled += viewportHeight;
    await page.evaluate((y) => window.scrollTo(0, y), scrolled);
    await page.waitForTimeout(pause);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}
