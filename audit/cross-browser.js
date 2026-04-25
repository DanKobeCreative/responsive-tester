#!/usr/bin/env node
// Cross-browser screenshot runner. Spawned by the desktop app's Rust
// side (src-tauri/src/qa.rs); reads a JSON config from stdin; emits
// newline-delimited JSON progress / result / error lines on stdout
// so the Tauri command can stream them to the frontend as events.
//
// Usage when run by hand for development:
//   echo '{"url":"https://example.com","viewportIds":["iphone-16","macbook-air-13"],"engines":["chromium","firefox","webkit"],"outputDir":"/tmp/rt-xb-test","fullPage":true}' \
//     | node audit/cross-browser.js
//
// Engines are launched in parallel (one Promise per engine). Within an
// engine, viewports are captured sequentially to keep memory predictable.
// An (engine, viewport) failure is logged as {type:"error",...} but does
// not abort the rest of the run.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import { chromium, firefox, webkit } from 'playwright';

import { ALL_VIEWPORTS } from './lib/viewports.js';
import { gotoStable, triggerScrollAnimations } from './lib/playwright.js';

const ENGINES = { chromium, firefox, webkit };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJson() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  if (!raw.trim()) throw new Error('No config received on stdin.');
  return JSON.parse(raw);
}

function resolveViewports(ids) {
  const map = new Map(ALL_VIEWPORTS.map((v) => [v.id, v]));
  const hits = ids.map((id) => map.get(id)).filter(Boolean);
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) throw new Error(`Unknown viewport id(s): ${missing.join(', ')}`);
  if (!hits.length) throw new Error('No viewports selected.');
  return hits;
}

async function captureEngine(engineName, viewports, config) {
  const launcher = ENGINES[engineName];
  if (!launcher) {
    emit({ type: 'error', engine: engineName, viewport: null, message: `Unknown engine: ${engineName}` });
    return;
  }

  let browser;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (e) {
    emit({ type: 'error', engine: engineName, viewport: null, message: `Engine launch failed: ${e.message}` });
    return;
  }

  const engineDir = path.join(config.outputDir, engineName);
  await fs.mkdir(engineDir, { recursive: true });

  try {
    for (const v of viewports) {
      emit({ type: 'progress', engine: engineName, viewport: v.id, status: 'capturing' });

      const contextOpts = {
        viewport: { width: v.w, height: v.h },
        deviceScaleFactor: 1,
        // isMobile is Chromium-only; Firefox throws if it's set at all,
        // WebKit silently ignores it. hasTouch works everywhere.
        ...(engineName === 'chromium' && v.type === 'mobile' ? { isMobile: true } : {}),
        ...(v.type !== 'desktop' ? { hasTouch: true } : {}),
      };
      if (config.auth?.username) {
        contextOpts.httpCredentials = {
          username: config.auth.username,
          password: config.auth.password ?? '',
        };
      }

      let context, page;
      try {
        context = await browser.newContext(contextOpts);
        page = await context.newPage();
        await gotoStable(page, config.url);
        await triggerScrollAnimations(page);
        const shotPath = path.join(engineDir, `${v.id}.png`);
        await page.screenshot({ path: shotPath, fullPage: config.fullPage !== false });
        emit({
          type: 'result',
          engine: engineName,
          viewport: v.id,
          path: shotPath,
          width: v.w,
          height: v.h,
        });
      } catch (e) {
        emit({ type: 'error', engine: engineName, viewport: v.id, message: e.message });
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function run() {
  const config = await readStdinJson();
  if (!config.url) throw new Error('Config missing "url".');
  if (!Array.isArray(config.viewportIds) || !config.viewportIds.length) throw new Error('Config missing "viewportIds".');
  if (!Array.isArray(config.engines) || !config.engines.length) throw new Error('Config missing "engines".');
  if (!config.outputDir) throw new Error('Config missing "outputDir".');

  const viewports = resolveViewports(config.viewportIds);
  await fs.mkdir(config.outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const total = viewports.length * config.engines.length;
  emit({ type: 'start', total, viewports: viewports.map((v) => v.id), engines: config.engines, startedAt });

  // Engines in parallel, viewports sequential within each engine.
  await Promise.all(config.engines.map((engine) => captureEngine(engine, viewports, config)));

  // Manifest pairs the sanitised filenames back to display names so the
  // UI doesn't need to re-query the viewport catalogue.
  const manifest = {
    url: config.url,
    startedAt,
    finishedAt: new Date().toISOString(),
    fullPage: config.fullPage !== false,
    engines: config.engines,
    viewports: viewports.map((v) => ({ id: v.id, name: v.name, width: v.w, height: v.h, type: v.type })),
  };
  await fs.writeFile(path.join(config.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  emit({ type: 'complete', total, outputDir: config.outputDir });
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
