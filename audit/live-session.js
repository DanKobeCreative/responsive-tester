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
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, firefox, webkit } from 'playwright';

import { gotoStable } from './lib/playwright.js';

const ENGINES = { chromium, firefox, webkit };

// Set up a one-shot Firefox profile with userChrome.css that strips the
// XUL #main-window min-width rule. This is the kevincox.ca trick — once
// the XUL min-width is gone, nsCocoaWindow::SetSizeConstraints plumbs a
// tiny minSize down to AppKit, and -width/-height args actually take
// effect on small viewports. No Accessibility permission needed; no AX
// resize needed downstream.
async function prepareFirefoxProfile() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'rt-ff-profile-'));
  const chromeDir = path.join(profileDir, 'chrome');
  await mkdir(chromeDir, { recursive: true });
  await writeFile(
    path.join(chromeDir, 'userChrome.css'),
    ':root { min-width: 1rem !important; }\n',
    'utf8',
  );
  await writeFile(
    path.join(profileDir, 'user.js'),
    'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);\n',
    'utf8',
  );
  return profileDir;
}

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

function launchArgsFor(engineName, position, fit, viewport) {
  const args = [];
  // OS window size — match the (possibly fitted) viewport. Chrome's
  // macOS minimum window width (~500px) will clamp this on small
  // mobile viewports; CDP centering downstream handles the resulting
  // gap. For viewports ≥ the platform minimum, this gives a tight
  // viewport-matching window.
  const win = fit?.scaledWindow || { width: viewport.width, height: viewport.height };
  if (engineName === 'chromium') {
    if (position) args.push(`--window-position=${position.x},${position.y}`);
    args.push(`--window-size=${win.width},${win.height + 90}`);
  } else if (engineName === 'firefox') {
    args.push('-width', String(win.width), '-height', String(win.height + 80));
  }
  return args;
}

// Decide whether the launched window will overflow the host display, and
// if so what scale factor brings it within the available area. Returns
// null when the viewport fits as-is (no scaling needed).
function computeFit(viewport, config) {
  if (!config.fitToScreen) return null;
  const screenW = Number(config.screenWidth) || 0;
  const screenH = Number(config.screenHeight) || 0;
  if (!screenW || !screenH) return null;
  if (viewport.width <= screenW && viewport.height <= screenH) return null;
  // 0.92 leaves a small margin so the window doesn't bump into the menu
  // bar / dock. Round the scale to 2 dp for predictability.
  const raw = Math.min(screenW / viewport.width, screenH / viewport.height) * 0.92;
  const scale = Math.round(raw * 100) / 100;
  return {
    scale,
    scaledWindow: {
      width: Math.round(viewport.width * scale),
      height: Math.round(viewport.height * scale),
    },
  };
}

async function navigate(page, url) {
  await gotoStable(page, url);
  // Deliberately NOT calling triggerScrollAnimations() here. That helper
  // exists to pre-warm scroll-revealed content before a headless
  // screenshot. In a headed live session the user will scroll manually,
  // and pre-scrolling either (a) fires ScrollTrigger before the page's
  // own JS has registered its triggers (leaving them in a broken state
  // until reload — observed in WebKit), or (b) shows a visible
  // jump-to-bottom-and-back the user has to clear with a reload. The
  // headed use case wants the page exactly as the user would see it.
  try { await page.bringToFront(); } catch { /* best-effort */ }
}

// page.bringToFront() only switches Playwright's intra-browser tab focus.
// On macOS we additionally need to activate the browser process at the
// OS level — otherwise the new window opens behind the Tauri app and
// the user has to alt-tab to find it.
//
// AppleScript via "System Events" requires Automation/Accessibility
// permission (granted via System Settings → Privacy & Security). Many
// installs never see that prompt, so we try the more reliable
// `open -a <appPath>` first — it routes through Launch Services and
// doesn't need any privacy permission.
function sleepSync(ms) {
  spawnSync('sleep', [String(ms / 1000)], { stdio: 'ignore' });
}

