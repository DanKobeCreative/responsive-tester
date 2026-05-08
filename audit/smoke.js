#!/usr/bin/env node
// Smoke test for the live-session sidecar. For each engine + a sample
// narrow + sample wide viewport: spawns live-session.js, sends a config
// over stdin, asserts `session-ready` emits without a preceding fatal,
// then asserts the rendered viewport (window.innerWidth) matches the
// target. Catches:
//   1. Playwright option-combo crashes (e.g. v0.10.20 deviceScaleFactor
//      + viewport: null regression that silently fataled every Chromium
//      session).
//   2. Emulation drift — the page laying out at the OS-window width
//      instead of the requested viewport.
// Does NOT verify OS window width: that's blocked by per-engine UI
// minimums on macOS (Chromium ~500 unless app-mode, Firefox ~500 with
// no equivalent escape). Whitespace from a wider-than-target OS window
// is a known engine constraint, not a bug we can detect/fix.
//
// Runtime: ~30s for the full matrix on a warm machine.
// Exit code: 0 = all passed, 1 = any failed.
//
// Run via:
//   cd audit && node smoke.js
// Wired into pre-push (.githooks/pre-push) and CI (release.yml).

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_SESSION = resolve(HERE, 'live-session.js');

// One narrow + one wide per engine. Narrow exercises the app-mode /
// minimum-window-width path; wide exercises the regular launch + CDP
// override path. about:blank avoids any external network dependency.
const TESTS = [
  { engine: 'chromium', viewport: { id: 'sr-narrow-320', width: 320,  height: 640,  type: 'mobile' } },
  { engine: 'chromium', viewport: { id: 'sr-md-768',     width: 768,  height: 1024, type: 'tablet' } },
  { engine: 'firefox',  viewport: { id: 'sr-narrow-320', width: 320,  height: 640,  type: 'mobile' } },
  { engine: 'firefox',  viewport: { id: 'sr-md-768',     width: 768,  height: 1024, type: 'tablet' } },
  { engine: 'webkit',   viewport: { id: 'sr-narrow-320', width: 320,  height: 640,  type: 'mobile' } },
  { engine: 'webkit',   viewport: { id: 'sr-md-768',     width: 768,  height: 1024, type: 'tablet' } },
];

const READY_TIMEOUT_MS = 20_000;

function killPlaywrightDescendants() {
  // Best-effort: any orphaned playwright browser processes from a failed
  // test would otherwise block the next test by hogging file handles.
  spawnSync('pkill', ['-f', 'ms-playwright/'], { stdio: 'ignore' });
}

// data: URL instead of about:blank: Chromium's --app= flag falls back
// to a regular browser window for special URLs like about:blank, which
// defeats the very narrow-window path we're trying to verify. A data:
// URL is treated as a real navigable target so app-mode sticks.
const SMOKE_URL = 'data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><title>smoke</title>';

async function runOne({ engine, viewport }) {
  const config = {
    engine,
    url: SMOKE_URL,
    viewport,
    position: { x: 50, y: 80 },
  };

  return new Promise((resolve) => {
    const child = spawn('node', [LIVE_SESSION], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(killPlaywrightDescendants, 200);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'fatal' || msg.type === 'session-error') {
          return finish({ ok: false, reason: `${msg.type}: ${msg.message}` });
        }
        if (msg.type === 'session-ready') {
          // Tolerate a few px (toolbar / scrollbar offsets in some engines).
          if (msg.renderedWidth != null) {
            const drift = Math.abs(msg.renderedWidth - config.viewport.width);
            if (drift > 5) {
              return finish({ ok: false, reason: `rendered ${msg.renderedWidth}px, target ${config.viewport.width}px (drift ${drift})` });
            }
            return finish({ ok: true, rendered: msg.renderedWidth });
          }
          return finish({ ok: true, rendered: '?' });
        }
      }
    });

    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('exit', (code) => {
      if (!resolved) finish({ ok: false, reason: `exited code=${code} before session-ready. stderr: ${stderr.slice(0, 500)}` });
    });

    setTimeout(() => finish({ ok: false, reason: `timeout after ${READY_TIMEOUT_MS}ms` }), READY_TIMEOUT_MS);

    child.stdin.write(JSON.stringify(config) + '\n');
  });
}

async function main() {
  console.log(`[smoke] running ${TESTS.length} engine/viewport combinations\n`);
  const results = [];
  for (const test of TESTS) {
    process.stdout.write(`[smoke] ${test.engine.padEnd(8)} ${test.viewport.id.padEnd(20)} ... `);
    const result = await runOne(test);
    results.push({ test, result });
    if (result.ok) {
      console.log(`PASS  rendered=${result.rendered}px`);
    } else {
      console.log(`FAIL — ${result.reason}`);
    }
    // Brief pause between launches so Playwright's process trees fully wind down.
    await new Promise((r) => setTimeout(r, 500));
  }

  killPlaywrightDescendants();

  const failed = results.filter((r) => !r.result.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) {
      console.log(`  ${f.test.engine} ${f.test.viewport.id}: ${f.result.reason}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] unexpected error:', err);
  killPlaywrightDescendants();
  process.exit(1);
});
