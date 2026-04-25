// QA Session tab. Owns the live-browser launcher (headed Playwright via
// the audit/live-session.js sidecar) and the per-URL checklist that
// structures a manual QA pass through a site.
//
// Mirrors qa-audit.js's shape: listeners attached once at init, DOM
// preserved across mode switches, all callbacks injected so the module
// stays decoupled from main.js's state internals.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { escapeHtml, escapeAttr, slug, flash, hostOf } from './utils.js';
import { icon } from './icons.js';

const ENGINES = [
  { id: 'chromium', label: 'Chrome', dotClass: 'rt-browser-dot--chrome' },
  { id: 'firefox',  label: 'Firefox', dotClass: 'rt-browser-dot--firefox' },
  { id: 'webkit',   label: 'Safari', dotClass: 'rt-browser-dot--safari' },
];

// Standard four-check pattern that every section gets when added via
// "Add Section +". Same shape as the entries in DEFAULT_TEMPLATE below.
const STANDARD_CHECKS = () => ([
  { id: 'design',         label: 'Design',                          type: 'manual' },
  { id: 'responsive',     label: 'Responsive pass — all viewports', type: 'responsive' },
  { id: 'cross-browser',  label: 'Cross-browser — Chrome + Firefox', type: 'cross-browser' },
  { id: 'copy',           label: 'Copy review',                     type: 'manual' },
]);

const DEFAULT_TEMPLATE = () => ([
  { id: 'header-nav', name: 'Header & Navigation', checks: [
    { id: 'design',        label: 'Design — logo, links, scroll behaviour, mobile menu animation', type: 'manual' },
    { id: 'responsive',    label: 'Responsive pass — all viewports', type: 'responsive' },
    { id: 'cross-browser', label: 'Cross-browser — Chrome + Firefox', type: 'cross-browser' },
    { id: 'copy',          label: 'Copy review — all text accurate', type: 'manual' },
  ]},
  { id: 'hero',     name: 'Hero',               checks: STANDARD_CHECKS() },
  { id: 'about',    name: 'About',              checks: STANDARD_CHECKS() },
  { id: 'services', name: 'Services / Content', checks: STANDARD_CHECKS() },
  { id: 'contact',  name: 'Contact & Footer',   checks: STANDARD_CHECKS() },
  { id: 'site-wide', name: 'Site-Wide', checks: [
    { id: 'links-internal', label: 'All internal links work',           type: 'manual' },
    { id: 'links-external', label: 'External links open in new tabs',   type: 'manual' },
    { id: 'console',        label: 'No console errors',                  type: 'manual' },
    { id: 'meta',           label: 'Favicon, OG, meta titles + descriptions present', type: 'manual' },
    { id: '404',            label: '404 page works',                     type: 'manual' },
    { id: 'cookie',         label: 'Cookie / privacy consent works',     type: 'manual' },
    { id: 'form',           label: 'Contact form submits correctly',     type: 'manual' },
    { id: 'analytics',      label: 'Analytics connected',                type: 'manual' },
  ]},
]);

// Window position for "Launch All Engines" — only Chromium honours
// --window-position via Playwright's launch args. Firefox and WebKit
// open at the OS default; user repositions manually if they want.
const CHROMIUM_DEFAULT_POSITION = { x: 40, y: 80 };

