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
import metaCheck from './checks/meta.js';
import copyCheck from './checks/copy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT_CHECKS = [overflowCheck, touchTargetsCheck, clippingCheck, a11yCheck, consoleCheck];
const PAGE_CHECKS = [metaCheck, copyCheck];

function parseArgs(argv) {
  const args = { url: null, viewports: 'default', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, val] = a.startsWith('--') ? a.slice(2).split('=') : [null, null];
    if (!key) continue;
    if (val !== undefined) args[key] = val;
    else args[key] = argv[++i];
  }
  return args;
}

async function gotoStable(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(500);
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
    for (const v of viewports) {
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
        const ctx = { consoleErrors, networkErrors };
        const findings = [];
        for (const check of VIEWPORT_CHECKS) {
          try {
            const results = await check(page, v, ctx);
            findings.push(...results.map((f) => ({ ...f, viewport: v.id })));
          } catch (e) {
            findings.push({ check: check.name, severity: 'error', message: `Check crashed: ${e.message}`, viewport: v.id });
          }
        }

        await page.screenshot({ path: path.join(shotsDir, `${v.id}.png`), fullPage: true });
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
