// QA Viewports tab. Renders the canonical 12-device QA matrix from Asana
// (one subtask per width, anchored to the $breakpoints map) and launches
// each one as a real headed Playwright window via qa_launch_session —
// same sidecar QA Session uses, so the engine actually opens at the
// viewport's width × height rather than the OS default.
//
// Engine mapping: Safari → webkit, Chrome → chromium, Firefox → firefox.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { escapeHtml, escapeAttr, flash, hostOf } from './utils.js';

// Mirrors the 12 subtasks under "Responsive pass — 12 devices" in Asana.
// IDs match DEFAULT_DEVICES in main.js so we share the underlying matrix.
const QA_VIEWPORTS = [
  { id: 'z-fold-cover',      note: '<xs' },
  { id: 'iphone-se',         note: 'xs boundary' },
  { id: 'iphone-16-pro',     note: 'xs→sm' },
  { id: 'iphone-17-pro-max', note: 'widest phone, <sm' },
  { id: 'ipad-mini-7',       note: 'sm→md' },
  { id: 'ipad-air-m3',       note: 'md→lg' },
  { id: 'z-fold-open',       note: 'md→lg, unusual aspect' },
  { id: 'ipad-pro-13-m4',    note: 'lg→xl' },
  { id: 'macbook-air-13',    note: 'xl boundary' },
  { id: 'macbook-pro-14',    note: 'xl→2xl' },
  { id: 'full-hd',           note: '2xl+' },
  { id: 'qhd-1440p',         note: 'large retina' },
];

const TYPE_LABEL = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };
const TYPE_ORDER = ['mobile', 'tablet', 'desktop'];

// Engine mapping for the per-card launch buttons. `engine` is the value
// the Playwright sidecar expects; `dot` matches the .rt-browser-dot--*
// class. Order matches the existing toolbar (Safari / Chrome / Firefox).
const ENGINES = [
  { engine: 'webkit',   label: 'Safari',  dot: 'safari'  },
  { engine: 'chromium', label: 'Chrome',  dot: 'chrome'  },
  { engine: 'firefox',  label: 'Firefox', dot: 'firefox' },
];

