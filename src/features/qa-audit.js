// Cross-browser audit tab. Owns the entire UI for kicking off a Playwright
// run via the Rust qa::* commands, streaming progress events back from the
// audit/cross-browser.js sidecar, and rendering the resulting screenshots.
//
// Listeners are attached once on init() and live for the app's lifetime —
// the QA tab uses display: none / hidden toggling rather than DOM teardown,
// so listeners don't leak between switches.

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { escapeHtml, escapeAttr, flash, hostOf } from './utils.js';
import { icon } from './icons.js';

const ENGINES = [
  { id: 'chromium', label: 'Chromium' },
  { id: 'firefox',  label: 'Firefox' },
  { id: 'webkit',   label: 'WebKit' },
];

// Mirrors audit/lib/viewports.js so the desktop app's "Quick" preset
// matches what the existing CLI runner uses. Keep these in sync; both
// lists are tiny and rarely change.
const QUICK_VIEWPORT_IDS = [
  'galaxy-s24', 'iphone-16', 'ipad-mini-7', 'ipad-pro-11-m4', 'macbook-air-13', 'full-hd',
];

const HISTORY_KEY = 'rt-qa-history';
const HISTORY_LIMIT = 5;

export function initCrossBrowser({ container, getCurrentUrl, getAuth, allDevices }) {
  const ui = buildLayout(container, allDevices());
  let runningRunId = null;

  // ── Setup state ─────────────────────────────────────────────────────
  let cachedSetup = null;
  async function refreshSetup() {
    cachedSetup = await invoke('qa_check_setup').catch(() => null);
    return cachedSetup;
  }

  async function ensureSetup() {
    const status = await refreshSetup();
    if (!status) return false;
    const ready = status.node_found && status.npm_found
      && status.node_modules_installed && status.playwright_browsers_installed;
    if (!ready) openSetupModal(status);
    return ready;
  }

  function openSetupModal(status) {
    ui.setup.hidden = false;
    renderSetup(status);
  }

  function renderSetup(status) {
    const { node_found, npm_found, node_modules_installed, playwright_browsers_installed } = status;
    const items = [
      { ok: node_found, label: 'Node.js', detail: node_found ? status.node_path : 'Not found on PATH. Install from nodejs.org or via Homebrew/nvm.' },
      { ok: npm_found, label: 'npm', detail: npm_found ? 'Found' : 'Ships with Node.js — reinstall Node.' },
      { ok: node_modules_installed, label: 'Audit dependencies', detail: node_modules_installed ? 'Installed' : 'Not yet installed.' },
      { ok: playwright_browsers_installed, label: 'Playwright browsers', detail: playwright_browsers_installed ? 'Chromium, Firefox, WebKit installed' : 'Will be downloaded (~500 MB).' },
    ];
    const checklist = items.map((it) => `
      <li class="rt-qa-setup__check rt-qa-setup__check--${it.ok ? 'ok' : 'pending'}">
        <span class="rt-qa-setup__icon">${icon(it.ok ? 'circle-check' : 'circle-alert', 16)}</span>
        <span class="rt-qa-setup__label">
          <strong>${escapeHtml(it.label)}</strong>
          <span>${escapeHtml(it.detail)}</span>
        </span>
      </li>`).join('');

    const blockingMissing = !node_found || !npm_found;
    const installable = node_found && npm_found && (!node_modules_installed || !playwright_browsers_installed);
    const allReady = node_found && npm_found && node_modules_installed && playwright_browsers_installed;

    ui.setupBody.innerHTML = `
      <p class="rt-qa-setup__intro">Cross-browser testing runs Playwright on your machine to capture real Chromium, Firefox, and WebKit renders. First-time setup downloads the browser engines.</p>
      <ul class="rt-qa-setup__checklist">${checklist}</ul>
      <div class="rt-qa-setup__log js-rt-qa-setup-log" hidden></div>
      <div class="rt-qa-setup__actions">
        ${blockingMissing
          ? `<a class="rt-toolbar__btn" href="https://nodejs.org" target="_blank" rel="noopener">Install Node.js</a>`
          : installable
            ? `<button class="rt-toolbar__btn rt-toolbar__btn--primary js-rt-qa-setup-install">Install</button>`
            : ''}
        <button class="rt-toolbar__btn js-rt-qa-setup-close">${allReady ? 'Done' : 'Close'}</button>
      </div>
    `;

    const installBtn = ui.setupBody.querySelector('.js-rt-qa-setup-install');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        installBtn.textContent = 'Installing…';
        ui.setupLog.hidden = false;
        ui.setupLog.textContent = '';
        try {
          await invoke('qa_install_audit_deps');
          await refreshSetup();
          renderSetup(cachedSetup);
          flash('Cross-browser setup complete.');
        } catch (err) {
          ui.setupLog.textContent += `\n${err}`;
          flash(`Setup failed: ${err}`, true);
          installBtn.disabled = false;
          installBtn.textContent = 'Retry install';
        }
      });
    }
    ui.setupBody.querySelector('.js-rt-qa-setup-close').addEventListener('click', () => {
      ui.setup.hidden = true;
    });
  }

  listen('qa-install-progress', (e) => {
    if (!ui.setupLog) return;
    const { status, message } = e.payload || {};
    ui.setupLog.hidden = false;
    ui.setupLog.textContent += `[${status}] ${message}\n`;
    ui.setupLog.scrollTop = ui.setupLog.scrollHeight;
  });

  // ── Run controls state ──────────────────────────────────────────────
  const selectedEngines = new Set(ENGINES.map((e) => e.id));
  let selectedPreset = 'quick';
  const selectedCustomIds = new Set(QUICK_VIEWPORT_IDS);

  function activeViewportIds() {
    if (selectedPreset === 'quick') return QUICK_VIEWPORT_IDS.slice();
    if (selectedPreset === 'full') return allDevices().map((d) => d.id);
    return [...selectedCustomIds];
  }

  function updateChips() {
    ui.engineChips.forEach((btn) => {
      btn.classList.toggle('is-active', selectedEngines.has(btn.dataset.engine));
    });
    ui.presetChips.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.preset === selectedPreset);
    });
    ui.customPicker.hidden = selectedPreset !== 'custom';
  }

  ui.engineChips.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.engine;
      if (selectedEngines.has(id) && selectedEngines.size === 1) return; // keep at least one
      if (selectedEngines.has(id)) selectedEngines.delete(id); else selectedEngines.add(id);
      updateChips();
    });
  });
  ui.presetChips.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPreset = btn.dataset.preset;
      updateChips();
    });
  });

  // Custom picker — checkboxes for each device
  ui.customPicker.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCustomIds.add(cb.dataset.id);
      else selectedCustomIds.delete(cb.dataset.id);
    });
  });

  updateChips();

  // ── Run / cancel ────────────────────────────────────────────────────
  ui.runBtn.addEventListener('click', async () => {
    if (runningRunId) {
      await invoke('qa_cancel_audit').catch((e) => flash(`Cancel failed: ${e}`, true));
      return;
    }
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    if (!await ensureSetup()) return;

    const viewportIds = activeViewportIds();
    if (!viewportIds.length) { flash('Pick at least one viewport.', true); return; }
    const engines = ENGINES.filter((e) => selectedEngines.has(e.id)).map((e) => e.id);

    const auth = getAuth(hostOf(url)) || null;
    const config = { url, viewportIds, engines, fullPage: ui.fullPageInput.checked, auth };

    setRunning(true);
    prepareGrid(viewportIds, engines);

    try {
      runningRunId = await invoke('qa_run_screenshot_audit', { config });
    } catch (err) {
      flash(`Audit failed to start: ${err}`, true);
      setRunning(false);
    }
  });

  function setRunning(on) {
    ui.runBtn.classList.toggle('is-running', on);
    ui.runBtn.innerHTML = on ? `${icon('x', 14)}<span>Cancel</span>` : `${icon('play-circle', 14)}<span>Run audit</span>`;
    ui.status.hidden = !on;
    if (!on) {
      ui.statusText.textContent = '';
      ui.progressFill.style.width = '0%';
    }
  }

  // ── Results grid ────────────────────────────────────────────────────
  let cellMap = new Map();           // `${engine}__${vid}` → cell element
  let totalExpected = 0;
  let completedCount = 0;
  let currentRunMeta = null;         // { url, runId, outputDir, viewportIds, engines, results: [...] }

  function prepareGrid(viewportIds, engines) {
    cellMap = new Map();
    completedCount = 0;
    totalExpected = viewportIds.length * engines.length;
    currentRunMeta = { runId: null, outputDir: null, url: getCurrentUrl(), viewportIds, engines, results: [] };

    const allDevs = new Map(allDevices().map((d) => [d.id, d]));
    const rows = viewportIds.map((vid) => {
      const dev = allDevs.get(vid);
      const label = dev ? `${escapeHtml(dev.name)}<span class="rt-qa-results__dim">${dev.w}×${dev.h}</span>` : escapeHtml(vid);
      const cells = engines.map((eng) => `
        <div class="rt-qa-results__cell" data-engine="${escapeAttr(eng)}" data-vid="${escapeAttr(vid)}">
          <div class="rt-qa-results__placeholder"><span class="rt-qa-spinner" aria-hidden="true"></span></div>
          <div class="rt-qa-results__cell-label">${escapeHtml(eng)}</div>
        </div>`).join('');
      return `
        <div class="rt-qa-results__row" data-vid="${escapeAttr(vid)}">
          <div class="rt-qa-results__rowlabel">${label}</div>
          ${cells}
        </div>`;
    }).join('');

    const headerCols = engines.map((eng) => `<div class="rt-qa-results__head">${escapeHtml(eng)}</div>`).join('');
    ui.results.style.setProperty('--rt-qa-engine-cols', engines.length);
    ui.results.innerHTML = `
      <div class="rt-qa-results__row rt-qa-results__row--head">
        <div class="rt-qa-results__rowlabel"></div>
        ${headerCols}
      </div>
      ${rows}
    `;

    ui.results.querySelectorAll('.rt-qa-results__cell').forEach((cell) => {
      cellMap.set(`${cell.dataset.engine}__${cell.dataset.vid}`, cell);
      cell.addEventListener('click', () => openLightbox(cell));
    });
  }

  function setStatusText(text) {
    ui.statusText.textContent = text;
  }
  function bumpProgress() {
    completedCount++;
    const pct = totalExpected ? Math.round((completedCount / totalExpected) * 100) : 0;
    ui.progressFill.style.width = `${pct}%`;
  }

  listen('qa-progress', (e) => {
    const { engine, viewport } = e.payload || {};
    setStatusText(`Capturing ${engine} — ${viewport}`);
  });

  listen('qa-result', (e) => {
    const { engine, viewport, path, width, height } = e.payload || {};
    const cell = cellMap.get(`${engine}__${viewport}`);
    if (!cell) return;
    const url = convertFileSrc(path);
    cell.classList.remove('is-error');
    cell.classList.add('is-loaded');
    cell.dataset.path = path;
    cell.innerHTML = `
      <img class="rt-qa-results__img" src="${escapeAttr(url)}" alt="${escapeAttr(`${engine} · ${viewport}`)}" loading="lazy">
      <div class="rt-qa-results__cell-label">${escapeHtml(engine)} · ${width}×${height}</div>
    `;
    if (currentRunMeta) currentRunMeta.results.push({ engine, viewport, path, width, height });
    bumpProgress();
  });

  listen('qa-error', (e) => {
    const { engine, viewport, message } = e.payload || {};
    const cell = cellMap.get(`${engine}__${viewport}`);
    if (cell) {
      cell.classList.remove('is-loaded');
      cell.classList.add('is-error');
      cell.innerHTML = `
        <div class="rt-qa-results__error">
          ${icon('circle-alert', 18)}
          <span>${escapeHtml(message || 'Capture failed')}</span>
        </div>
        <div class="rt-qa-results__cell-label">${escapeHtml(engine)}</div>
      `;
    }
    bumpProgress();
  });

  listen('qa-stderr', (e) => {
    // Surface stderr only on outright failure — single-cell errors are
    // handled via qa-error events. This catches Playwright launch crashes
    // that prevent any qa-result from arriving.
    if (!runningRunId) return;
    const line = e.payload?.line || '';
    if (/Error|fatal/i.test(line)) console.warn('[qa stderr]', line);
  });

  listen('qa-fatal', (e) => {
    flash(`Audit crashed: ${e.payload?.message || 'unknown error'}`, true);
  });

  listen('qa-cancelled', () => {
    setStatusText('Cancelled.');
    flash('Audit cancelled.');
  });

  listen('qa-finished', (e) => {
    if (currentRunMeta) {
      currentRunMeta.runId = e.payload?.runId || null;
      currentRunMeta.outputDir = e.payload?.outputDir || null;
      pushHistory(currentRunMeta);
      renderHistory();
    }
    runningRunId = null;
    setRunning(false);
  });

  // ── Lightbox ────────────────────────────────────────────────────────
  let lightboxCells = [];
  let lightboxIndex = 0;
  function openLightbox(cell) {
    if (!cell.classList.contains('is-loaded')) return;
    lightboxCells = [...ui.results.querySelectorAll('.rt-qa-results__cell.is-loaded')];
    lightboxIndex = lightboxCells.indexOf(cell);
    showLightbox();
  }
  function showLightbox() {
    const cell = lightboxCells[lightboxIndex];
    if (!cell) return;
    const path = cell.dataset.path;
    ui.lightboxImg.src = convertFileSrc(path);
    ui.lightboxMeta.textContent = `${cell.dataset.engine} · ${cell.dataset.vid}`;
    ui.lightbox.hidden = false;
  }
  function closeLightbox() { ui.lightbox.hidden = true; }
  function stepLightbox(delta) {
    if (!lightboxCells.length) return;
    lightboxIndex = (lightboxIndex + delta + lightboxCells.length) % lightboxCells.length;
    showLightbox();
  }
  ui.lightboxClose.addEventListener('click', closeLightbox);
  ui.lightboxPrev.addEventListener('click', () => stepLightbox(-1));
  ui.lightboxNext.addEventListener('click', () => stepLightbox(1));
  ui.lightbox.addEventListener('click', (e) => { if (e.target === ui.lightbox) closeLightbox(); });
  window.addEventListener('keydown', (e) => {
    if (ui.lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });

  // ── History ─────────────────────────────────────────────────────────
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* quota */ }
  }
  function pushHistory(meta) {
    if (!meta.outputDir) return;
    const entry = {
      runId: meta.runId,
      url: meta.url,
      outputDir: meta.outputDir,
      viewportIds: meta.viewportIds,
      engines: meta.engines,
      results: meta.results,
      finishedAt: new Date().toISOString(),
    };
    const list = [entry, ...loadHistory().filter((h) => h.runId !== entry.runId)].slice(0, HISTORY_LIMIT);
    saveHistory(list);
  }
  function renderHistory() {
    const list = loadHistory();
    if (!list.length) { ui.historySelect.innerHTML = '<option value="">No previous runs</option>'; return; }
    ui.historySelect.innerHTML = '<option value="">Recent runs…</option>'
      + list.map((h) => `<option value="${escapeAttr(h.runId)}">${escapeHtml(new Date(h.finishedAt).toLocaleString())} · ${escapeHtml(hostOf(h.url) || h.url)} · ${h.engines.length}×${h.viewportIds.length}</option>`).join('');
  }
  ui.historySelect.addEventListener('change', () => {
    const id = ui.historySelect.value;
    if (!id) return;
    const entry = loadHistory().find((h) => h.runId === id);
    if (!entry) return;
    rehydrateRun(entry);
  });
  function rehydrateRun(entry) {
    prepareGrid(entry.viewportIds, entry.engines);
    currentRunMeta = { ...entry, results: [] };
    for (const r of entry.results) {
      const cell = cellMap.get(`${r.engine}__${r.viewport}`);
      if (!cell) continue;
      const url = convertFileSrc(r.path);
      cell.classList.add('is-loaded');
      cell.dataset.path = r.path;
      cell.innerHTML = `
        <img class="rt-qa-results__img" src="${escapeAttr(url)}" alt="${escapeAttr(`${r.engine} · ${r.viewport}`)}" loading="lazy">
        <div class="rt-qa-results__cell-label">${escapeHtml(r.engine)} · ${r.width}×${r.height}</div>
      `;
    }
    completedCount = entry.results.length;
    totalExpected = entry.viewportIds.length * entry.engines.length;
  }
  renderHistory();

  // ── Reveal-in-finder ────────────────────────────────────────────────
  ui.revealBtn.addEventListener('click', async () => {
    if (!currentRunMeta?.outputDir) { flash('Run an audit first.', true); return; }
    try {
      await invoke('reveal_in_finder', { path: currentRunMeta.outputDir });
    } catch (err) {
      flash(`Could not open folder: ${err}`, true);
    }
  });

  // Initial setup probe so the CTA reflects reality without making the
  // user click "Run" first to discover Playwright is missing.
  refreshSetup();

  return {
    onActivate: () => { /* no-op for now; kept for parity if we add lazy init later */ },
    refreshSetup,
  };
}