function findBrowserPid(engineName) {
  // Patterns vary by Playwright version + engine. -n returns the newest
  // matching PID, which is the one we just spawned.
  const patterns = {
    chromium: ['Chromium.app/Contents/MacOS/Chromium', 'ms-playwright/chromium'],
    firefox:  ['Nightly.app/Contents/MacOS/firefox', 'ms-playwright/firefox'],
    webkit:   ['Playwright.app/Contents/MacOS/Playwright', 'ms-playwright/webkit'],
  }[engineName] || [`ms-playwright/${engineName}`];
  for (const pattern of patterns) {
    const find = spawnSync('pgrep', ['-nf', pattern], { encoding: 'utf8' });
    const pid = (find.stdout || '').trim().split('\n')[0];
    if (pid && !Number.isNaN(Number(pid))) return Number(pid);
  }
  return null;
}

function appPathForPid(pid) {
  // `ps -o comm=` gives the full executable path. Walk up until we hit
  // the enclosing .app bundle so `open -a` can target it directly.
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  let p = (ps.stdout || '').trim();
  while (p && !p.endsWith('.app')) {
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return null;
    p = p.slice(0, idx);
  }
  return p && p.endsWith('.app') ? p : null;
}

// Force-resize the front window of the browser process via System Events.
// macOS allows windows down to 75x75 at the OS level — if Chrome / Firefox
// haven't asserted a setMinSize: on their NSWindow, this bypasses the
// engine's UI-side clamp and lets a 393-wide viewport actually live in
// a 393-wide window. Best-effort: silent if Accessibility permission
// isn't granted.
function resizeBrowserWindow(engineName, width, height) {
  if (process.platform !== 'darwin') return;
  const pid = findBrowserPid(engineName);
  if (!pid) return;
  try {
    spawnSync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to tell (first process whose unix id is ${pid}) to set size of window 1 to {${width}, ${height}}`,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // Accessibility permission missing or window not yet registered —
    // CDP centering downstream picks up the slack for Chromium.
  }
}

function activateBrowserApp(engineName) {
  if (process.platform !== 'darwin') return;
  // Window registration with the macOS window server is async after
  // process launch. A short delay before we ask to focus avoids racing
  // ahead of the window appearing.
  sleepSync(300);
  try {
    const pid = findBrowserPid(engineName);
    if (!pid) return;

    // Path 1: open -a — the friendliest route, no permissions needed.
    const appPath = appPathForPid(pid);
    if (appPath) {
      const r = spawnSync('open', ['-a', appPath], { stdio: 'ignore' });
      if (r.status === 0) return;
    }

    // Path 2: AppleScript fallback. Will be a no-op if Tauri lacks
    // Automation permission for "System Events", but harmless to try.
    spawnSync('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], { stdio: 'ignore' });
  } catch {
    // Best-effort. If neither path works the user can ⌘-Tab to the
    // browser manually.
  }
}

async function run() {
  const config = await readStdinJsonOnce();
  if (!config.url) throw new Error('Config missing "url".');
  if (!config.engine) throw new Error('Config missing "engine".');
  if (!config.viewport) throw new Error('Config missing "viewport".');

  const launcher = ENGINES[config.engine];
  if (!launcher) throw new Error(`Unknown engine: ${config.engine}`);

  // Fit-to-screen: when on and the viewport overflows the host display,
  // we shrink the rendered surface to fit. Chromium uses CDP scale +
  // --window-size; Firefox uses layout.css.devPixelsPerPx; WebKit has
  // no equivalent so we emit a warning and launch unscaled.
  const fit = computeFit(config.viewport, config);
  if (fit && config.engine === 'webkit') {
    emit({ type: 'session-warning', message: `WebKit doesn't support fit-to-screen; the ${config.viewport.width}×${config.viewport.height} window will overflow the display.` });
  }

  const launchOpts = {
    headless: false,
    args: launchArgsFor(config.engine, config.position, fit, config.viewport),
  };
  if (fit && config.engine === 'firefox') {
    // Fit-to-screen for Firefox: devPixelsPerPx scales the entire UI
    // rendering — a 2560-wide page rendered at 0.5 occupies 1280 device
    // pixels. devPixelsPerPx affects rendering density only, NOT window
    // size, so we can't use it to fix the sub-min-width gap on tiny
    // mobile viewports — that's accepted as a platform limitation.
    launchOpts.firefoxUserPrefs = {
      'layout.css.devPixelsPerPx': fit.scale.toString(),
    };
  }

  const contextOpts = {
    viewport: { width: config.viewport.width, height: config.viewport.height },
    // Retina-quality rendering. The previous 1x default produced soft
    // text on Retina-host displays and identically soft PNGs when
    // screenshotted.
    deviceScaleFactor: 2,
    ...(config.engine === 'chromium' && config.viewport.type === 'mobile' ? { isMobile: true } : {}),
    ...(config.viewport.type !== 'desktop' ? { hasTouch: true } : {}),
  };
  if (config.auth?.username) {
    contextOpts.httpCredentials = {
      username: config.auth.username,
      password: config.auth.password ?? '',
    };
  }

  // Firefox uses launchPersistentContext with a custom profile so we can
  // inject userChrome.css to remove the XUL min-width clamp. Other
  // engines launch normally and a fresh context is created.
  let browser = null;
  let context;
  let page;
  if (config.engine === 'firefox') {
    const profileDir = await prepareFirefoxProfile();
    context = await firefox.launchPersistentContext(profileDir, {
      ...launchOpts,
      ...contextOpts,
    });
    page = context.pages()[0] || await context.newPage();
  } else {
    browser = await launcher.launch(launchOpts);
    context = await browser.newContext(contextOpts);
    page = await context.newPage();
  }

  // Chromium fit-to-screen: scale rendering down for over-screen viewports.
  // Applied here (before navigate) so the page lays out at the right scale
  // from the first paint; centering for sub-min viewports is handled
  // post-resize below.
  if (fit && config.engine === 'chromium') {
    try {
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: config.viewport.width,
        height: config.viewport.height,
        deviceScaleFactor: 2,
        mobile: config.viewport.type !== 'desktop',
        scale: fit.scale,
      });
    } catch (err) {
      emit({ type: 'session-warning', message: `Chromium fit-to-screen failed: ${err.message ?? err}` });
    }
  }

  // Surface tab close as session end so the Rust side can update the UI.
  page.on('close', () => {
    emit({ type: 'session-page-closed' });
    cleanup().catch(() => {});
  });

  await navigate(page, config.url);
  // Initial OS-level activation. NOT repeated on later navigate commands
  // — yanking focus on every URL sync would feel obnoxious when the user
  // is intentionally working inside the Responsive Tester app.
  activateBrowserApp(config.engine);

  // Bypass Chrome's UI-side minimum window width via OS window-size
  // override. Firefox doesn't need this — userChrome.css already
  // removed its min-width clamp. WebKit has no clamp to bypass.
  if (!fit && config.engine === 'chromium') {
    resizeBrowserWindow(config.engine, config.viewport.width, config.viewport.height + 90);
  }

  // Chromium centering fallback — only if the OS window is still wider
  // than the viewport after the AppleScript resize attempt. Splits the
  // gap symmetrically so it reads as "device frame" rather than "page
  // stuck on the left of a wider window."
  if (!fit && config.engine === 'chromium') {
    try {
      const client = await context.newCDPSession(page);
      const { bounds } = await client.send('Browser.getWindowForTarget');
      const browserWidth = bounds?.width || config.viewport.width;
      if (browserWidth > config.viewport.width) {
        const x = Math.floor((browserWidth - config.viewport.width) / 2);
        await client.send('Emulation.setDeviceMetricsOverride', {
          width: config.viewport.width,
          height: config.viewport.height,
          deviceScaleFactor: 2,
          mobile: config.viewport.type !== 'desktop',
          viewport: { x, y: 0, width: config.viewport.width, height: config.viewport.height, scale: 1 },
        });
      }
    } catch (err) {
      emit({ type: 'session-warning', message: `Chromium centering failed: ${err.message ?? err}` });
    }
  }

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
        } else if (cmd.type === 'screenshot' && cmd.path) {
          // Briefly hand focus back to the browser tab so any
          // hover/scroll-driven UI lands in a stable state, then capture.
          // Don't bringToFront() — the user is in the Tauri app driving
          // the screenshot button; pulling focus away is jarring.
          await page.screenshot({ path: cmd.path, fullPage: !!cmd.fullPage });
          emit({
            type: 'screenshot-saved',
            path: cmd.path,
            fullPage: !!cmd.fullPage,
            engine: config.engine,
            viewport: config.viewport.id,
          });
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
    try {
      // launchPersistentContext (Firefox) owns its browser internally;
      // closing the context tears the browser down too. launch() (other
      // engines) requires closing the browser handle directly.
      if (browser) await browser.close();
      else if (context) await context.close();
    } catch { /* already closing */ }
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