export function initViewports({
  container,
  getCurrentUrl,
  getAuth,
  allDevices,
  getPrefs,
  setPrefs,
  getBookmarks,
  loadBookmark,
  deleteBookmark,
}) {
  const deviceMap = new Map(allDevices().map((d) => [d.id, d]));
  const prefs = (getPrefs && getPrefs()) || { fitToScreen: true, fullPage: false };
  const resolved = QA_VIEWPORTS
    .map((vp) => ({ ...vp, device: deviceMap.get(vp.id) }))
    .filter((vp) => vp.device);

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    items: resolved.filter((vp) => vp.device.type === type),
  })).filter((g) => g.items.length);

  // Active sessions, keyed by `${engine}-${viewportId}`. Mirrors the
  // Rust-side LiveSessions HashMap; updated reactively from Tauri events.
  const liveSessions = new Set();

  container.innerHTML = `
    <div class="rt-viewports">
      <header class="rt-viewports__header">
        <div class="rt-viewports__intro">
          <p class="rt-viewports__sub">The 12 devices the Asana <em>Responsive pass</em> checklist covers — every $breakpoints boundary plus real-device anchors. Each launch opens a headed browser at the device's exact width × height. Screenshots dump to a fresh folder on your Desktop, ready to drag into Claude Code.</p>
        </div>
        <div class="rt-viewports__bar">
          <span class="rt-viewports__bar-count js-rt-vp-count">0 live sessions</span>
          <label class="rt-viewports__toggle" title="Scale devices larger than your screen down so they fit. Chrome + Firefox only — Safari (WebKit) ignores this.">
            <input type="checkbox" class="js-rt-vp-fit" ${prefs.fitToScreen ? 'checked' : ''} />
            <span>Fit to screen</span>
          </label>
          <label class="rt-viewports__toggle" title="Screenshot the full page rather than only the visible viewport.">
            <input type="checkbox" class="js-rt-vp-fullpage" ${prefs.fullPage ? 'checked' : ''} />
            <span>Full page</span>
          </label>
          <button class="rt-toolbar__btn js-rt-vp-shot-all">Screenshot all live</button>
          <button class="rt-toolbar__btn js-rt-vp-close-all">Close all</button>
        </div>
      </header>
      <div class="rt-viewports__bookmarks js-rt-vp-bookmarks"></div>
      ${grouped.map(renderGroup).join('')}
    </div>
  `;

  const countEl = container.querySelector('.js-rt-vp-count');
  const closeAllBtn = container.querySelector('.js-rt-vp-close-all');
  const shotAllBtn = container.querySelector('.js-rt-vp-shot-all');
  const fullPageEl = container.querySelector('.js-rt-vp-fullpage');
  const fitEl = container.querySelector('.js-rt-vp-fit');
  const bookmarksEl = container.querySelector('.js-rt-vp-bookmarks');

  // Persist toggle state so it survives app restarts.
  fitEl?.addEventListener('change', () => setPrefs?.({ fitToScreen: fitEl.checked }));
  fullPageEl?.addEventListener('change', () => setPrefs?.({ fullPage: fullPageEl.checked }));

  // ── Launch ──────────────────────────────────────────────────────────
  async function launchOne(engine, viewportId) {
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    const dev = deviceMap.get(viewportId);
    if (!dev) { flash(`Unknown viewport: ${viewportId}`, true); return; }
    const auth = getAuth ? (getAuth(hostOf(url)) || null) : null;
    const fitToScreen = !!fitEl?.checked;
    try {
      await invoke('qa_launch_session', {
        config: {
          url,
          engine,
          viewport: { id: dev.id, width: dev.w, height: dev.h, type: dev.type },
          auth,
          position: null,
          fitToScreen,
          // window.screen.avail* gives the host display's logical pixels
          // minus the menu bar / dock — exactly what the sidecar needs to
          // decide whether the viewport overflows.
          screenWidth: window.screen.availWidth,
          screenHeight: window.screen.availHeight,
        },
      });
      // session-ready event will populate liveSessions + re-render.
    } catch (err) {
      flash(`Launch ${engine} failed: ${err}`, true);
    }
  }

  container.querySelectorAll('.js-rt-vp-launch').forEach((btn) => {
    btn.addEventListener('click', () => {
      launchOne(btn.dataset.engine, btn.dataset.viewport);
    });
  });

  container.querySelectorAll('.js-rt-vp-launch-all').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const viewportId = btn.dataset.viewport;
      // Same pattern as QA Session: fire all three in parallel; the
      // sidecar dedupes per ${engine}-${viewportId}, so re-clicking
      // replaces the session rather than stacking.
      await Promise.all(ENGINES.map((e) => launchOne(e.engine, viewportId)));
    });
  });

  closeAllBtn.addEventListener('click', async () => {
    try { await invoke('qa_close_all_sessions'); }
    catch (err) { flash(String(err), true); }
  });

  // ── Screenshot ──────────────────────────────────────────────────────
  // Captures every supplied session into a fresh Desktop batch dir, then
  // reveals the dir in Finder when the sidecar(s) confirm save. The
  // sidecar emits `qa-screenshot-saved` async after writing the PNG, so
  // we wait for that event to arrive before opening Finder — otherwise
  // the user lands in an empty dir.
  const SHOT_TIMEOUT_MS = 8000;

  async function captureSessions(sessionIds) {
    if (!sessionIds.length) {
      flash('No live sessions to screenshot.', true);
      return;
    }
    const fullPage = !!fullPageEl?.checked;
    let batchDir;
    try {
      batchDir = await invoke('screenshot_batch_start');
    } catch (err) {
      flash(`Could not create screenshot folder: ${err}`, true);
      return;
    }

    // Wait for one screenshot-saved event per session before revealing
    // the batch dir. Resolves on count, rejects on timeout (rare — the
    // sidecar emits within ~50ms of the stdin command on a live page).
    let received = 0;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const stop = await listen('qa-screenshot-saved', () => {
      received += 1;
      if (received >= sessionIds.length) resolveDone();
    });
    const timeout = setTimeout(() => resolveDone(), SHOT_TIMEOUT_MS);

    try {
      for (const sessionId of sessionIds) {
        const [engine, ...vidParts] = sessionId.split('-');
        const vid = vidParts.join('-');
        const dev = deviceMap.get(vid);
        if (!dev) continue;
        const fileName = `${vid}-${dev.w}x${dev.h}-${engine}.png`;
        const outputPath = `${batchDir}/${fileName}`;
        try {
          await invoke('qa_screenshot_session', { sessionId, outputPath, fullPage });
        } catch (err) {
          flash(`Screenshot ${engine} ${dev.name} failed: ${err}`, true);
        }
      }
      await done;
    } finally {
      clearTimeout(timeout);
      stop();
    }

    if (received === 0) {
      flash('No screenshots written — sidecar didn\'t respond.', true);
      return;
    }
    flash(`Saved ${received}/${sessionIds.length} screenshot${received === 1 ? '' : 's'}. Revealing folder…`);
    try { await invoke('reveal_in_finder', { path: batchDir }); }
    catch (err) { flash(`Could not open folder: ${err}`, true); }
  }

  shotAllBtn.addEventListener('click', () => captureSessions([...liveSessions]));

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.js-rt-vp-shot-card');
    if (!btn) return;
    const vid = btn.dataset.viewport;
    const ids = [...liveSessions].filter((id) => id.endsWith(`-${vid}`));
    if (!ids.length) {
      flash(`No live sessions for ${deviceMap.get(vid)?.name || vid}.`, true);
      return;
    }
    captureSessions(ids);
  });

  // ── Live-session indicators ─────────────────────────────────────────
  function renderLiveState() {
    countEl.textContent = liveSessions.size === 1
      ? '1 live session'
      : `${liveSessions.size} live sessions`;
    closeAllBtn.disabled = liveSessions.size === 0;
    shotAllBtn.disabled = liveSessions.size === 0;

    container.querySelectorAll('.rt-viewport-card').forEach((card) => {
      const vid = card.dataset.viewport;
      let cardLive = false;
      ENGINES.forEach((e) => {
        const id = `${e.engine}-${vid}`;
        const isLive = liveSessions.has(id);
        if (isLive) cardLive = true;
        const btn = card.querySelector(`.js-rt-vp-launch[data-engine="${e.engine}"]`);
        if (btn) {
          btn.classList.toggle('is-live', isLive);
          btn.title = isLive
            ? `Re-launch ${e.label} at ${card.dataset.dims} (replaces existing session)`
            : `Open URL in ${e.label} sized to ${card.dataset.dims}`;
        }
      });
      card.classList.toggle('is-live', cardLive);
      const shotBtn = card.querySelector('.js-rt-vp-shot-card');
      if (shotBtn) shotBtn.hidden = !cardLive;
    });
  }

  listen('qa-session-ready', (e) => {
    const id = e.payload?.sessionId;
    if (!id) return;
    liveSessions.add(id);
    renderLiveState();
  });
  listen('qa-session-closed', (e) => {
    const id = e.payload?.sessionId;
    if (!id) return;
    liveSessions.delete(id);
    renderLiveState();
  });
  // Surface non-fatal sidecar warnings (e.g. WebKit doesn't support
  // fit-to-screen) so the user knows why a window isn't behaving.
  listen('qa-session-warning', (e) => {
    const msg = e.payload?.message;
    if (msg) flash(String(msg), true);
  });

  async function refreshSessions() {
    try {
      const ids = await invoke('qa_list_sessions');
      liveSessions.clear();
      ids.forEach((id) => liveSessions.add(id));
      renderLiveState();
    } catch { /* ignore */ }
  }

  // ── Bookmarks strip ─────────────────────────────────────────────────
  // Surfaces saved bookmarks above the device cards so they're reachable
  // from this tab — without this, bookmarks only show in the Preview-mode
  // sidebar, which is invisible while you're working in the Devices tab.
  function renderBookmarks() {
    if (!bookmarksEl) return;
    const bookmarks = (getBookmarks && getBookmarks()) || [];
    if (!bookmarks.length) {
      bookmarksEl.innerHTML = '<span class="rt-viewports__bookmarks-empty">No bookmarks yet — click the bookmark icon in the toolbar to save the current URL.</span>';
      return;
    }
    bookmarksEl.innerHTML = bookmarks.map((b, i) => `
      <span class="rt-viewports__bm" data-index="${i}">
        <button class="rt-viewports__bm-load js-rt-vp-bm-load" data-index="${i}" title="${escapeAttr(b.url)}">${escapeHtml(b.label)}</button>
        <button class="rt-viewports__bm-del js-rt-vp-bm-del" data-index="${i}" aria-label="Delete bookmark">×</button>
      </span>
    `).join('');
  }

  bookmarksEl?.addEventListener('click', (e) => {
    const load = e.target.closest('.js-rt-vp-bm-load');
    if (load && loadBookmark) {
      const i = Number(load.dataset.index);
      const bookmarks = (getBookmarks && getBookmarks()) || [];
      if (bookmarks[i]) loadBookmark(bookmarks[i].url);
      return;
    }
    const del = e.target.closest('.js-rt-vp-bm-del');
    if (del && deleteBookmark) {
      deleteBookmark(Number(del.dataset.index));
      renderBookmarks();
    }
  });

  // Navigate every live Playwright window to the new URL. Called by
  // main.js when the user changes the URL in the toolbar — without this
  // the iframe grid reloads but the live windows stay on the old page.
  async function broadcastUrl(url) {
    if (!url || !liveSessions.size) return;
    try {
      const ids = await invoke('qa_list_sessions');
      await Promise.all(
        ids.map((id) => invoke('qa_navigate_session', { sessionId: id, url })),
      );
    } catch (err) {
      console.warn('[viewports] broadcastUrl failed:', err);
    }
  }

  refreshSessions();
  renderLiveState();
  renderBookmarks();

  return { refreshSessions, broadcastUrl, renderBookmarks };
}

