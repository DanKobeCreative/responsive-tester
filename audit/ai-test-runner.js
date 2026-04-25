#!/usr/bin/env node
// AI test generator + executor. Two phases:
//
//   1. generate: Take a natural-language test description from the user
//      plus URL / engine / viewport context, ask Claude (haiku-4.5) to
//      produce a self-contained Playwright ESM script.
//   2. execute: Validate the generated script against an explicit allow-
//      list (ESM imports of 'playwright' only — no fs / child_process /
//      eval / Function / non-target-domain navigation), write it to a
//      temp .mjs file, spawn it as a child process, and stream its
//      structured stdout back to the parent.
//
// Both phases run in this single process; the parent (Rust) talks to
// it via stdin JSON. Mode switch is config.mode = "generate" | "execute".

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import Anthropic from '@anthropic-ai/sdk';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function readStdinJson() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  if (!raw.trim()) throw new Error('No config received on stdin.');
  return JSON.parse(raw);
}

function loadDotenv(projectRoot) {
  // Lightweight .env loader, same pattern as audit/run.js, so we don't
  // pull in the dotenv dep just for this.
  return fs.readFile(path.join(projectRoot, '.env'), 'utf8')
    .then((raw) => {
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (process.env[k]) continue;
        process.env[k] = v.trim().replace(/^["']|["']$/g, '');
      }
    })
    .catch(() => { /* no .env, fall through to env vars */ });
}

function systemPrompt({ url, engine, width, height, outputDir }) {
  return `You are a Playwright test code generator for cross-browser QA testing of websites.

Target URL: ${url}
Viewport: ${width}x${height}
Browser engine: ${engine}
Screenshot directory: ${outputDir}

Generate a complete, self-contained Node.js ESM script using Playwright that performs the test described by the user. Follow these rules strictly:

1. Output ONLY valid Node.js code. No markdown, no backticks, no explanation, no preamble.
2. Use ESM import: import { ${engine} } from 'playwright';
3. Launch headless: false. Set viewport to ${width}x${height}.
4. Navigate to "${url}". Wait for 'networkidle' + 2500ms for animations to settle.
5. Take a screenshot at each meaningful test step. Save to: \`${outputDir}/step-{n}.png\`.
6. Log each step as a JSON line to stdout:
   {"step": 1, "description": "what this step tested", "status": "pass", "screenshot": "step-1.png", "error": null}
   For failures: {"step": 2, "description": "...", "status": "fail", "screenshot": "step-2.png", "error": "Element not found"}
7. Log a final summary line:
   {"summary": true, "total": 5, "passed": 4, "failed": 1}
8. Use reasonable timeouts: 10s navigation, 5s element waits.
9. Wrap everything in an async IIFE with try/catch/finally so the script always completes and reports.
10. Close the browser in a finally block.
11. For mobile viewports (width < 768), navigation may be behind a hamburger menu — open it first.
12. Do NOT import 'fs', 'child_process', 'net', 'http', 'https', or any module other than 'playwright'.
13. Do NOT use eval(), new Function(), dynamic import(), or process.env.
14. Do NOT navigate away from the target URL's domain.`;
}

async function generate(config) {
  await loadDotenv(config.projectRoot);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Add it to .env at the project root.');
  }
  const client = new Anthropic();
  const sys = systemPrompt(config);
  emit({ type: 'ai-generate-start', model: 'claude-haiku-4-5-20251001' });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: sys,
    messages: [{ role: 'user', content: config.prompt }],
  });
  const code = response.content?.[0]?.text || '';
  emit({ type: 'ai-generate-complete', code });
}

// Allow-list-based static check on the generated code. Looks for ESM
// import patterns that aren't from 'playwright', plus a few obvious
// escape hatches. Not a sandbox — just a safety net for the most common
// model failure modes.
function validateCode(code, targetUrl) {
  const offences = [];
  // Catch every `import ... from '<x>'` and check x === 'playwright'.
  const importRe = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    if (m[1] !== 'playwright') {
      offences.push(`Disallowed import: '${m[1]}' (only 'playwright' is allowed)`);
    }
  }
  // Bare-side-effect imports (import 'foo';)
  const bareRe = /import\s+['"]([^'"]+)['"]/g;
  while ((m = bareRe.exec(code)) !== null) {
    if (m[1] !== 'playwright') {
      offences.push(`Disallowed import: '${m[1]}'`);
    }
  }
  // require() — should be impossible in ESM but catch it anyway
  if (/\brequire\s*\(/.test(code)) offences.push('require() is not allowed (ESM only).');
  // Eval / Function
  if (/\beval\s*\(/.test(code)) offences.push('eval() is not allowed.');
  if (/\bnew\s+Function\s*\(/.test(code)) offences.push('new Function() is not allowed.');
  // Dynamic import
  if (/\bimport\s*\(/.test(code)) offences.push('Dynamic import() is not allowed.');
  // process.env access
  if (/\bprocess\.env\b/.test(code)) offences.push('process.env access is not allowed.');
  // Cross-origin navigation
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const navRe = /\.goto\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = navRe.exec(code)) !== null) {
      try {
        const navUrl = new URL(m[1], targetUrl);
        if (navUrl.origin !== targetOrigin) {
          offences.push(`Navigation to off-origin URL: ${navUrl.origin}`);
        }
      } catch { /* relative path, fine */ }
    }
  } catch { /* malformed targetUrl */ }
  return offences;
}

async function execute(config) {
  const offences = validateCode(config.code, config.url);
  if (offences.length) {
    emit({ type: 'ai-validation-failed', offences });
    return;
  }
  await fs.mkdir(config.outputDir, { recursive: true });
  const scriptPath = path.join(config.outputDir, 'test.mjs');
  await fs.writeFile(scriptPath, config.code, 'utf8');
  emit({ type: 'ai-execute-start', scriptPath });

  // Spawn node directly. The parent (qa.rs) wraps this in /bin/sh -lc
  // for PATH resolution, so node here is whatever was used to launch us.
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Hard timeout per spec: 60s. Kill the child if it overruns.
  const timer = setTimeout(() => {
    emit({ type: 'ai-execute-timeout', message: 'Test exceeded 60s budget' });
    child.kill('SIGKILL');
  }, 60_000);

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Forward each line as an ai-step event, parsing JSON if possible.
      try {
        const obj = JSON.parse(line);
        emit({ type: 'ai-step', ...obj });
      } catch {
        emit({ type: 'ai-log', line });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      emit({ type: 'ai-stderr', line });
    }
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    emit({ type: 'ai-execute-complete', exitCode: code });
  });
}

async function run() {
  const config = await readStdinJson();
  // One sidecar invocation, two phases: generate the script, then
  // execute it in the same process. The frontend gets ai-generate-*
  // events first (and renders the code under "View generated code"),
  // then ai-execute-* / ai-step events as the test runs. Skipping
  // validation halts the run before exec.
  if (config.mode === 'generate-only') {
    await generate(config);
    return;
  }
  if (config.mode === 'execute-only') {
    await execute(config);
    return;
  }
  // Default: full run.
  await loadDotenv(config.projectRoot);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set. Add it to .env at the project root.');
  }
  const client = new Anthropic();
  const sys = systemPrompt(config);
  emit({ type: 'ai-generate-start', model: 'claude-haiku-4-5-20251001' });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: sys,
    messages: [{ role: 'user', content: config.prompt }],
  });
  const code = response.content?.[0]?.text || '';
  emit({ type: 'ai-generate-complete', code });
  await execute({ ...config, code });
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
