#!/usr/bin/env node
// Pre-launch audit runner. Spawned by the desktop app's Rust side
// (src-tauri/src/qa.rs); reads a JSON config from stdin describing a
// list of pages to check; runs SEO / a11y / performance / link / console
// checks per page plus an optional Lighthouse pass; emits NDJSON
// progress + per-page results on stdout.
//
// Reuses the existing audit/checks/* modules where applicable so we
// don't duplicate parsing logic. Lighthouse is Chromium-only and runs
// once per page (not per viewport).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import { chromium } from 'playwright';
import { gotoStable } from './lib/playwright.js';

import metaCheck from './checks/meta.js';
import a11yCheck from './checks/a11y.js';
import consoleCheck from './checks/console.js';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function readStdinJson() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  if (!raw.trim()) throw new Error('No config received on stdin.');
  return JSON.parse(raw);
}

// Title / description length checks per Google guidance.
function checkTitle(meta) {
  const findings = [];
  if (!meta.title) findings.push({ category: 'seo', check: 'title', status: 'fail', detail: 'Missing <title>' });
  else if (meta.title.length > 60) findings.push({ category: 'seo', check: 'title-length', status: 'warn', detail: `Title is ${meta.title.length} chars (>60)` });
  else findings.push({ category: 'seo', check: 'title', status: 'pass', detail: `${meta.title.length} chars` });
  return findings;
}

function checkDescription(meta) {
  const findings = [];
  const desc = meta.description || '';
  if (!desc) findings.push({ category: 'seo', check: 'description', status: 'fail', detail: 'Missing meta description' });
  else if (desc.length > 160) findings.push({ category: 'seo', check: 'description-length', status: 'warn', detail: `Description is ${desc.length} chars (>160)` });
  else findings.push({ category: 'seo', check: 'description', status: 'pass', detail: `${desc.length} chars` });
  return findings;
}

function checkOpenGraph(meta) {
  const findings = [];
  const has = (k) => meta.og && meta.og[k];
  for (const tag of ['title', 'description', 'image']) {
    findings.push({
      category: 'seo',
      check: `og-${tag}`,
      status: has(tag) ? 'pass' : 'warn',
      detail: has(tag) ? meta.og[tag].slice(0, 80) : `Missing og:${tag}`,
    });
  }
  return findings;
}

function checkBasics(meta) {
  const findings = [];
  findings.push({ category: 'seo', check: 'canonical', status: meta.canonical ? 'pass' : 'warn', detail: meta.canonical || 'Missing canonical link' });
  findings.push({ category: 'seo', check: 'lang',      status: meta.lang ? 'pass' : 'warn', detail: meta.lang || 'Missing <html lang>' });
  findings.push({ category: 'seo', check: 'viewport',  status: meta.viewport ? 'pass' : 'fail', detail: meta.viewport || 'Missing viewport meta' });
  if (/noindex/i.test(meta.robots || '')) findings.push({ category: 'seo', check: 'noindex', status: 'fail', detail: 'Page is marked noindex' });
  if (meta.h1s.length === 0) findings.push({ category: 'a11y', check: 'h1-count', status: 'fail', detail: 'No <h1> heading' });
  else if (meta.h1s.length > 1) findings.push({ category: 'a11y', check: 'h1-count', status: 'warn', detail: `${meta.h1s.length} <h1> headings` });
  else findings.push({ category: 'a11y', check: 'h1-count', status: 'pass', detail: '1 <h1>' });
  return findings;
}

async function checkImages(page) {
  const imgs = await page.$$eval('img', (els) => els.map((i) => ({
    src: i.currentSrc || i.src,
    alt: i.alt,
    width: i.getAttribute('width'),
    height: i.getAttribute('height'),
  })));
  const findings = [];
  const noAlt = imgs.filter((i) => !i.alt);
  if (noAlt.length) findings.push({ category: 'a11y', check: 'img-alt', status: 'fail', detail: `${noAlt.length} <img> tag(s) missing alt` });
  else findings.push({ category: 'a11y', check: 'img-alt', status: 'pass', detail: `${imgs.length} images, all with alt` });
  const noDims = imgs.filter((i) => !i.width || !i.height);
  if (noDims.length) findings.push({ category: 'perf', check: 'img-dims', status: 'warn', detail: `${noDims.length} <img> tag(s) missing width/height (CLS risk)` });
  return findings;
}

async function checkSiteWide(startUrl) {
  const findings = [];
  const origin = new URL(startUrl).origin;
  for (const [name, urlPath] of [['robots-txt', '/robots.txt'], ['sitemap-xml', '/sitemap.xml'], ['favicon', '/favicon.ico']]) {
    try {
      const res = await fetch(origin + urlPath, { method: 'HEAD' });
      findings.push({
        category: 'seo',
        check: name,
        status: res.ok ? 'pass' : 'warn',
        detail: `HTTP ${res.status} on ${urlPath}`,
      });
    } catch (e) {
      findings.push({ category: 'seo', check: name, status: 'warn', detail: e.message });
    }
  }
  return findings;
}