function renderGroup({ type, items }) {
  return `
    <section class="rt-viewports__group">
      <h3 class="rt-viewports__group-title">${TYPE_LABEL[type]}</h3>
      <div class="rt-viewports__grid">
        ${items.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard({ device, note }) {
  const dims = `${device.w}×${device.h}`;
  return `
    <article class="rt-viewport-card" data-type="${device.type}" data-viewport="${escapeAttr(device.id)}" data-dims="${dims}">
      <div class="rt-viewport-card__head">
        <div class="rt-viewport-card__name">${escapeHtml(device.name)}</div>
        <div class="rt-viewport-card__dims">${device.w} × ${device.h}</div>
      </div>
      <div class="rt-viewport-card__note">${escapeHtml(note)}</div>
      <div class="rt-viewport-card__launch">
        ${ENGINES.map((e) => `
          <button
            class="rt-viewport-card__btn js-rt-vp-launch"
            data-engine="${e.engine}"
            data-viewport="${escapeAttr(device.id)}"
            title="Open URL in ${e.label} sized to ${dims}"
          >
            <span class="rt-browser-dot rt-browser-dot--${e.dot}" aria-hidden="true"></span>
            <span>${e.label}</span>
            <span class="rt-viewport-card__btn-live" aria-hidden="true"></span>
          </button>
        `).join('')}
      </div>
      <div class="rt-viewport-card__actions">
        <button
          class="rt-viewport-card__all js-rt-vp-launch-all"
          data-viewport="${escapeAttr(device.id)}"
          title="Launch Safari + Chrome + Firefox at ${dims}"
        >Launch all engines</button>
        <button
          class="rt-viewport-card__shot js-rt-vp-shot-card"
          data-viewport="${escapeAttr(device.id)}"
          title="Screenshot every live engine for ${dims}"
          hidden
        >Screenshot</button>
      </div>
    </article>
  `;
}