// ── DOM construction ────────────────────────────────────────────────────
function buildLayout(container, devices) {
  const deviceRows = devices.map((d) => `
    <label class="rt-qa-controls__custom-item">
      <input type="checkbox" data-id="${escapeAttr(d.id)}">
      <span class="rt-dot rt-dot--${d.type}"></span>
      <span>${escapeHtml(d.name)}</span>
      <span class="rt-qa-controls__custom-dim">${d.w}×${d.h}</span>
    </label>`).join('');

  container.innerHTML = `
    <div class="rt-qa">
      <div class="rt-qa-controls">
        <div class="rt-qa-controls__group">
          <span class="rt-qa-controls__label">Engines</span>
          <div class="rt-qa-controls__chips js-rt-qa-engines">
            ${ENGINES.map((e) => `<button class="rt-qa-controls__chip is-active" data-engine="${e.id}">${e.label}</button>`).join('')}
          </div>
        </div>
        <div class="rt-qa-controls__group">
          <span class="rt-qa-controls__label">Viewports</span>
          <div class="rt-qa-controls__chips js-rt-qa-presets">
            <button class="rt-qa-controls__chip is-active" data-preset="quick">Quick (6)</button>
            <button class="rt-qa-controls__chip" data-preset="full">Full (${devices.length})</button>
            <button class="rt-qa-controls__chip" data-preset="custom">Custom…</button>
          </div>
        </div>
        <label class="rt-qa-controls__toggle">
          <input type="checkbox" class="js-rt-qa-fullpage" checked>
          <span>Full page</span>
        </label>
        <div class="rt-qa-controls__spacer"></div>
        <button class="rt-toolbar__btn rt-toolbar__btn--icon js-rt-qa-reveal" title="Reveal latest run in Finder" aria-label="Reveal in Finder">${icon('external-link', 14)}</button>
        <button class="rt-toolbar__btn rt-toolbar__btn--primary js-rt-qa-run">${icon('play-circle', 14)}<span>Run audit</span></button>
      </div>

      <div class="rt-qa-controls__custom js-rt-qa-custom" hidden>
        ${deviceRows}
      </div>

      <div class="rt-qa-status js-rt-qa-status" hidden>
        <span class="rt-qa-status__text js-rt-qa-status-text">Capturing…</span>
        <div class="rt-qa-status__bar"><div class="rt-qa-status__fill js-rt-qa-progress"></div></div>
      </div>

      <div class="rt-qa-results js-rt-qa-results"></div>

      <div class="rt-qa-history">
        <select class="rt-qa-history__select js-rt-qa-history">
          <option value="">No previous runs</option>
        </select>
      </div>
    </div>

    <div class="rt-qa-lightbox js-rt-qa-lightbox" hidden>
      <button class="rt-qa-lightbox__nav rt-qa-lightbox__nav--prev js-rt-qa-lb-prev" aria-label="Previous">${icon('chevron-left', 24)}</button>
      <div class="rt-qa-lightbox__stage">
        <img class="rt-qa-lightbox__img js-rt-qa-lb-img" alt="">
        <div class="rt-qa-lightbox__meta js-rt-qa-lb-meta"></div>
      </div>
      <button class="rt-qa-lightbox__nav rt-qa-lightbox__nav--next js-rt-qa-lb-next" aria-label="Next">${icon('chevron-right', 24)}</button>
      <button class="rt-qa-lightbox__close js-rt-qa-lb-close" aria-label="Close">${icon('x', 18)}</button>
    </div>

    <div class="rt-qa-setup js-rt-qa-setup" hidden>
      <div class="rt-qa-setup__sheet">
        <div class="rt-qa-setup__header">
          <strong>Cross-browser setup</strong>
        </div>
        <div class="rt-qa-setup__body js-rt-qa-setup-body"></div>
      </div>
    </div>
  `;

  return {
    runBtn: container.querySelector('.js-rt-qa-run'),
    revealBtn: container.querySelector('.js-rt-qa-reveal'),
    fullPageInput: container.querySelector('.js-rt-qa-fullpage'),
    engineChips: [...container.querySelectorAll('.js-rt-qa-engines .rt-qa-controls__chip')],
    presetChips: [...container.querySelectorAll('.js-rt-qa-presets .rt-qa-controls__chip')],
    customPicker: container.querySelector('.js-rt-qa-custom'),
    status: container.querySelector('.js-rt-qa-status'),
    statusText: container.querySelector('.js-rt-qa-status-text'),
    progressFill: container.querySelector('.js-rt-qa-progress'),
    results: container.querySelector('.js-rt-qa-results'),
    historySelect: container.querySelector('.js-rt-qa-history'),
    lightbox: container.querySelector('.js-rt-qa-lightbox'),
    lightboxImg: container.querySelector('.js-rt-qa-lb-img'),
    lightboxMeta: container.querySelector('.js-rt-qa-lb-meta'),
    lightboxClose: container.querySelector('.js-rt-qa-lb-close'),
    lightboxPrev: container.querySelector('.js-rt-qa-lb-prev'),
    lightboxNext: container.querySelector('.js-rt-qa-lb-next'),
    setup: container.querySelector('.js-rt-qa-setup'),
    setupBody: container.querySelector('.js-rt-qa-setup-body'),
    get setupLog() { return container.querySelector('.js-rt-qa-setup-log'); },
  };
}