async function runLighthouse(url) {
  let lighthouse;
  let chromeLauncher;
  try {
    lighthouse = (await import('lighthouse')).default;
    chromeLauncher = await import('chrome-launcher');
  } catch (e) {
    return { error: `Lighthouse unavailable: ${e.message}` };
  }

  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new'] }).catch((e) => {
    throw new Error(`chrome-launcher failed: ${e.message}. Make sure Google Chrome is installed.`);
  });

  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
      output: 'json',
      logLevel: 'error',
    });
    const cats = result.lhr.categories;
    const audits = result.lhr.audits;
    return {
      scores: {
        performance: Math.round((cats.performance?.score ?? 0) * 100),
        accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
        seo: Math.round((cats.seo?.score ?? 0) * 100),
        bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
      },
      coreWebVitals: {
        lcp: audits['largest-contentful-paint']?.numericValue ?? null,
        cls: audits['cumulative-layout-shift']?.numericValue ?? null,
        tbt: audits['total-blocking-time']?.numericValue ?? null,
      },
    };
  } finally {
    await chrome.kill().catch(() => {});
  }
}

async function runOnePage(browser, url, runLh, idx, total) {
  emit({ type: 'prelaunch-page-start', url, pageIndex: idx, totalPages: total });

  const consoleErrors = [];
  const networkErrors = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ text: m.text(), location: m.location() });
  });
  page.on('pageerror', (err) => consoleErrors.push({ text: err.message }));
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'failed';
    if (failure === 'net::ERR_ABORTED') return;
    networkErrors.push({ url: req.url(), failure });
  });

  let findings = [];
  let lighthouseResult = null;

  try {
    await gotoStable(page, url);

    // Reuse the existing meta-check module via its exported function.
    try {
      const metaFindings = await metaCheck(page);
      findings.push(...metaFindings.map((f) => ({ category: 'seo', check: f.check ?? 'meta', status: severityToStatus(f.severity), detail: f.message })));
    } catch (e) {
      findings.push({ category: 'seo', check: 'meta-runner', status: 'fail', detail: e.message });
    }

    // Inline check helpers for the new SEO/perf items the existing
    // checks module doesn't cover.
    const meta = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
      lang: document.documentElement.getAttribute('lang') ?? '',
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
      robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '',
      h1s: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
      og: {
        title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
        description: document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '',
        image: document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '',
      },
    }));
    findings.push(...checkTitle(meta));
    findings.push(...checkDescription(meta));
    findings.push(...checkBasics(meta));
    findings.push(...checkOpenGraph(meta));
    findings.push(...await checkImages(page));

    // a11y via the existing axe-core check.
    try {
      const a11yFindings = await a11yCheck(page);
      findings.push(...a11yFindings.map((f) => ({ category: 'a11y', check: f.check ?? 'axe', status: severityToStatus(f.severity), detail: f.message })));
    } catch (e) {
      findings.push({ category: 'a11y', check: 'axe-runner', status: 'fail', detail: e.message });
    }

    // Console / network errors collected during navigation.
    if (consoleErrors.length) findings.push({ category: 'console', check: 'errors', status: 'fail', detail: `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 2).map((e) => e.text).join('; ')}` });
    else findings.push({ category: 'console', check: 'errors', status: 'pass', detail: 'No console errors' });
    if (networkErrors.length) findings.push({ category: 'console', check: 'network', status: 'warn', detail: `${networkErrors.length} failed request(s)` });

    if (runLh) {
      try {
        lighthouseResult = await runLighthouse(url);
        if (lighthouseResult.scores) {
          emit({
            type: 'prelaunch-lighthouse',
            url,
            scores: lighthouseResult.scores,
            coreWebVitals: lighthouseResult.coreWebVitals,
          });
        } else if (lighthouseResult.error) {
          findings.push({ category: 'lighthouse', check: 'runner', status: 'warn', detail: lighthouseResult.error });
        }
      } catch (e) {
        findings.push({ category: 'lighthouse', check: 'runner', status: 'warn', detail: e.message });
      }
    }
  } catch (e) {
    findings.push({ category: 'runner', check: 'navigation', status: 'fail', detail: e.message });
  } finally {
    await context.close().catch(() => {});
  }

  for (const f of findings) emit({ type: 'prelaunch-check', url, ...f });

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.status === 'fail' ? 'fail' : f.status === 'warn' ? 'warn' : 'pass']++;
  emit({ type: 'prelaunch-page-complete', url, ...counts, lighthouseScores: lighthouseResult?.scores ?? null });
  return { url, counts, findings, lighthouse: lighthouseResult };
}

function severityToStatus(sev) {
  if (sev === 'error') return 'fail';
  if (sev === 'warning') return 'warn';
  return 'pass';
}

async function run() {
  const config = await readStdinJson();
  if (!Array.isArray(config.pages) || !config.pages.length) throw new Error('Config missing "pages".');
  await fs.mkdir(config.outputDir ?? '/tmp/rt-prelaunch', { recursive: true });

  const browser = await chromium.launch({ headless: true });
  emit({ type: 'prelaunch-start', totalPages: config.pages.length, runLighthouse: !!config.runLighthouse });

  let totals = { pass: 0, warn: 0, fail: 0 };
  const allResults = [];
  try {
    for (let i = 0; i < config.pages.length; i++) {
      const r = await runOnePage(browser, config.pages[i], !!config.runLighthouse, i + 1, config.pages.length);
      allResults.push(r);
      totals.pass += r.counts.pass;
      totals.warn += r.counts.warn;
      totals.fail += r.counts.fail;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Site-wide checks (run once, not per page).
  const siteWide = await checkSiteWide(config.pages[0]);
  for (const f of siteWide) emit({ type: 'prelaunch-check', url: '__site__', ...f });

  emit({
    type: 'prelaunch-complete',
    totalPages: config.pages.length,
    totalChecks: totals.pass + totals.warn + totals.fail,
    totalPassed: totals.pass,
    totalWarnings: totals.warn,
    totalFailed: totals.fail,
  });
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
