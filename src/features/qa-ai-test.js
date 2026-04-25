// AI Test Runner tab. Hand a natural-language test description to
// Claude, get back a Playwright ESM script, validate, run, render
// per-step results with screenshots.
//
// Listens for streaming events from the audit/ai-test-runner.js sidecar
// (qa-ai-* keyed off each NDJSON type) and renders incrementally.

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { escapeHtml, escapeAttr, flash, hostOf, promptModal } from './utils.js';
import { icon } from './icons.js';

const SAVED_TESTS_KEY = 'rt-ai-tests';

export function initAiTest({ container, getCurrentUrl, getAuth, allDevices }) {
  const ui = buildLayout(container, allDevices());

  let running = false;
  let lastRun = null;     // { id, outputDir, code, steps: [], summary, validationOffences }

  // ── API key probe ───────────────────────────────────────────────────
  async function refreshKeyState() {
    const ok = await invoke('qa_check_ai_key').catch(() => false);
    ui.keyWarning.hidden = !!ok;
  }
  refreshKeyState();

  // ── Run ─────────────────────────────────────────────────────────────
  ui.runBtn.addEventListener('click', async () => {
    if (running) {
      try { await invoke('qa_cancel_ai_test'); }
      catch (err) { flash(String(err), true); }
      return;
    }
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    const prompt = ui.promptInput.value.trim();
    if (!prompt) { flash('Describe the test first.', true); return; }
    const engine = ui.engineSelect.value;
    const viewportId = ui.viewportSelect.value;
    const dev = allDevices().find((d) => d.id === viewportId);
    if (!dev) { flash('Pick a viewport.', true); return; }

    setRunning(true);
    lastRun = { steps: [], summary: null, validationOffences: null, code: null, outputDir: null };
    renderResults();
    ui.statusText.textContent = 'Generating test code…';
    try {
      await invoke('qa_run_ai_test', {
        config: {
          prompt, url, engine,
          width: dev.w, height: dev.h,
        },
      });
    } catch (err) {
      flash(`AI test failed to start: ${err}`, true);
      setRunning(false);
    }
  });

  function setRunning(on) {
    running = on;
    ui.runBtn.classList.toggle('is-running', on);
    ui.runBtn.innerHTML = on ? `${icon('x', 14)}<span>Cancel</span>` : `${icon('play-circle', 14)}<span>Run test</span>`;
  }

  listen('qa-ai-generate-start', (e) => {
    ui.statusText.textContent = `Generating with ${e.payload?.model || 'Claude'}…`;
  });

  listen('qa-ai-generate-complete', (e) => {
    if (!lastRun) lastRun = { steps: [] };
    lastRun.code = e.payload?.code || '';
    ui.statusText.textContent = 'Code generated. Validating + running…';
    renderResults();
  });

  listen('qa-ai-validation-failed', (e) => {
    if (!lastRun) lastRun = { steps: [] };
    lastRun.validationOffences = e.payload?.offences || [];
    ui.statusText.textContent = 'Validation failed — execution aborted.';
    flash('Generated code failed safety validation. See details below.', true);
    renderResults();
  });

  listen('qa-ai-execute-start', () => {
    ui.statusText.textContent = 'Running test…';
  });

  listen('qa-ai-step', (e) => {
    if (!lastRun) lastRun = { steps: [] };
    const p = e.payload || {};
    if (p.summary) {
      lastRun.summary = p;
      ui.statusText.textContent = `Done — ${p.passed}/${p.total} passed.`;
    } else {
      lastRun.steps.push(p);
    }
    renderResults();
  });

  listen('qa-ai-execute-timeout', (e) => {
    flash(e.payload?.message || 'Test timed out', true);
  });

  listen('qa-ai-execute-complete', () => {
    setRunning(false);
  });

  listen('qa-ai-cancelled', () => {
    setRunning(false);
    ui.statusText.textContent = 'Cancelled.';
  });

  listen('qa-ai-finished', (e) => {
    setRunning(false);
    if (lastRun) lastRun.outputDir = e.payload?.outputDir || null;
    renderResults();
  });

  listen('qa-ai-stderr', (e) => {
    const line = e.payload?.line || '';
    if (/Error|fatal/i.test(line)) console.warn('[qa-ai]', line);
  });

  listen('qa-fatal', (e) => flash(`AI runner crashed: ${e.payload?.message || 'unknown'}`, true));

  // ── Render ──────────────────────────────────────────────────────────
  function renderResults() {
    if (!lastRun) {
      ui.results.innerHTML = '<div class="rt-prelaunch__placeholder">Describe a test above and hit "Run test".</div>';
      return;
    }
    let html = '';
    if (lastRun.summary) {
      html += `<div class="rt-prelaunch__summary">${lastRun.summary.passed}/${lastRun.summary.total} steps passed · ${lastRun.summary.failed} failed</div>`;
    }
    if (lastRun.validationOffences?.length) {
      html += `
        <div class="rt-prelaunch__site-wide" style="border-color:var(--rt-danger);">
          <h4 style="color:var(--rt-danger);">Validation failed — code rejected</h4>
          <ul>${lastRun.validationOffences.map((o) => `<li>${icon('circle-x', 14)} ${escapeHtml(o)}</li>`).join('')}</ul>
        </div>`;
    }
    html += '<ol class="rt-ai-test__steps">';
    for (const step of lastRun.steps) {
      const cls = step.status === 'pass' ? 'is-pass' : step.status === 'fail' ? 'is-fail' : '';
      const badge = step.status === 'pass' ? `${icon('circle-check', 14)} pass` : step.status === 'fail' ? `${icon('circle-x', 14)} fail` : '';
      const shotPath = step.screenshot && lastRun.outputDir ? `${lastRun.outputDir}/${step.screenshot}` : null;
      const shot = shotPath ? `<img class="rt-qa-results__img" src="${escapeAttr(convertFileSrc(shotPath))}" alt="step ${step.step}">` : '';
      const err = step.error ? `<pre class="rt-ai-test__error">${escapeHtml(step.error)}</pre>` : '';
      html += `
        <li class="rt-ai-test__step ${cls}">
          <div class="rt-ai-test__step-head">
            <span class="rt-ai-test__step-n">${step.step ?? ''}</span>
            <span class="rt-ai-test__step-desc">${escapeHtml(step.description || '')}</span>
            <span class="rt-ai-test__step-badge">${badge}</span>
          </div>
          ${err}
          ${shot}
        </li>`;
    }
    html += '</ol>';

    if (lastRun.code) {
      html += `
        <details class="rt-ai-test__code-toggle">
          <summary>View generated code</summary>
          <pre class="rt-ai-test__code">${escapeHtml(lastRun.code)}</pre>
        </details>`;
    }

    if (lastRun.summary || lastRun.validationOffences) {
      html += `
        <div class="rt-prelaunch__export">
          <button class="rt-toolbar__btn js-save-test">${icon('download', 14)}<span>Save test</span></button>
        </div>`;
    }

    ui.results.innerHTML = html;
    const saveBtn = ui.results.querySelector('.js-save-test');
    if (saveBtn) saveBtn.addEventListener('click', saveTest);
  }

  async function saveTest() {
    const name = await promptModal('Name for this test', '');
    if (!name) return;
    const list = JSON.parse(localStorage.getItem(SAVED_TESTS_KEY) || '[]');
    list.unshift({
      name,
      prompt: ui.promptInput.value,
      engine: ui.engineSelect.value,
      viewport: ui.viewportSelect.value,
      code: lastRun?.code || '',
      savedAt: new Date().toISOString(),
    });
    localStorage.setItem(SAVED_TESTS_KEY, JSON.stringify(list.slice(0, 25)));
    flash('Test saved.');
    renderSavedDropdown();
  }

  function renderSavedDropdown() {
    const list = JSON.parse(localStorage.getItem(SAVED_TESTS_KEY) || '[]');
    ui.savedSelect.innerHTML = '<option value="">Saved tests…</option>'
      + list.map((t, i) => `<option value="${i}">${escapeHtml(t.name)} · ${escapeHtml(t.engine)}</option>`).join('');
  }

  ui.savedSelect.addEventListener('change', () => {
    const i = ui.savedSelect.value;
    if (i === '') return;
    const list = JSON.parse(localStorage.getItem(SAVED_TESTS_KEY) || '[]');
    const t = list[Number(i)];
    if (!t) return;
    ui.promptInput.value = t.prompt;
    ui.engineSelect.value = t.engine;
    ui.viewportSelect.value = t.viewport;
    ui.savedSelect.value = '';
  });

  renderSavedDropdown();
  renderResults();

  return { refreshKeyState };
}