export function initQaSession({ container, getCurrentUrl, getAuth, allDevices, setMode, getQaSessionState, setQaSessionState }) {
  const ui = buildLayout(container, allDevices());

  // Active sessions, keyed by `${engine}-${viewportId}`. Mirrors the
  // Rust-side LiveSessions HashMap. Updated reactively from Tauri events.
  const liveSessions = new Set();

  // Selection state. Persisted via callback into rt-state-v3.
  const persisted = getQaSessionState() || {};
  let selectedEngine = persisted.engine || 'chromium';
  let selectedViewportId = persisted.viewport || 'iphone-16';
  let activeUrlSlug = persisted.activeUrlSlug || null;

  // Current checklist in memory. Persisted to disk via Rust commands
  // when modified (debounced to avoid hammering fs on rapid clicks).
  let checklist = null;
  let saveTimer = null;
  function saveChecklistDebounced() {
    if (!checklist) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await invoke('qa_save_checklist', {
          urlSlug: checklist.urlSlug,
          json: JSON.stringify(checklist, null, 2),
        });
      } catch (err) {
        flash(`Saving checklist failed: ${err}`, true);
      }
    }, 400);
  }

  // ── Live-session event listeners ────────────────────────────────────
  listen('qa-session-ready', (e) => {
    const id = e.payload?.sessionId;
    if (!id) return;
    liveSessions.add(id);
    renderActiveSessions();
    renderEngineButtons();
  });
  listen('qa-session-closed', (e) => {
    const id = e.payload?.sessionId;
    if (!id) return;
    liveSessions.delete(id);
    renderActiveSessions();
    renderEngineButtons();
  });
  listen('qa-session-stderr', (e) => {
    const line = e.payload?.line || '';
    if (/Error|fatal/i.test(line)) console.warn('[qa-session]', line);
  });

  // ── Engine + viewport selection ─────────────────────────────────────
  function viewportSpec() {
    const dev = allDevices().find((d) => d.id === selectedViewportId);
    if (!dev) return null;
    return { id: dev.id, width: dev.w, height: dev.h, type: dev.type };
  }

  function renderEngineButtons() {
    ENGINES.forEach((eng) => {
      const btn = ui.engineButtons[eng.id];
      if (!btn) return;
      btn.classList.toggle('is-selected', selectedEngine === eng.id);
      const hasLive = [...liveSessions].some((id) => id.startsWith(`${eng.id}-`));
      btn.classList.toggle('has-session', hasLive);
    });
  }

  function renderViewportSelect() {
    ui.viewportSelect.innerHTML = allDevices().map((d) => `
      <option value="${escapeAttr(d.id)}" ${d.id === selectedViewportId ? 'selected' : ''}>
        ${escapeHtml(d.name)} — ${d.w}×${d.h}
      </option>
    `).join('');
  }

  function renderLaunchButtonLabel() {
    const eng = ENGINES.find((e) => e.id === selectedEngine);
    const dev = allDevices().find((d) => d.id === selectedViewportId);
    if (!eng || !dev) return;
    ui.launchBtn.innerHTML = `${icon('play-circle', 14)}<span>Launch ${escapeHtml(eng.label)} — ${escapeHtml(dev.name)} (${dev.w}px)</span>`;
  }

  ENGINES.forEach((eng) => {
    const btn = ui.engineButtons[eng.id];
    btn.addEventListener('click', () => {
      selectedEngine = eng.id;
      setQaSessionState({ engine: selectedEngine, viewport: selectedViewportId, activeUrlSlug });
      renderEngineButtons();
      renderLaunchButtonLabel();
    });
  });

  ui.viewportSelect.addEventListener('change', () => {
    selectedViewportId = ui.viewportSelect.value;
    setQaSessionState({ engine: selectedEngine, viewport: selectedViewportId, activeUrlSlug });
    renderLaunchButtonLabel();
  });

  // ── Launch / close ──────────────────────────────────────────────────
  async function launchOne(engine, viewportId, position) {
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    const dev = allDevices().find((d) => d.id === viewportId);
    if (!dev) { flash(`Unknown viewport: ${viewportId}`, true); return; }
    const auth = getAuth(hostOf(url)) || null;
    try {
      await invoke('qa_launch_session', {
        config: {
          url,
          engine,
          viewport: { id: dev.id, width: dev.w, height: dev.h, type: dev.type },
          auth,
          position: position || null,
        },
      });
      // session-ready event will populate liveSessions + re-render.
    } catch (err) {
      flash(`Launch ${engine} failed: ${err}`, true);
    }
  }

  ui.launchBtn.addEventListener('click', () => launchOne(selectedEngine, selectedViewportId, null));

  ui.launchAllBtn.addEventListener('click', async () => {
    // Chromium gets the side-by-side position; the others land at the
    // OS default (Playwright doesn't expose a window-position arg for
    // Firefox or WebKit). User can drag them manually.
    await Promise.all([
      launchOne('chromium', selectedViewportId, CHROMIUM_DEFAULT_POSITION),
      launchOne('firefox',  selectedViewportId, null),
      launchOne('webkit',   selectedViewportId, null),
    ]);
  });

  ui.closeAllBtn.addEventListener('click', async () => {
    try { await invoke('qa_close_all_sessions'); } catch (err) { flash(String(err), true); }
  });

  function renderActiveSessions() {
    if (!liveSessions.size) {
      ui.activeSessions.innerHTML = '<span class="rt-qa-session__none">No live sessions</span>';
      return;
    }
    ui.activeSessions.innerHTML = [...liveSessions].sort().map((id) => {
      const [engine, ...vidParts] = id.split('-');
      const vid = vidParts.join('-');
      const eng = ENGINES.find((e) => e.id === engine);
      const dev = allDevices().find((d) => d.id === vid);
      return `
        <span class="rt-qa-session__chip">
          <span class="rt-browser-dot ${eng?.dotClass || ''}"></span>
          <span>${escapeHtml(eng?.label || engine)} · ${escapeHtml(dev?.name || vid)}</span>
          <button class="rt-qa-session__chip-close js-close" data-id="${escapeAttr(id)}" aria-label="Close session">${icon('x', 12)}</button>
        </span>
      `;
    }).join('');
    ui.activeSessions.querySelectorAll('.js-close').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await invoke('qa_close_session', { sessionId: b.dataset.id }); }
        catch (err) { flash(String(err), true); }
      });
    });
  }

  // ── Checklist ───────────────────────────────────────────────────────

  async function newChecklistFor(url) {
    const urlSlug = slug(url);
    const existing = await invoke('qa_load_checklist', { urlSlug }).catch(() => null);
    if (existing) {
      const fresh = window.confirm(`A checklist already exists for ${url}. Start fresh? (Cancel to keep the existing one.)`);
      if (!fresh) {
        checklist = JSON.parse(existing);
        activeUrlSlug = urlSlug;
        setQaSessionState({ engine: selectedEngine, viewport: selectedViewportId, activeUrlSlug });
        renderChecklist();
        renderProgress();
        return;
      }
    }
    checklist = {
      url,
      urlSlug,
      createdAt: new Date().toISOString(),
      sections: DEFAULT_TEMPLATE(),
    };
    // Initialise per-check state.
    for (const section of checklist.sections) {
      for (const check of section.checks) {
        check.status = 'unchecked';
        check.notes = '';
      }
    }
    activeUrlSlug = urlSlug;
    setQaSessionState({ engine: selectedEngine, viewport: selectedViewportId, activeUrlSlug });
    saveChecklistDebounced();
    renderChecklist();
    renderProgress();
  }

  ui.newChecklistBtn.addEventListener('click', () => {
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    newChecklistFor(url);
  });

  async function loadChecklistByUrlSlug(urlSlug) {
    const json = await invoke('qa_load_checklist', { urlSlug }).catch(() => null);
    if (!json) { flash('Checklist not found.', true); return; }
    checklist = JSON.parse(json);
    activeUrlSlug = urlSlug;
    setQaSessionState({ engine: selectedEngine, viewport: selectedViewportId, activeUrlSlug });
    renderChecklist();
    renderProgress();
  }

  async function refreshLoadDropdown() {
    try {
      const list = await invoke('qa_list_checklists');
      ui.loadSelect.innerHTML = '<option value="">Load checklist…</option>'
        + list.map((c) => `<option value="${escapeAttr(c.url_slug)}">${escapeHtml(c.url_slug)} · ${new Date(c.last_modified_ms).toLocaleString()}</option>`).join('');
    } catch {
      ui.loadSelect.innerHTML = '<option value="">Load checklist…</option>';
    }
  }
  ui.loadSelect.addEventListener('focus', refreshLoadDropdown);
  ui.loadSelect.addEventListener('change', () => {
    const v = ui.loadSelect.value;
    if (v) loadChecklistByUrlSlug(v);
    ui.loadSelect.value = '';
  });

  function statusIcon(status) {
    if (status === 'passed') return `<span class="rt-qa-check__status is-passed">${icon('circle-check', 16)}</span>`;
    if (status === 'failed') return `<span class="rt-qa-check__status is-failed">${icon('circle-x', 16)}</span>`;
    return `<span class="rt-qa-check__status is-unchecked">${icon('square', 16)}</span>`;
  }

  function cycleStatus(status) {
    if (status === 'unchecked') return 'passed';
    if (status === 'passed') return 'failed';
    return 'unchecked';
  }

  function renderChecklist() {
    if (!checklist) {
      ui.checklist.innerHTML = `
        <div class="rt-qa-session__empty">
          ${icon('circle-check', 24)}
          <p>No checklist for the current URL yet.</p>
          <p class="rt-qa-session__empty-hint">Click "New Checklist" to scaffold one from the default template.</p>
        </div>`;
      return;
    }
    ui.checklist.innerHTML = checklist.sections.map((section, sIdx) => `
      <details class="rt-qa-section" open data-sidx="${sIdx}">
        <summary class="rt-qa-section__head">
          <span class="rt-qa-section__chev">${icon('chevron-right', 14)}</span>
          <span class="rt-qa-section__name">${escapeHtml(section.name)}</span>
          <span class="rt-qa-section__count">${sectionPassed(section)}/${section.checks.length}</span>
          <span class="rt-qa-section__actions" onclick="event.stopPropagation()">
            <button class="rt-qa-section__act js-up"     title="Move up"   data-sidx="${sIdx}">${icon('arrow-up', 12)}</button>
            <button class="rt-qa-section__act js-down"   title="Move down" data-sidx="${sIdx}">${icon('arrow-down', 12)}</button>
            <button class="rt-qa-section__act js-mark"   title="Mark all passed" data-sidx="${sIdx}">${icon('circle-check', 12)}</button>
            <button class="rt-qa-section__act js-del-section" title="Delete section" data-sidx="${sIdx}">${icon('trash-2', 12)}</button>
          </span>
        </summary>
        <ul class="rt-qa-checks">
          ${section.checks.map((check, cIdx) => renderCheckRow(check, sIdx, cIdx)).join('')}
        </ul>
      </details>
    `).join('') + `
      <div class="rt-qa-session__add">
        <button class="rt-toolbar__btn js-add-section">${icon('plus', 14)}<span>Add section</span></button>
        <button class="rt-toolbar__btn js-reset-checklist">Reset checklist</button>
      </div>
    `;
    wireChecklistEvents();
  }

  function renderCheckRow(check, sIdx, cIdx) {
    const sideButtons = [];
    if (check.type === 'responsive') {
      sideButtons.push(`<button class="rt-qa-check__act js-open-preview">Open in Preview →</button>`);
    } else if (check.type === 'cross-browser') {
      sideButtons.push(`<button class="rt-qa-check__act js-launch-engine" data-engine="chromium">Launch Chrome</button>`);
      sideButtons.push(`<button class="rt-qa-check__act js-launch-engine" data-engine="firefox">Launch Firefox</button>`);
    }
    const noteOpen = check._notesOpen ? '' : 'hidden';
    return `
      <li class="rt-qa-check rt-qa-check--${escapeAttr(check.status || 'unchecked')}" data-sidx="${sIdx}" data-cidx="${cIdx}">
        <button class="rt-qa-check__toggle js-toggle">${statusIcon(check.status || 'unchecked')}</button>
        <span class="rt-qa-check__label">${escapeHtml(check.label)}</span>
        <span class="rt-qa-check__side">
          ${sideButtons.join('')}
          <button class="rt-qa-check__act js-notes" title="Notes">${icon('pencil', 12)}</button>
          <button class="rt-qa-check__act js-del-check" title="Delete check">${icon('trash-2', 12)}</button>
        </span>
        <textarea class="rt-qa-check__notes js-notes-input" placeholder="Notes…" ${noteOpen}>${escapeHtml(check.notes || '')}</textarea>
      </li>
    `;
  }

  function sectionPassed(section) {
    return section.checks.filter((c) => c.status === 'passed').length;
  }

  function wireChecklistEvents() {
    // Section actions
    ui.checklist.querySelectorAll('.js-up').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.sidx);
      if (i <= 0) return;
      const arr = checklist.sections;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      saveChecklistDebounced();
      renderChecklist();
    }));
    ui.checklist.querySelectorAll('.js-down').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.sidx);
      const arr = checklist.sections;
      if (i >= arr.length - 1) return;
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      saveChecklistDebounced();
      renderChecklist();
    }));
    ui.checklist.querySelectorAll('.js-mark').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.sidx);
      checklist.sections[i].checks.forEach((c) => { c.status = 'passed'; });
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    }));
    ui.checklist.querySelectorAll('.js-del-section').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.sidx);
      if (!window.confirm(`Delete section "${checklist.sections[i].name}"?`)) return;
      checklist.sections.splice(i, 1);
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    }));

    // Per-check actions
    ui.checklist.querySelectorAll('.js-toggle').forEach((b) => b.addEventListener('click', () => {
      const li = b.closest('.rt-qa-check');
      const s = Number(li.dataset.sidx);
      const c = Number(li.dataset.cidx);
      const check = checklist.sections[s].checks[c];
      check.status = cycleStatus(check.status || 'unchecked');
      // Auto-open notes on first failure so the user records why.
      if (check.status === 'failed' && !check._notesOpen) check._notesOpen = true;
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    }));
    ui.checklist.querySelectorAll('.js-notes').forEach((b) => b.addEventListener('click', () => {
      const li = b.closest('.rt-qa-check');
      const s = Number(li.dataset.sidx);
      const c = Number(li.dataset.cidx);
      const check = checklist.sections[s].checks[c];
      check._notesOpen = !check._notesOpen;
      renderChecklist();
    }));
    ui.checklist.querySelectorAll('.js-notes-input').forEach((t) => t.addEventListener('input', () => {
      const li = t.closest('.rt-qa-check');
      const s = Number(li.dataset.sidx);
      const c = Number(li.dataset.cidx);
      checklist.sections[s].checks[c].notes = t.value;
      saveChecklistDebounced();
    }));
    ui.checklist.querySelectorAll('.js-del-check').forEach((b) => b.addEventListener('click', () => {
      const li = b.closest('.rt-qa-check');
      const s = Number(li.dataset.sidx);
      const c = Number(li.dataset.cidx);
      if (!window.confirm(`Delete check "${checklist.sections[s].checks[c].label}"?`)) return;
      checklist.sections[s].checks.splice(c, 1);
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    }));
    ui.checklist.querySelectorAll('.js-open-preview').forEach((b) => b.addEventListener('click', () => {
      if (setMode) setMode('preview');
    }));
    ui.checklist.querySelectorAll('.js-launch-engine').forEach((b) => b.addEventListener('click', () => {
      launchOne(b.dataset.engine, selectedViewportId, null);
    }));

    // Footer
    const addBtn = ui.checklist.querySelector('.js-add-section');
    if (addBtn) addBtn.addEventListener('click', () => {
      const name = window.prompt('Section name?', 'New section');
      if (!name) return;
      checklist.sections.push({
        id: slug(name) || `section-${Date.now()}`,
        name,
        checks: STANDARD_CHECKS().map((c) => ({ ...c, status: 'unchecked', notes: '' })),
      });
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    });
    const resetBtn = ui.checklist.querySelector('.js-reset-checklist');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (!window.confirm('Reset all check states to unchecked? (Sections + structure preserved.)')) return;
      for (const section of checklist.sections) {
        for (const check of section.checks) {
          check.status = 'unchecked';
          check.notes = '';
          check._notesOpen = false;
        }
      }
      saveChecklistDebounced();
      renderChecklist();
      renderProgress();
    });
  }

  function renderProgress() {
    if (!checklist) {
      ui.progressText.textContent = 'No checklist loaded';
      ui.progressFill.style.width = '0%';
      return;
    }
    let passed = 0, failed = 0, total = 0;
    for (const s of checklist.sections) for (const c of s.checks) {
      total++;
      if (c.status === 'passed') passed++;
      if (c.status === 'failed') failed++;
    }
    const remaining = total - passed - failed;
    ui.progressText.textContent = `${passed}/${total} passed · ${failed} failed · ${remaining} remaining`;
    ui.progressFill.style.width = total ? `${Math.round((passed / total) * 100)}%` : '0%';
  }

  // ── HTML report export ──────────────────────────────────────────────
  ui.exportBtn.addEventListener('click', async () => {
    if (!checklist) { flash('No checklist to export.', true); return; }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        defaultPath: `qa-checklist-${checklist.urlSlug}-${new Date().toISOString().slice(0, 10)}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (!path) return;
      const html = buildReportHtml(checklist);
      await invoke('qa_write_text', { path, contents: html });
      flash('Report exported.');
    } catch (err) {
      flash(`Export failed: ${err}`, true);
    }
  });

  // ── Public API ──────────────────────────────────────────────────────
  async function broadcastUrl(url) {
    try {
      const ids = await invoke('qa_list_sessions');
      await Promise.all(ids.map((id) => invoke('qa_navigate_session', { sessionId: id, url })));
    } catch (err) {
      console.warn('[qa-session] broadcastUrl failed:', err);
    }
  }

  async function refreshSessions() {
    try {
      const ids = await invoke('qa_list_sessions');
      liveSessions.clear();
      ids.forEach((id) => liveSessions.add(id));
      renderActiveSessions();
      renderEngineButtons();
    } catch { /* ignore */ }
  }

  // ── Initial render ──────────────────────────────────────────────────
  renderViewportSelect();
  renderEngineButtons();
  renderLaunchButtonLabel();
  renderActiveSessions();
  renderProgress();
  refreshSessions();

  // Re-load the previously active checklist if one exists.
  (async () => {
    if (activeUrlSlug) {
      const json = await invoke('qa_load_checklist', { urlSlug: activeUrlSlug }).catch(() => null);
      if (json) {
        checklist = JSON.parse(json);
        renderChecklist();
        renderProgress();
        return;
      }
    }
    renderChecklist(); // shows empty-state
  })();

  return { broadcastUrl, refreshSessions };
}

// ── DOM construction ────────────────────────────────────────────────────
function buildLayout(container, devices) {
  const launchAllTooltip = 'Launches Chrome + Firefox + WebKit. Chrome positions to the top-left; Firefox and WebKit land at the OS default — drag them where you want.';
  container.innerHTML = `
    <div class="rt-qa-session">
      <div class="rt-qa-session__header">
        <div class="rt-qa-session__progress">
          <span class="rt-qa-session__progress-text js-progress-text">No checklist loaded</span>
          <div class="rt-qa-session__progress-bar"><div class="rt-qa-session__progress-fill js-progress-fill"></div></div>
        </div>
        <div class="rt-qa-session__header-actions">
          <select class="rt-qa-history__select js-load-select"><option value="">Load checklist…</option></select>
          <button class="rt-toolbar__btn js-new-checklist">New checklist</button>
        </div>
      </div>

      <div class="rt-qa-session__controls">
        <div class="rt-qa-session__group">
          <span class="rt-qa-controls__label">Engine</span>
          <div class="rt-qa-session__engines">
            ${ENGINES.map((e) => `
              <button class="rt-qa-session__engine js-engine" data-engine="${e.id}">
                <span class="rt-browser-dot ${e.dotClass}"></span>
                <span>${escapeHtml(e.label)}</span>
                <span class="rt-qa-session__engine-live" aria-label="Active session"></span>
              </button>`).join('')}
          </div>
        </div>
        <div class="rt-qa-session__group">
          <span class="rt-qa-controls__label">Viewport</span>
          <select class="rt-qa-session__viewport js-viewport"></select>
        </div>
        <div class="rt-qa-session__spacer"></div>
        <button class="rt-toolbar__btn js-launch-all" title="${escapeAttr(launchAllTooltip)}">Launch all engines</button>
        <button class="rt-toolbar__btn js-close-all">Close all</button>
        <button class="rt-toolbar__btn rt-toolbar__btn--primary js-launch"></button>
      </div>

      <div class="rt-qa-session__active js-active-sessions"></div>

      <div class="rt-qa-session__checklist js-checklist"></div>

      <div class="rt-qa-session__footer">
        <button class="rt-toolbar__btn js-export">${icon('download', 14)}<span>Export results</span></button>
      </div>
    </div>
  `;

  return {
    progressText: container.querySelector('.js-progress-text'),
    progressFill: container.querySelector('.js-progress-fill'),
    loadSelect: container.querySelector('.js-load-select'),
    newChecklistBtn: container.querySelector('.js-new-checklist'),
    engineButtons: Object.fromEntries(ENGINES.map((e) => [
      e.id, container.querySelector(`.js-engine[data-engine="${e.id}"]`)
    ])),
    viewportSelect: container.querySelector('.js-viewport'),
    launchBtn: container.querySelector('.js-launch'),
    launchAllBtn: container.querySelector('.js-launch-all'),
    closeAllBtn: container.querySelector('.js-close-all'),
    activeSessions: container.querySelector('.js-active-sessions'),
    checklist: container.querySelector('.js-checklist'),
    exportBtn: container.querySelector('.js-export'),
  };
}

// ── HTML report ─────────────────────────────────────────────────────────
function buildReportHtml(checklist) {
  const totals = (() => {
    let passed = 0, failed = 0, total = 0;
    for (const s of checklist.sections) for (const c of s.checks) {
      total++;
      if (c.status === 'passed') passed++;
      if (c.status === 'failed') failed++;
    }
    return { passed, failed, total };
  })();
  const date = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
  const sectionsHtml = checklist.sections.map((s) => {
    const checksHtml = s.checks.map((c) => {
      const badge = c.status === 'passed'
        ? '<span class="b ok">✓ Passed</span>'
        : c.status === 'failed'
          ? '<span class="b fail">✗ Failed</span>'
          : '<span class="b pending">— Unchecked</span>';
      const notes = c.notes ? `<div class="notes">${escapeHtml(c.notes)}</div>` : '';
      return `<li><div class="row"><span class="lbl">${escapeHtml(c.label)}</span>${badge}</div>${notes}</li>`;
    }).join('');
    return `
      <section>
        <h2>${escapeHtml(s.name)}</h2>
        <ul>${checksHtml}</ul>
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>QA report — ${escapeHtml(checklist.url)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #0f172a; background: #ffffff; margin: 0; padding: 40px; max-width: 820px; margin-inline: auto; }
  header { border-bottom: 1px solid #e2e8f0; padding-bottom: 18px; margin-bottom: 28px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .meta { color: #64748b; font-size: 12px; }
  .summary { display: flex; gap: 14px; padding: 14px 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 28px; font-size: 13px; }
  .summary strong { color: #0f172a; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin: 0 0 10px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 8px 0; border-bottom: 1px solid #f1f5f9; }
  li:last-child { border-bottom: 0; }
  .row { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; }
  .lbl { color: #0f172a; }
  .b { font-size: 11px; padding: 2px 8px; border-radius: 999px; flex-shrink: 0; }
  .b.ok { background: #dcfce7; color: #166534; }
  .b.fail { background: #fee2e2; color: #991b1b; }
  .b.pending { background: #f1f5f9; color: #64748b; }
  .notes { margin-top: 4px; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #6366f1; border-radius: 4px; color: #334155; font-size: 12px; white-space: pre-wrap; }
  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 11px; }
</style>
</head><body>
  <header>
    <h1>QA report</h1>
    <div class="meta">${escapeHtml(checklist.url)} · ${escapeHtml(date)}</div>
  </header>
  <div class="summary">
    <span><strong>${totals.passed}</strong>/${totals.total} passed</span>
    <span><strong>${totals.failed}</strong> failed</span>
    <span><strong>${totals.total - totals.passed - totals.failed}</strong> remaining</span>
  </div>
  ${sectionsHtml}
  <footer>Prepared by Kobe Creative Studio Ltd · kobecreative.co.uk</footer>
</body></html>`;
}
