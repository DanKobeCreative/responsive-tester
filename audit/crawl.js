#!/usr/bin/env node
// Same-origin BFS crawler. Spawned by the desktop app's Rust side
// (src-tauri/src/qa.rs); reads a JSON config from stdin; emits NDJSON
// per page on stdout so the Tauri command can stream progress events
// to the frontend.
//
// Used by the Pre-Launch tab to populate the page-list before the user
// kicks off the per-page audit.

import { stdin } from 'node:process';
import { chromium } from 'playwright';
import { gotoStable } from './lib/playwright.js';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function readStdinJson() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  if (!raw.trim()) throw new Error('No config received on stdin.');
  return JSON.parse(raw);
}

function normaliseUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    // Strip trailing slash for dedup, except on the root path.
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch { return null; }
}

function matchesAny(patterns, url) {
  if (!patterns?.length) return false;
  return patterns.some((p) => url.includes(p));
}

async function run() {
  const config = await readStdinJson();
  if (!config.startUrl) throw new Error('Config missing "startUrl".');
  const maxPages = config.maxPages ?? 50;
  const exclude = config.excludePatterns ?? ['/wp-admin', '/wp-login', '/wp-json', '/feed/', '/?p='];
  const startOrigin = new URL(config.startUrl).origin;

  const contextOpts = {};
  if (config.auth?.username) {
    contextOpts.httpCredentials = {
      username: config.auth.username,
      password: config.auth.password ?? '',
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  const visited = new Set();
  const queue = [normaliseUrl(config.startUrl, config.startUrl)];
  const pages = [];

  emit({ type: 'crawl-start', startUrl: config.startUrl, maxPages });

  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);
      if (matchesAny(exclude, url)) continue;
      if (new URL(url).origin !== startOrigin) continue;

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const status = response?.status() || 0;
        const title = await page.title().catch(() => '');
        pages.push({ url, status, title });
        emit({ type: 'page-crawled', url, status, title, total: pages.length });

        if (status >= 200 && status < 400) {
          const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')))
            .catch(() => []);
          for (const href of hrefs) {
            const next = normaliseUrl(href, url);
            if (next && !visited.has(next)) queue.push(next);
          }
        }
      } catch (e) {
        emit({ type: 'page-error', url, message: e.message });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  emit({ type: 'crawl-complete', total: pages.length, pages });
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