function buildLayout(container, devices) {
  container.innerHTML = `
    <div class="rt-ai-test">
      <div class="rt-ai-test__key js-key-warning" hidden>
        ${icon('circle-alert', 14)}
        <span>ANTHROPIC_API_KEY not found in <code>.env</code> at the project root. Add a line like
        <code>ANTHROPIC_API_KEY=sk-ant-...</code> and reopen the app.</span>
      </div>

      <div class="rt-qa-controls">
        <div class="rt-qa-session__group">
          <span class="rt-qa-controls__label">Engine</span>
          <select class="rt-qa-session__viewport js-engine">
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </select>
        </div>
        <div class="rt-qa-session__group">
          <span class="rt-qa-controls__label">Viewport</span>
          <select class="rt-qa-session__viewport js-viewport">
            ${devices.map((d) => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)} — ${d.w}×${d.h}</option>`).join('')}
          </select>
        </div>
        <div class="rt-qa-controls__spacer"></div>
        <select class="rt-qa-history__select js-saved-select"><option value="">Saved tests…</option></select>
        <button class="rt-toolbar__btn rt-toolbar__btn--primary js-run">${icon('play-circle', 14)}<span>Run test</span></button>
      </div>

      <textarea class="rt-ai-test__prompt js-prompt" placeholder="Describe what to test, e.g. 'Open the mobile menu, tap each link, verify they all navigate to a page with an h1.'"></textarea>

      <div class="rt-prelaunch__status js-status" hidden></div>
      <div class="rt-ai-test__status js-status">Idle.</div>

      <div class="rt-ai-test__results js-results"></div>
    </div>`;

  return {
    keyWarning: container.querySelector('.js-key-warning'),
    engineSelect: container.querySelector('.js-engine'),
    viewportSelect: container.querySelector('.js-viewport'),
    savedSelect: container.querySelector('.js-saved-select'),
    promptInput: container.querySelector('.js-prompt'),
    runBtn: container.querySelector('.js-run'),
    statusText: container.querySelector('.rt-ai-test__status'),
    results: container.querySelector('.js-results'),
  };
}
