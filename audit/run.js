#!/usr/bin/env node
// Responsive audit runner. Usage:
//   npm run audit -- --url https://studio.staging.kobecreative.co.uk
//   npm run audit -- --url ... --viewports=all
//   npm run audit -- --url ... --viewports=galaxy-s24,iphone-16

import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { resolveViewports } from './lib/viewports.js';
import { now, ensureDir, writeJson, writeText } from './lib/util.js';
import { gotoStable } from './lib/playwright.js';
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
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env at project root so ANTHROPIC_API_KEY etc. are available to
// subsequent code without requiring a dotenv dependency. Existing env
// vars take precedence so shell exports still win.
async function loadDotenv() {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, val] = match;
      if (process.env[key]) continue;
      process.env[key] = val.trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env file — fine, env may be provided by the shell.
  }
}

const VIEWPORT_CHECKS = [overflowCheck, touchTargetsCheck, clippingCheck, a11yCheck, consoleCheck];
const VIEWPORT_POST_SHOT_CHECKS = [aestheticCheck];
const PAGE_CHECKS = [metaCheck, copyCheck];

function parseArgs(argv) {
  const args = {
    url: null, viewports: 'default', out: null, 'delay-ms': '0',
    vision: null, 'vision-model': null, 'vision-host': 'http://localhost:11434',
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Boolean flags
    if (a === '--vision') { args.vision = 'ollama'; continue; }
    if (a === '--yes' || a === '-y') { args.yes = true; continue; }
    const [key, val] = a.startsWith('--') ? a.slice(2).split('=') : [null, null];
    if (!key) continue;
    if (val !== undefined) args[key] = val;
    else args[key] = argv[++i];
  }
  return args;
}

function resolveVisionConfig(args) {
  if (!args.vision) return null;
  const raw = String(args.vision).toLowerCase();
  const isApi = raw === 'api' || raw === 'anthropic';
  const backend = isApi ? 'api' : 'ollama';
  const model = args['vision-model'] || (isApi ? 'claude-haiku-4-5-20251001' : 'llama3.2-vision');
  return { backend, model, host: args['vision-host'] };
}

async function confirmApiRun({ url, viewports, vision, skip }) {
  const count = viewports.length;
  // Rough order-of-magnitude estimate: ~1.5–3k input tokens per viewport
  // (JPEG ~500–1500 image tokens depending on size, ~500 cached system prompt,
  // ~50 user text) plus ~150 output tokens. Haiku 4.5 approx pricing:
  // $1/MTok input, $5/MTok output.
  const estInputTokens = count * 2500;
  const estOutputTokens = count * 150;
  const estGBP = ((estInputTokens * 1.0 + estOutputTokens * 5.0) / 1_000_000) * 0.78;  // USD → GBP rough

  output.write('\n');
  output.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  output.write(`  Anthropic API vision pass\n`);
  output.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  output.write(`  URL:        ${url}\n`);
  output.write(`  Viewports:  ${count} (${viewports.map((v) => v.id).join(', ')})\n`);
  output.write(`  Model:      ${vision.model}\n`);
  output.write(`  Est. cost:  ~£${estGBP.toFixed(3)}  (rough; verify on anthropic.com/pricing)\n`);
  output.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (skip) { output.write('  --yes flag set, skipping confirmation.\n\n'); return true; }
  if (!input.isTTY) { output.write('  stdin is not a TTY; use --yes to confirm programmatically.\n\n'); return false; }

  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question('  Proceed? [y/N] ')).trim().toLowerCase();
  rl.close();
  output.write('\n');
  return answer === 'y' || answer === 'yes';
}

async function run() {
  await loadDotenv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: npm run audit -- --url <url> [--viewports=default|all|id,id] [--out <dir>]');
    process.exit(1);
  }

  const viewports = resolveViewports(args.viewports);
  const vision = resolveVisionConfig(args);

  // Fail fast if API vision is requested without a key.
  if (vision?.backend === 'api' && !process.env.ANTHROPIC_API_KEY) {
    console.error('\nERROR: --vision=api requires ANTHROPIC_API_KEY.');
    console.error('       Either export it in your shell or add it to a .env file at the project root:');
    console.error('         echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env\n');
    process.exit(1);
  }

  // API-backed vision incurs real cost — require explicit consent per run.
  if (vision?.backend === 'api') {
    const ok = await confirmApiRun({ url: args.url, viewports, vision, skip: args.yes });
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }

  const startedAt = now();
  const outRoot = args.out || path.resolve(__dirname, '..', 'audit-runs', startedAt);
  const shotsDir = path.join(outRoot, 'screenshots');
  await ensureDir(shotsDir);

  console.log(`\n▶ Responsive audit\n  URL: ${args.url}\n  Viewports: ${viewports.map((v) => v.id).join(', ')}${vision ? `\n  Vision: ${vision.backend} (${vision.model})` : ''}\n  Output: ${outRoot}\n`);

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
          vision: vision ? { ...vision, screenshotPath: shotPath } : null,
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
