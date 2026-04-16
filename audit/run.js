#!/usr/bin/env node
// Responsive audit runner. Usage:
//   npm run audit -- --url https://studio.staging.kobecreative.co.uk
//   npm run audit -- --url ... --viewports=all
//   npm run audit -- --url ... --viewports=galaxy-s24,iphone-16

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { resolveViewports } from './lib/viewports.js';
import { now, ensureDir, writeJson, writeText } from './lib/util.js';
import { buildReport } from './lib/report.js';

import overflowCheck from './checks/overflow.js';
import touchTargetsCheck from './checks/touch-targets.js';
import clippingCheck from './checks/clipping.js';
import a11yCheck from './checks/a11y.js';
import consoleCheck from './checks/console.js';
import aestheticCheck from './checks/aesthetic.js';
import metaCheck from './checks/meta.js';
import copyCheck from './checks/copy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT_CHECKS = [overflowCheck, touchTargetsCheck, clippingCheck, a11yCheck, consoleCheck];
const VIEWPORT_POST_SHOT_CHECKS = [aestheticCheck];
const PAGE_CHECKS = [metaCheck, copyCheck];

function parseArgs(argv) {
  const args = {
    url: null, viewports: 'default', out: null, 'delay-ms': '0',
    vision: 'false', 'vision-model': 'llama3.2-vision', 'vision-host': 'http://localhost:11434',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vision') { args.vision = 'true'; continue; }
    const [key, val] = a.startsWith('--') ? a.slice(2).split('=') : [null, null];
    if (!key) continue;
    if (val !== undefined) args[key] = val;
    else args[key] = argv[++i];
  }
  return args;
}

async function gotoStable(page, url) {
  // Retry twice on transient network errors — staging servers behind
  // rate-limiters (Hetzner fail2ban) sometimes drop mid-run connections.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(500);
      return;
    } catch (e) {
      lastErr = e;
      if (!/ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE/.test(e.message)) throw e;
      await page.waitForTimeout(2000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: npm run audit -- --url <url> [--viewports=default|all|id,id] [--out <dir>]');
    process.exit(1);
  }

  const viewports = resolveViewports(args.viewports);
  const startedAt = now();
  const outRoot = args.out || path.resolve(__dirname, '..', 'audit-runs', startedAt);
  const shotsDir = path.join(outRoot, 'screenshots');
  await ensureDir(shotsDir);

  console.log(`\n▶ Responsive audit\n  URL: ${args.url}\n  Viewports: ${viewports.map((v) => v.id).join(', ')}\n  Output: ${outRoot}\n`);

  const browser = await chromium.launch();
  const viewportFindings = {};
  let pageFindings = [];

  try {
    // Page-level pass (default viewport) — meta, copy
    {
      const v = viewports.find((x) => x.type === 'desktop') ?? viewports[0];
      const context = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await gotoStable(page, args.url);
      for (const check of PAGE_CHECKS) {
        try { pageFindings.push(...await check(page)); }
        catch (e) { pageFindings.push({ check: check.name, severity: 'error', message: `Check crashed: ${e.message}` }); }
      }
      await context.close();
    }

    // Per-viewport passes
    const delayMs = parseInt(args['delay-ms'], 10) || 0;
    for (const [i, v] of viewports.entries()) {
      if (delayMs && i > 0) await new Promise((r) => setTimeout(r, delayMs));
      console.log(`  · ${v.name} (${v.w}×${v.h})`);
      const context = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, isMobile: v.type === 'mobile', hasTouch: v.type !== 'desktop' });
      const page = await context.newPage();

      const consoleErrors = [];
      const networkErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          consoleErrors.push({ type: msg.type(), text: msg.text(), location: msg.location() });
        }
      });
      page.on('pageerror', (err) => consoleErrors.push({ type: 'error', text: err.message, location: null }));
      page.on('requestfailed', (req) => {
        const failure = req.failure()?.errorText ?? 'failed';
        if (failure === 'net::ERR_ABORTED') return;
        networkErrors.push({ method: req.method(), url: req.url(), failure });
      });

      try {
        await gotoStable(page, args.url);
        const shotPath = path.join(shotsDir, `${v.id}.png`);
        const ctx = {
          consoleErrors,
          networkErrors,
          vision: args.vision === 'true' ? { enabled: true, host: args['vision-host'], model: args['vision-model'], screenshotPath: shotPath } : null,
        };
        const findings = [];

        // Deterministic checks that only need the DOM
        for (const check of VIEWPORT_CHECKS) {
          try {
            const results = await check(page, v, ctx);
            findings.push(...results.map((f) => ({ ...f, viewport: v.id })));
          } catch (e) {
            findings.push({ check: check.name, severity: 'error', message: `Check crashed: ${e.message}`, viewport: v.id });
          }
        }

        // Screenshot — required before checks that need the image on disk
        await page.screenshot({ path: shotPath, fullPage: true });

        // Checks that need the saved screenshot (vision / pixel-diff)
        for (const check of VIEWPORT_POST_SHOT_CHECKS) {
          try {
            const results = await check(page, v, ctx);
            findings.push(...results.map((f) => ({ ...f, viewport: v.id })));
          } catch (e) {
            findings.push({ check: check.name, severity: 'error', message: `Check crashed: ${e.message}`, viewport: v.id });
          }
        }

        viewportFindings[v.id] = findings;
      } catch (e) {
        viewportFindings[v.id] = [{ check: 'runner', severity: 'error', message: `Navigation failed: ${e.message}`, viewport: v.id }];
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const finishedAt = now();
  await writeJson(path.join(outRoot, 'findings.json'), { url: args.url, startedAt, finishedAt, viewports, viewportFindings, pageFindings });
  const md = buildReport({ url: args.url, startedAt, finishedAt, viewports, viewportFindings, pageFindings });
  await writeText(path.join(outRoot, 'report.md'), md);

  const totals = [...Object.values(viewportFindings).flat(), ...pageFindings].reduce((a, f) => { a[f.severity] = (a[f.severity] ?? 0) + 1; return a; }, { error: 0, warning: 0, info: 0 });
  console.log(`\n✔ ${totals.error} errors · ${totals.warning} warnings · ${totals.info} info`);
  console.log(`  Report: ${path.join(outRoot, 'report.md')}\n`);

  if (totals.error > 0) process.exitCode = 1;
}

run().catch((err) => { console.error(err); process.exit(1); });
