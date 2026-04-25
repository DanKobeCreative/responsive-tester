#!/usr/bin/env node
// Live (non-headless) browser session for QA Session mode. Spawned by
// the desktop app's Rust side (src-tauri/src/qa.rs); reads a JSON
// config from stdin once, emits a `session-ready` line on stdout when
// the browser is up, then keeps stdin open and accepts navigate
// commands as newline-delimited JSON until the parent kills the
// process group or stdin closes.
//
// Companion to audit/cross-browser.js — same shape, but headed and
// long-lived. Window position can be supplied by the caller (Chromium
// honours --window-position, Firefox honours -window-position; WebKit
// has no equivalent flag and lands at the macOS default).

import { stdin } from 'node:process';
import { chromium, firefox, webkit } from 'playwright';

import { gotoStable, triggerScrollAnimations } from './lib/playwright.js';

const ENGINES = { chromium, firefox, webkit };

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJsonOnce() {
  // Read one JSON object up to the first newline (the parent writes
  // the config followed by `\n`, then leaves stdin open for navigate
  // commands).
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      stdin.off('data', onData);
      const line = buf.slice(0, nl);
      const rest = buf.slice(nl + 1);
      if (rest) stdin.unshift(rest);
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    };
    stdin.on('data', onData);
    stdin.once('error', reject);
  });
}

function launchArgsFor(engineName, position) {
  const args = [];
  if (!position) return args;
  if (engineName === 'chromium') {
    args.push(`--window-position=${position.x},${position.y}`);
  } else if (engineName === 'firefox') {
    // Firefox launch in Playwright accepts -window-position via firefoxUserPrefs
    // is not the path; the CLI flag form is two-arg `-width X -height Y`. There
    // is no documented position flag — rely on the OS default for Firefox too
    // and accept manual repositioning by the user. (See plan note: WebKit AND
    // Firefox both fall back to OS default; Chromium is the only one that
    // reliably honours window-position from Playwright.)
  }
  // WebKit: no positional flag.
  return args;
}

async function navigate(page, url) {
  await gotoStable(page, url);
  await triggerScrollAnimations(page);
  // Critical on macOS: a Playwright-launched window opens behind the
  // Tauri app by default. bringToFront() pops it to the user.
  try { await page.bringToFront(); } catch { /* best-effort */ }
}

async function run() {
  const config = await readStdinJsonOnce();
  if (!config.url) throw new Error('Config missing "url".');
  if (!config.engine) throw new Error('Config missing "engine".');
  if (!config.viewport) throw new Error('Config missing "viewport".');

  const launcher = ENGINES[config.engine];
  if (!launcher) throw new Error(`Unknown engine: ${config.engine}`);

  const browser = await launcher.launch({
    headless: false,
    args: launchArgsFor(config.engine, config.position),
  });

  const contextOpts = {
    viewport: { width: config.viewport.width, height: config.viewport.height },
    deviceScaleFactor: 1,
    ...(config.engine === 'chromium' && config.viewport.type === 'mobile' ? { isMobile: true } : {}),
    ...(config.viewport.type !== 'desktop' ? { hasTouch: true } : {}),
  };
  if (config.auth?.username) {
    contextOpts.httpCredentials = {
      username: config.auth.username,
      password: config.auth.password ?? '',
    };
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Surface tab close as session end so the Rust side can update the UI.
  page.on('close', () => {
    emit({ type: 'session-page-closed' });
    cleanup().catch(() => {});
  });

  await navigate(page, config.url);

  emit({
    type: 'session-ready',
    engine: config.engine,
    viewport: config.viewport.id,
    pid: process.pid,
  });

  // Accept newline-delimited JSON commands on stdin for the rest of the
  // session lifetime. Currently only `navigate` is defined.
  let buffer = '';
  stdin.on('data', async (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let cmd;
      try { cmd = JSON.parse(line); }
      catch (e) { emit({ type: 'session-error', message: `Bad command JSON: ${e.message}` }); continue; }
      try {
        if (cmd.type === 'navigate' && cmd.url) {
          await navigate(page, cmd.url);
          emit({ type: 'session-navigated', url: cmd.url });
        } else {
          emit({ type: 'session-error', message: `Unknown command type: ${cmd.type}` });
        }
      } catch (e) {
        emit({ type: 'session-error', message: e.message ?? String(e) });
      }
    }
  });

  let cleaningUp = false;
  async function cleanup() {
    if (cleaningUp) return;
    cleaningUp = true;
    try { await browser.close(); } catch { /* already closing */ }
    process.exit(0);
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  stdin.on('end', cleanup);
  // Keep the event loop alive (the stdin listener does this implicitly,
  // but be explicit in case future refactors detach it).
  stdin.resume();
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
