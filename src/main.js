import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';

import {
  escapeHtml, escapeAttr, slug, flash, normaliseUrl, hostOf, isoSlug, LoadQueue,
} from './features/utils.js';
import {
  injectFilterDefs, applyColorBlindFilter, renderGridOverlay,
  renderRefImage, pickImageAsDataUrl, CB_OPTIONS,
} from './features/overlays.js';
import { openPanel, clearPanelCache } from './features/panels.js';
import { wireContrastWidget } from './features/contrast.js';
import { icon } from './features/icons.js';

// ── Device matrix (April 2026) ──────────────────────────────────────
const DEFAULT_DEVICES = [
  { id: 'galaxy-s24',        name: 'Galaxy S24',            w: 360,  h: 780,  type: 'mobile' },
  { id: 'iphone-se',         name: 'iPhone SE',             w: 375,  h: 667,  type: 'mobile' },
  { id: 'z-fold-cover',      name: 'Galaxy Z Fold (cover)', w: 344,  h: 882,  type: 'mobile' },
  { id: 'iphone-16',         name: 'iPhone 16',             w: 393,  h: 852,  type: 'mobile' },
  { id: 'iphone-16-pro',     name: 'iPhone 16 Pro',         w: 402,  h: 874,  type: 'mobile' },
  { id: 'pixel-9',           name: 'Pixel 9',               w: 412,  h: 915,  type: 'mobile' },
  { id: 'galaxy-s25',        name: 'Galaxy S25',            w: 412,  h: 915,  type: 'mobile' },
  { id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max',     w: 440,  h: 956,  type: 'mobile' },
  { id: 'ipad-mini-7',       name: 'iPad Mini 7',           w: 744,  h: 1133, type: 'tablet' },
  { id: 'z-fold-open',       name: 'Galaxy Z Fold (open)',  w: 884,  h: 1168, type: 'tablet' },
  { id: 'galaxy-tab-s9',     name: 'Galaxy Tab S9',         w: 800,  h: 1280, type: 'tablet' },
  { id: 'ipad-air-m3',       name: 'iPad Air M3',           w: 820,  h: 1180, type: 'tablet' },
  { id: 'ipad-pro-11-m4',    name: 'iPad Pro 11" M4',       w: 834,  h: 1194, type: 'tablet' },
  { id: 'ipad-pro-13-m4',    name: 'iPad Pro 13" M4',       w: 1032, h: 1376, type: 'tablet' },
  { id: 'macbook-air-13',    name: 'MacBook Air 13"',       w: 1280, h: 832,  type: 'desktop' },
  { id: 'laptop-hd',         name: 'Laptop HD',             w: 1366, h: 768,  type: 'desktop' },
  { id: 'macbook-pro-14',    name: 'MacBook Pro 14"',       w: 1512, h: 982,  type: 'desktop' },
  { id: 'macbook-pro-16',    name: 'MacBook Pro 16"',       w: 1728, h: 1117, type: 'desktop' },
  { id: 'full-hd',           name: 'Full HD',               w: 1920, h: 1080, type: 'desktop' },
  { id: 'qhd-1440p',         name: '1440p QHD',             w: 2560, h: 1440, type: 'desktop' },
];

const TYPE_LABEL = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };
const TYPES = ['mobile', 'tablet', 'desktop'];
const STORAGE_KEY = 'rt-state-v3';
const MAX_RECENT = 8;
const LOAD_TIMEOUT_MS = 20000;

// ── State ───────────────────────────────────────────────────────────
const defaults = () => ({
  url: '',
  scale: 0.4,
  filter: 'mobile',
  enabled: DEFAULT_DEVICES.reduce((acc, d) => { acc[d.id] = true; return acc; }, {}),
  rotated: {},
  customDevices: [],
  bookmarks: [],
  recent: [],
  auth: {},
  syncScroll: true,
  layoutMode: 'grid',
  cbFilter: 'none',
  gridOverlay: 0,
  darkPair: false,
  dims: {},
  refImages: {},
  workspaces: [],
  videoDuration: 15,
  toolbarsHidden: false,
  sidebarHidden: false,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const merged = { ...defaults(), ...JSON.parse(raw) };
    // One-off migration: sync-scroll is meant to be on by default. Users
    // whose persisted state has it stuck off from an earlier version get
    // flipped back once. Subsequent toggles are respected normally.
    if (!merged._migratedSyncDefault) {
      merged.syncScroll = true;
      merged._migratedSyncDefault = true;
    }
    return merged;
  } catch {
    return defaults();
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

const state = loadState();
// Persist immediately if loadState did a migration, so the reset sticks.
saveState();

// Memoised allDevices — the result is a fresh array every call in older
// code (hot in applyScale/applyVisibility). Cache it and invalidate when
// customDevices changes. invalidateDevices() is called anywhere state
// mutations affect the device list (addCustomDevice, deleteCustomDevice,
// workspace load).
let _allDevicesCache = null;
function allDevices() {
  if (_allDevicesCache) return _allDevicesCache;
  _allDevicesCache = [...DEFAULT_DEVICES, ...state.customDevices];
  return _allDevicesCache;
}
function invalidateDevices() { _allDevicesCache = null; }

// ── DOM refs ────────────────────────────────────────────────────────
const grid = document.querySelector('.js-rt-grid');
const sidebar = document.querySelector('.js-rt-sidebar');
const urlInput = document.querySelector('.js-rt-url');
const recentList = document.querySelector('#rt-recent');
const loadBtn = document.querySelector('.js-rt-load');
const refreshBtn = document.querySelector('.js-rt-refresh');
const bookmarkBtn = document.querySelector('.js-rt-bookmark');
const snapAllBtn = document.querySelector('.js-rt-screenshot-all');
const settingsBtn = document.querySelector('.js-rt-settings');
const syncBtn = document.querySelector('.js-rt-sync');
const filterBtns = document.querySelectorAll('.js-rt-filter');
const scaleInput = document.querySelector('.js-rt-scale');
const scaleValue = document.querySelector('.js-rt-scale-value');
const settingsPanel = document.querySelector('.js-rt-settings-panel');
const settingsClose = document.querySelector('.js-rt-settings-close');
const cbSelect = document.querySelector('.js-rt-cb');
const gridOverlayBtn = document.querySelector('.js-rt-grid-overlay');
const darkPairBtn = document.querySelector('.js-rt-darkpair');
const layoutBtns = document.querySelectorAll('.js-rt-layout');
const videoBtn = document.querySelector('.js-rt-video');
const videoDurationSelect = document.querySelector('.js-rt-video-duration');
const hideToolbarsBtn = document.querySelector('.js-rt-hide-toolbars');
const revealToolbarsBtn = document.querySelector('.js-rt-reveal-toolbars');
const workspaceList = document.querySelector('.js-rt-workspaces');
const workspaceNameInput = document.querySelector('.js-rt-workspace-name');
const workspaceSaveBtn = document.querySelector('.js-rt-workspace-save');
const clearRecentBtn = document.querySelector('.js-rt-clear-recent');
const hideSidebarBtn = document.querySelector('.js-rt-hide-sidebar');
const revealSidebarBtn = document.querySelector('.js-rt-reveal-sidebar');
const inspectPanel = document.querySelector('.js-rt-inspect-panel');
const inspectClose = document.querySelector('.js-rt-inspect-close');
const inspectBody = document.querySelector('.js-rt-inspect-body');
const inspectTabs = document.querySelectorAll('.js-rt-inspect-tab');
const panelBtns = document.querySelectorAll('.js-rt-panel-open');

// ── URL + host + auth helpers ──────────────────────────────────────
function applyAuth(url) {
  try {
    const u = new URL(url);
    const creds = state.auth[u.host];
    if (creds && !u.username) {
      u.username = creds.user;
      u.password = creds.pass;
    }
    return u.toString();
  } catch { return url; }
}

// Dimensions honour: custom dims override > rotation > default.
function dimsFor(d) {
  const override = state.dims[d.id];
  if (override) return { w: override.w, h: override.h };
  return state.rotated[d.id] ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}

// ── Sidebar ─────────────────────────────────────────────────────────
function buildSidebar() {
  const bookmarkRows = state.bookmarks.length === 0
    ? '<div class="rt-sidebar__empty">No bookmarks yet.</div>'
    : state.bookmarks.map((b, i) => `
        <div class="rt-sidebar__bookmark">
          <button class="rt-sidebar__bookmark-load js-rt-bm-load" data-index="${i}" title="${escapeAttr(b.url)}">${escapeHtml(b.label)}</button>
          <button class="rt-sidebar__bookmark-del js-rt-bm-del" data-index="${i}" aria-label="Delete bookmark">×</button>
        </div>
      `).join('');

  const deviceSections = TYPES.map((type) => {
    const rows = allDevices().filter((d) => d.type === type).map((d) => {
      const isCustom = d.id.startsWith('custom-');
      return `
        <label class="rt-sidebar__toggle">
          <input type="checkbox" data-device="${d.id}" ${state.enabled[d.id] !== false ? 'checked' : ''}>
          <span class="rt-sidebar__toggle-name">${escapeHtml(d.name)}</span>
          <span class="rt-sidebar__toggle-dims">${d.w}</span>
          ${isCustom ? `<button class="rt-sidebar__toggle-del js-rt-custom-del" data-id="${d.id}" aria-label="Remove custom device">×</button>` : ''}
        </label>
      `;
    }).join('');
    return `
      <div class="rt-sidebar__section">
        <div class="rt-sidebar__title"><span class="rt-dot rt-dot--${type}"></span>${TYPE_LABEL[type]}</div>
        ${rows}
      </div>
    `;
  }).join('');

  sidebar.innerHTML = `
    <div class="rt-sidebar__header">
      <span class="rt-sidebar__header-title">Devices</span>
      <button class="rt-sidebar__hide js-rt-hide-sidebar" title="Hide sidebar (⌘B)" aria-label="Hide sidebar" data-icon="panel-left-close"></button>
    </div>
    <div class="rt-sidebar__section">
      <div class="rt-sidebar__title">Bookmarks</div>
      ${bookmarkRows}
    </div>
    ${deviceSections}
  `;

  hydrateIcons(sidebar);
  sidebar.querySelector('.js-rt-hide-sidebar').addEventListener('click', () => toggleSidebar());

  sidebar.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      state.enabled[cb.dataset.device] = cb.checked;
      saveState();
      applyVisibility();
    });
  });
  sidebar.querySelectorAll('.js-rt-bm-load').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bm = state.bookmarks[Number(btn.dataset.index)];
      if (!bm) return;
      urlInput.value = bm.url;
      loadUrl();
    });
  });
  sidebar.querySelectorAll('.js-rt-bm-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.bookmarks.splice(Number(btn.dataset.index), 1);
      saveState();
      buildSidebar();
    });
  });
  sidebar.querySelectorAll('.js-rt-custom-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      state.customDevices = state.customDevices.filter((d) => d.id !== id);
      delete state.enabled[id];
      delete state.rotated[id];
      delete state.dims[id];
      delete state.refImages[id];
      invalidateDevices();
      saveState();
      buildAll();
    });
  });
}

// ── Grid ────────────────────────────────────────────────────────────
function deviceCardHtml(d, variantKey = '', variantLabel = '') {
  const domId = variantKey ? `${d.id}__${variantKey}` : d.id;
  const { w, h } = dimsFor(d);
  const tag = variantLabel ? `<span class="rt-device__variant">${escapeHtml(variantLabel)}</span>` : '';
  return `
    <div class="rt-device" data-type="${d.type}" data-id="${domId}" data-src-id="${d.id}" data-variant="${variantKey}">
      <div class="rt-device__label">
        <span class="rt-device__label-name">
          <span class="rt-dot rt-dot--${d.type}"></span>${escapeHtml(d.name)}${tag}
        </span>
        <span class="rt-device__dims js-rt-dims">${w} × ${h}</span>
      </div>
      <div class="rt-device__actions">
        <button class="rt-device__ctrl js-rt-rotate" data-id="${d.id}" title="Rotate" aria-label="Rotate">${icon('rotate-cw')}</button>
        <button class="rt-device__ctrl js-rt-ref" data-id="${d.id}" title="Reference image" aria-label="Reference image">${icon('image')}</button>
        <button class="rt-device__ctrl js-rt-reload" data-id="${domId}" title="Reload this frame" aria-label="Reload">${icon('refresh-cw')}</button>
        <button class="rt-device__ctrl js-rt-max" data-id="${domId}" title="Focus" aria-label="Focus">${icon('maximize')}</button>
        <button class="rt-device__ctrl js-rt-snap" data-id="${domId}" title="Screenshot" aria-label="Screenshot">${icon('camera')}</button>
      </div>
      <div class="rt-device__shell">
        <iframe class="rt-device__frame" title="${escapeAttr(d.name)} preview" loading="lazy"></iframe>
        <div class="rt-device__overlay" hidden></div>
        <div class="rt-device__resize" aria-label="Resize"></div>
      </div>
    </div>
  `;
}

function buildGrid() {
  grid.innerHTML = allDevices().map((d) => {
    if (state.darkPair) {
      return deviceCardHtml(d, '', 'LIGHT') + deviceCardHtml(d, 'dark', 'DARK');
    }
    return deviceCardHtml(d);
  }).join('');

  grid.querySelectorAll('.js-rt-rotate').forEach((btn) =>
    btn.addEventListener('click', () => rotateDevice(btn.dataset.id)));
  grid.querySelectorAll('.js-rt-ref').forEach((btn) =>
    btn.addEventListener('click', () => toggleRefImage(btn.dataset.id)));
  grid.querySelectorAll('.js-rt-reload').forEach((btn) =>
    btn.addEventListener('click', () => reloadFrame(btn.dataset.id)));
  grid.querySelectorAll('.js-rt-max').forEach((btn) =>
    btn.addEventListener('click', () => toggleMaximize(btn.dataset.id)));
  grid.querySelectorAll('.js-rt-snap').forEach((btn) =>
    btn.addEventListener('click', () => screenshotDevice(btn.dataset.id)));

  grid.querySelectorAll('.rt-device').forEach((wrap) => {
    const handle = wrap.querySelector('.rt-device__resize');
    if (handle) attachResize(wrap, handle);
  });

  hydrateIcons(grid);

  setLayoutMode(state.layoutMode, false);
  applyScale();
  applyVisibility();
  applyRefImages();
  applyGridOverlays();
  if (state.url) loadUrl({ skipStateUpdate: true });
}

function buildAll() {
  buildSidebar();
  buildGrid();
}

// ── Scale + visibility ──────────────────────────────────────────────
// applyScale can fire 60+ times/sec while dragging the scale slider. Cache
// the device DOM refs on the wrapper element (once), look up the device
// model via a map rather than Array.find(), and read state.scale once so
// we don't thrash on every input event.
function getDeviceRefs(wrap) {
  if (!wrap._rtRefs) {
    wrap._rtRefs = {
      shell: wrap.querySelector('.rt-device__shell'),
      iframe: wrap.querySelector('.rt-device__frame'),
      dims: wrap.querySelector('.js-rt-dims'),
    };
  }
  return wrap._rtRefs;
}

function applyScale() {
  const scale = state.scale;
  const deviceMap = new Map(allDevices().map((d) => [d.id, d]));
  const wraps = grid.querySelectorAll('.rt-device');
  for (let i = 0; i < wraps.length; i++) {
    const wrap = wraps[i];
    const d = deviceMap.get(wrap.dataset.srcId);
    if (!d) continue;
    const { w, h } = dimsFor(d);
    const { shell, iframe, dims } = getDeviceRefs(wrap);
    const scaledW = Math.round(w * scale);
    const scaledH = Math.round(h * scale);
    shell.style.width = `${scaledW + 16}px`;
    shell.style.height = `${scaledH + 16}px`;
    iframe.style.width = `${w}px`;
    iframe.style.height = `${h}px`;
    iframe.style.transform = `scale(${scale})`;
    if (dims) dims.textContent = `${w} × ${h}`;
  }
}

// Hidden iframes still run JS + keep their pages in memory, which makes the
// grid of 20 devices heavy. When a device goes hidden we unload its iframe
// to about:blank; when it comes back into view we reload it with the current
// URL. This trades network requests for much lower steady-state load.
// Uses the same Map-lookup + cached refs approach as applyScale to avoid
// O(devices²) on filter/toggle changes.
function applyVisibility() {
  const deviceMap = new Map(allDevices().map((d) => [d.id, d]));
  const wraps = grid.querySelectorAll('.rt-device');
  for (let i = 0; i < wraps.length; i++) {
    const wrap = wraps[i];
    const d = deviceMap.get(wrap.dataset.srcId);
    if (!d) continue;
    const matchesFilter = state.filter === 'all' || state.filter === d.type;
    const show = state.enabled[d.id] !== false && matchesFilter;
    const wasHidden = wrap.classList.contains('is-hidden');
    wrap.classList.toggle('is-hidden', !show);
    const { iframe } = getDeviceRefs(wrap);
    if (!show) {
      if (iframe.src && iframe.src !== 'about:blank') iframe.src = 'about:blank';
    } else if (wasHidden && state.url) {
      const isDark = wrap.dataset.variant === 'dark';
      loadQueue.add(() => loadFrame(iframe, wrap, state.url, isDark));
    }
  }
}

function applyRefImages() {
  grid.querySelectorAll('.rt-device').forEach((wrap) => {
    const id = wrap.dataset.srcId;
    const shell = wrap.querySelector('.rt-device__shell');
    renderRefImage(shell, state.refImages[id]);
  });
}

function applyGridOverlays() {
  grid.querySelectorAll('.rt-device__shell').forEach((shell) => {
    renderGridOverlay(shell, state.gridOverlay);
  });
}

// ── Per-device actions ──────────────────────────────────────────────
function rotateDevice(id) {
  state.rotated[id] = !state.rotated[id];
  delete state.dims[id];
  saveState();
  applyScale();
  reloadFrames(id);
}

function reloadFrame(domId) {
  if (!state.url) return;
  const wrap = grid.querySelector(`.rt-device[data-id="${CSS.escape(domId)}"]`);
  if (!wrap) return;
  const iframe = wrap.querySelector('.rt-device__frame');
  const isDark = wrap.dataset.variant === 'dark';
  loadQueue.add(() => loadFrame(iframe, wrap, state.url, isDark));
}

function reloadFrames(srcId) {
  if (!state.url) return;
  grid.querySelectorAll(`.rt-device[data-src-id="${CSS.escape(srcId)}"]`).forEach((wrap) => {
    const iframe = wrap.querySelector('.rt-device__frame');
    const isDark = wrap.dataset.variant === 'dark';
    loadQueue.add(() => loadFrame(iframe, wrap, state.url, isDark));
  });
}

function toggleMaximize(domId) {
  const wrap = grid.querySelector(`.rt-device[data-id="${CSS.escape(domId)}"]`);
  if (!wrap) return;
  const isMax = wrap.classList.toggle('is-maximized');
  document.body.classList.toggle('rt-body--focus', isMax);
  if (isMax) {
    document.querySelectorAll('.rt-device.is-maximized').forEach((el) => {
      if (el !== wrap) el.classList.remove('is-maximized');
    });
  }
}

function exitMaximize() {
  document.querySelectorAll('.rt-device.is-maximized').forEach((el) => el.classList.remove('is-maximized'));
  document.body.classList.remove('rt-body--focus');
}

// ── Drag-to-resize ──────────────────────────────────────────────────
// Resize updates only the dragged device's own shell/iframe, batched via rAF.
// Saves and a single applyScale() happen on mouseup.
function attachResize(wrap, handle) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const d = allDevices().find((x) => x.id === wrap.dataset.srcId);
    if (!d) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startDims = dimsFor(d);
    const scale = state.scale;
    const shell = wrap.querySelector('.rt-device__shell');
    const iframe = wrap.querySelector('.rt-device__frame');
    const dimsLabel = wrap.querySelector('.js-rt-dims');
    let rafId = null;
    let pendingW = startDims.w;
    let pendingH = startDims.h;

    const flush = () => {
      rafId = null;
      const scaledW = Math.round(pendingW * scale);
      const scaledH = Math.round(pendingH * scale);
      shell.style.width = `${scaledW + 16}px`;
      shell.style.height = `${scaledH + 16}px`;
      iframe.style.width = `${pendingW}px`;
      iframe.style.height = `${pendingH}px`;
      if (dimsLabel) dimsLabel.textContent = `${pendingW} × ${pendingH}`;
    };

    const onMove = (me) => {
      pendingW = Math.max(200, Math.round(startDims.w + (me.clientX - startX) / scale));
      pendingH = Math.max(200, Math.round(startDims.h + (me.clientY - startY) / scale));
      if (rafId == null) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId != null) cancelAnimationFrame(rafId);
      state.dims[d.id] = { w: pendingW, h: pendingH };
      saveState();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── Load ────────────────────────────────────────────────────────────
// Returns a promise that resolves when the iframe fires load/error or the
// timeout elapses — used by LoadQueue to stagger concurrent loads.
const loadQueue = new LoadQueue(4);

// Wire the queue to a top-left progress toast so the user sees how many
// iframes are still loading when they hit Load on a 15+ device workspace.
const loadProgress = document.querySelector('.js-rt-load-progress');
const loadProgressFill = document.querySelector('.js-rt-load-progress-fill');
const loadProgressLabel = document.querySelector('.js-rt-load-progress-label');
let loadProgressHideTimer = null;
loadQueue.onProgress = ({ completed, total }) => {
  if (!loadProgress || !loadProgressFill || !loadProgressLabel) return;
  if (total === 0) { loadProgress.hidden = true; return; }
  loadProgress.hidden = false;
  const pct = Math.round((completed / total) * 100);
  loadProgressFill.style.width = `${pct}%`;
  loadProgressLabel.textContent = `Loading ${completed}/${total} frames`;
  if (completed >= total) {
    if (loadProgressHideTimer) clearTimeout(loadProgressHideTimer);
    loadProgressHideTimer = setTimeout(() => {
      loadProgress.hidden = true;
      loadQueue.total = 0;
      loadQueue.completed = 0;
    }, 800);
  }
};

// Inject the sync-scroll bridge into an iframe's document. Only works on
// same-origin iframes — we check origins up-front and bail silently on
// cross-origin so the browser doesn't log a SecurityError from
// contentDocument access. For cross-origin sites, the bridge must be
// shipped by the site itself (every Kobe client theme does).
function injectSyncBridge(iframe) {
  // Skip silently if iframe src is clearly a different origin.
  try {
    const iframeUrl = new URL(iframe.src, location.href);
    if (iframeUrl.origin !== location.origin) return;
  } catch { return; }
  const doc = iframe.contentDocument;
  if (!doc) return;
  if (doc.querySelector('[data-rt-bridge]')) return;
  const s = doc.createElement('script');
  s.setAttribute('data-rt-bridge', '');
  s.textContent = `
    (function () {
      if (window.__rtBridge) return;
      window.__rtBridge = true;
      window.addEventListener('scroll', function () {
        parent.postMessage({ rt: 'scroll', x: scrollX, y: scrollY }, '*');
      }, { passive: true });
      window.addEventListener('message', function (e) {
        if (e.data && e.data.rt === 'scroll') window.scrollTo(e.data.x, e.data.y);
      });
    })();
  `;
  doc.head.appendChild(s);
}

function loadFrame(iframe, wrap, url, isDark = false) {
  return new Promise((resolve) => {
    const overlay = wrap.querySelector('.rt-device__overlay');
    overlay.hidden = true;
    overlay.innerHTML = '';

    const sep = url.indexOf('?') > -1 ? '&' : '?';
    const bust = `_rt=${Date.now()}`;
    const params = isDark ? `${bust}&color-scheme=dark` : bust;
    const finalUrl = `${applyAuth(url)}${sep}${params}`;

    if (isDark) iframe.style.filter = 'invert(1) hue-rotate(180deg)';
    else iframe.style.filter = '';

    // Spinner while loading
    wrap.classList.add('is-loading');

    let loaded = false;
    let timedOut = false;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; wrap.classList.remove('is-loading'); resolve(); } };

    const timer = setTimeout(() => {
      if (loaded) return;
      timedOut = true;
      showFrameError(
        overlay,
        'Taking a while…',
        'If the site eventually loads, this will clear. Otherwise it may refuse framing (Content-Security-Policy: frame-ancestors / X-Frame-Options).',
        () => loadFrame(iframe, wrap, url, isDark),
      );
      settle();
    }, LOAD_TIMEOUT_MS);

    iframe.addEventListener('load', () => {
      loaded = true;
      clearTimeout(timer);
      if (timedOut) { overlay.hidden = true; overlay.innerHTML = ''; }
      // Best-effort sync-scroll bridge injection: works on same-origin
      // sites or sites that don't block contentDocument access. Cross-
      // origin sites must ship the bridge themselves (all Kobe client
      // themes already do — see studio-sync memory). Swallow access
      // errors silently.
      try { injectSyncBridge(iframe); } catch { /* cross-origin */ }
      settle();
    }, { once: true });

    iframe.addEventListener('error', () => {
      clearTimeout(timer);
      if (loaded) { settle(); return; }
      showFrameError(
        overlay,
        'Failed to load',
        'Network error or frame blocked. Check the URL and your connection.',
        () => loadFrame(iframe, wrap, url, isDark),
      );
      settle();
    }, { once: true });

    iframe.src = finalUrl;
  });
}

function showFrameError(overlay, title, body, onRetry) {
  overlay.hidden = false;
  overlay.innerHTML = `
    <div class="rt-device__error">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(body)}</span>
      <div class="rt-device__error-actions">
        <button class="rt-device__error-btn js-rt-err-retry">Retry</button>
        <button class="rt-device__error-btn js-rt-err-dismiss">Dismiss</button>
      </div>
    </div>
  `;
  overlay.querySelector('.js-rt-err-retry').addEventListener('click', () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
    onRetry?.();
  });
  overlay.querySelector('.js-rt-err-dismiss').addEventListener('click', () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
  });
}

function loadUrl(opts = {}) {
  const url = normaliseUrl(urlInput.value);
  if (!url) return;
  urlInput.value = url;
  state.url = url;

  if (!opts.skipStateUpdate) {
    state.recent = [url, ...state.recent.filter((u) => u !== url)].slice(0, MAX_RECENT);
    saveState();
    renderRecent();
    clearPanelCache();
  }

  // Staggered load: push each visible frame into the queue at concurrency 4.
  loadQueue.clear();
  grid.querySelectorAll('.rt-device:not(.is-hidden)').forEach((wrap) => {
    const iframe = wrap.querySelector('.rt-device__frame');
    const isDark = wrap.dataset.variant === 'dark';
    loadQueue.add(() => loadFrame(iframe, wrap, url, isDark));
  });
}

function renderRecent() {
  recentList.innerHTML = state.recent.map((u) => `<option value="${escapeAttr(u)}"></option>`).join('');
}

// ── Bookmarks ───────────────────────────────────────────────────────
function addBookmark() {
  const url = normaliseUrl(urlInput.value);
  if (!url) return;
  const label = prompt('Bookmark label:', hostOf(url) || url);
  if (!label) return;
  state.bookmarks.push({ label, url });
  saveState();
  buildSidebar();
}

// ── Settings panel ──────────────────────────────────────────────────
function openSettings() {
  settingsPanel.hidden = false;
  renderAuthList();
}
function closeSettings() { settingsPanel.hidden = true; }

function renderAuthList() {
  const list = document.querySelector('.js-rt-auth-list');
  const hosts = Object.keys(state.auth);
  list.innerHTML = hosts.length === 0
    ? '<li class="rt-settings__empty">No saved credentials.</li>'
    : hosts.map((h) => `
        <li>
          <code>${escapeHtml(h)}</code>
          <span class="rt-settings__auth-user">${escapeHtml(state.auth[h].user)}</span>
          <button class="js-rt-auth-del" data-host="${escapeAttr(h)}">Remove</button>
        </li>
      `).join('');
  list.querySelectorAll('.js-rt-auth-del').forEach((btn) =>
    btn.addEventListener('click', () => {
      delete state.auth[btn.dataset.host];
      saveState();
      renderAuthList();
    }));
}

function saveAuth() {
  const host = document.querySelector('.js-rt-auth-host').value.trim();
  const user = document.querySelector('.js-rt-auth-user').value;
  const pass = document.querySelector('.js-rt-auth-pass').value;
  if (!host || !user) return;
  state.auth[host] = { user, pass };
  saveState();
  ['host', 'user', 'pass'].forEach((k) => { document.querySelector(`.js-rt-auth-${k}`).value = ''; });
  renderAuthList();
}

function addCustomDevice() {
  const name = document.querySelector('.js-rt-custom-name').value.trim();
  const w = parseInt(document.querySelector('.js-rt-custom-w').value, 10);
  const h = parseInt(document.querySelector('.js-rt-custom-h').value, 10);
  const type = document.querySelector('.js-rt-custom-type').value;
  if (!name || !w || !h) return;
  const id = `custom-${Date.now()}`;
  state.customDevices.push({ id, name, w, h, type });
  state.enabled[id] = true;
  invalidateDevices();
  saveState();
  ['name', 'w', 'h'].forEach((k) => { document.querySelector(`.js-rt-custom-${k}`).value = ''; });
  buildAll();
}

// ── Reference image ─────────────────────────────────────────────────
async function toggleRefImage(id) {
  if (state.refImages[id]) {
    delete state.refImages[id];
    saveState();
    applyRefImages();
    flash('Reference image removed.');
    return;
  }
  const dataUrl = await pickImageAsDataUrl();
  if (!dataUrl) return;
  state.refImages[id] = { dataUrl, opacity: 0.5 };
  saveState();
  applyRefImages();
  flash('Reference image added. Use ⌘[ / ⌘] to change opacity.');
}

function adjustRefOpacity(delta) {
  const keys = Object.keys(state.refImages);
  if (keys.length === 0) return;
  keys.forEach((id) => {
    const cur = state.refImages[id].opacity ?? 0.5;
    state.refImages[id].opacity = Math.max(0, Math.min(1, cur + delta));
  });
  saveState();
  applyRefImages();
}

// ── Screenshots ─────────────────────────────────────────────────────
function screenshotLabel(d, variant) {
  const host = slug(hostOf(state.url)) || 'no-url';
  const dev = slug(d?.name || '');
  const v = variant ? `-${variant}` : '';
  return `${host}-${dev}${v}-${isoSlug()}`;
}

async function screenshotDevice(domId) {
  const wrap = grid.querySelector(`.rt-device[data-id="${CSS.escape(domId)}"]`);
  if (!wrap) return;
  const shell = wrap.querySelector('.rt-device__shell');
  const rect = shell.getBoundingClientRect();
  const d = allDevices().find((x) => x.id === wrap.dataset.srcId);
  try {
    const path = await invoke('screenshot_region', {
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
      label: screenshotLabel(d, wrap.dataset.variant),
    });
    flash(`Saved: ${path}`);
  } catch (err) {
    flash(`Screenshot failed: ${err}`, true);
  }
}

async function screenshotAll() {
  const visible = [...grid.querySelectorAll('.rt-device:not(.is-hidden)')];
  if (visible.length === 0) return;
  try {
    const batchDir = await invoke('screenshot_batch_start');
    for (const wrap of visible) {
      const rect = wrap.querySelector('.rt-device__shell').getBoundingClientRect();
      const d = allDevices().find((x) => x.id === wrap.dataset.srcId);
      await invoke('screenshot_region', {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        label: screenshotLabel(d, wrap.dataset.variant),
        batchDir,
      });
    }
    await invoke('reveal_in_finder', { path: batchDir });
    flash(`Saved ${visible.length} frames to Desktop.`);
  } catch (err) {
    flash(`Batch screenshot failed: ${err}`, true);
  }
}

// ── Video recording ─────────────────────────────────────────────────
let videoTimer = null;
async function recordVideo(seconds = state.videoDuration || 15) {
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
    try { await invoke('video_stop'); } catch {}
    videoBtn.textContent = '🎬';
    videoBtn.classList.remove('is-active');
    return;
  }
  try {
    await invoke('video_start', { seconds });
    videoBtn.classList.add('is-active');
    let remaining = seconds;
    videoBtn.textContent = `⏺ ${remaining}s`;
    videoTimer = setInterval(async () => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(videoTimer);
        videoTimer = null;
        videoBtn.textContent = '🎬';
        videoBtn.classList.remove('is-active');
        flash('Video saved to Desktop.');
        return;
      }
      videoBtn.textContent = `⏺ ${remaining}s`;
    }, 1000);
  } catch (err) {
    flash(`Video failed: ${err}`, true);
  }
}

// ── Layout mode ─────────────────────────────────────────────────────
function setLayoutMode(mode, persist = true) {
  state.layoutMode = mode;
  if (persist) saveState();
  grid.classList.remove('rt-grid--row', 'rt-grid--column');
  if (mode === 'row') grid.classList.add('rt-grid--row');
  if (mode === 'column') grid.classList.add('rt-grid--column');
  layoutBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.layout === mode));
}

// ── Color-blindness ─────────────────────────────────────────────────
function setCbFilter(key) {
  state.cbFilter = key;
  saveState();
  applyColorBlindFilter(grid, key);
  if (cbSelect) cbSelect.value = key;
}

// ── Grid overlay ────────────────────────────────────────────────────
function cycleGridOverlay() {
  const cycle = [0, 8, 12];
  const idx = cycle.indexOf(state.gridOverlay);
  state.gridOverlay = cycle[(idx + 1) % cycle.length];
  saveState();
  applyGridOverlays();
  if (gridOverlayBtn) {
    gridOverlayBtn.textContent = state.gridOverlay === 0 ? 'Grid' : `Grid ${state.gridOverlay}`;
    gridOverlayBtn.classList.toggle('is-active', state.gridOverlay > 0);
  }
}

// ── Dark pair ───────────────────────────────────────────────────────
function toggleDarkPair() {
  state.darkPair = !state.darkPair;
  saveState();
  darkPairBtn.classList.toggle('is-active', state.darkPair);
  buildGrid();
}

// ── Filter chips ────────────────────────────────────────────────────
function setFilter(filter) {
  state.filter = filter;
  saveState();
  filterBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.filter === filter));
  applyVisibility();
}

// ── Inspect panel (tabs: inspector/social/links/breakpoints) ───────
function openInspect(tab) {
  inspectTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
  openPanel(inspectPanel, tab, state.url, inspectBody);
}

function closeInspect() { inspectPanel.hidden = true; }

// ── Workspaces ──────────────────────────────────────────────────────
// A workspace is a named snapshot of the visual state — which devices are
// enabled, current scale, filter, layout, overlays, rotations, etc. Lets Dan
// swap between "Kobe audit", "Mobile QA", "Presentation" quickly.
const WORKSPACE_KEYS = ['enabled', 'filter', 'scale', 'layoutMode', 'gridOverlay', 'darkPair', 'cbFilter', 'dims', 'rotated'];

function saveWorkspace() {
  const name = (workspaceNameInput.value || '').trim();
  if (!name) return;
  const config = {};
  WORKSPACE_KEYS.forEach((k) => { config[k] = structuredClone(state[k]); });
  state.workspaces.push({ id: `ws-${Date.now()}`, name, config });
  saveState();
  workspaceNameInput.value = '';
  renderWorkspaces();
  flash(`Workspace "${name}" saved.`);
}

function loadWorkspace(id) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (!ws) return;
  WORKSPACE_KEYS.forEach((k) => { if (ws.config[k] !== undefined) state[k] = structuredClone(ws.config[k]); });
  saveState();
  // Sync all UI controls
  scaleInput.value = Math.round(state.scale * 100);
  scaleValue.textContent = `${scaleInput.value}%`;
  setFilter(state.filter);
  setCbFilter(state.cbFilter);
  setLayoutMode(state.layoutMode, false);
  if (gridOverlayBtn) {
    gridOverlayBtn.textContent = state.gridOverlay === 0 ? 'Grid' : `Grid ${state.gridOverlay}`;
    gridOverlayBtn.classList.toggle('is-active', state.gridOverlay > 0);
  }
  if (darkPairBtn) darkPairBtn.classList.toggle('is-active', state.darkPair);
  buildAll();
  flash(`Loaded "${ws.name}".`);
}

function deleteWorkspace(id) {
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  saveState();
  renderWorkspaces();
}

function renderWorkspaces() {
  if (!workspaceList) return;
  workspaceList.innerHTML = state.workspaces.length === 0
    ? '<li class="rt-settings__empty">No workspaces saved yet.</li>'
    : state.workspaces.map((w) => `
        <li>
          <code>${escapeHtml(w.name)}</code>
          <button class="js-rt-ws-load" data-id="${w.id}">Load</button>
          <button class="js-rt-ws-del" data-id="${w.id}">Remove</button>
        </li>
      `).join('');
  workspaceList.querySelectorAll('.js-rt-ws-load').forEach((b) =>
    b.addEventListener('click', () => loadWorkspace(b.dataset.id)));
  workspaceList.querySelectorAll('.js-rt-ws-del').forEach((b) =>
    b.addEventListener('click', () => deleteWorkspace(b.dataset.id)));
}

// ── Toolbar hide ────────────────────────────────────────────────────
function toggleToolbars(force) {
  state.toolbarsHidden = typeof force === 'boolean' ? force : !state.toolbarsHidden;
  saveState();
  document.body.classList.toggle('rt-toolbars-hidden', state.toolbarsHidden);
}

function toggleSidebar(force) {
  state.sidebarHidden = typeof force === 'boolean' ? force : !state.sidebarHidden;
  saveState();
  document.body.classList.toggle('rt-sidebar-hidden', state.sidebarHidden);
}

// ── Scale shortcut ──────────────────────────────────────────────────
function adjustScale(delta) {
  const current = Math.round(state.scale * 100);
  const next = Math.max(20, Math.min(100, current + delta));
  if (next === current) return;
  scaleInput.value = next;
  scaleInput.dispatchEvent(new Event('input'));
}

// ── Clear recent ────────────────────────────────────────────────────
function clearRecent() {
  state.recent = [];
  saveState();
  renderRecent();
  flash('Recent URLs cleared.');
}

// ── Wire events ─────────────────────────────────────────────────────
loadBtn.addEventListener('click', () => loadUrl());
refreshBtn.addEventListener('click', () => loadUrl());
bookmarkBtn.addEventListener('click', addBookmark);
snapAllBtn.addEventListener('click', screenshotAll);
settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
inspectClose.addEventListener('click', closeInspect);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl(); });
urlInput.addEventListener('blur', () => {
  // Normalise on blur so the user immediately sees https:// prepended if
  // they pasted a bare hostname like monvrchs.staging.kobecreative.co.uk.
  const normalised = normaliseUrl(urlInput.value);
  if (normalised && normalised !== urlInput.value) urlInput.value = normalised;
});

document.querySelector('.js-rt-auth-save').addEventListener('click', saveAuth);
document.querySelector('.js-rt-custom-add').addEventListener('click', addCustomDevice);

const SYNC_SNIPPET = `<script>(function(){if(window.parent===window)return;var ig=false;window.addEventListener('scroll',function(){if(ig){ig=false;return}parent.postMessage({rt:'scroll',y:scrollY,x:scrollX},'*')},{passive:true});window.addEventListener('message',function(e){if(e.data&&e.data.rt==='scroll'){ig=true;window.scrollTo(e.data.x,e.data.y)}})})();</script>`;

if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    state.syncScroll = !state.syncScroll;
    syncBtn.classList.toggle('is-active', state.syncScroll);
    saveState();
    if (state.syncScroll) {
      flash('Sync needs a one-line script on the target site — copy from Settings.');
    }
  });
}

const copySyncBtn = document.querySelector('.js-rt-copy-sync');
if (copySyncBtn) {
  copySyncBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(SYNC_SNIPPET);
      flash('Sync-scroll snippet copied to clipboard.');
    } catch {
      flash('Copy failed — select the snippet manually.', true);
    }
  });
}

if (cbSelect) {
  cbSelect.addEventListener('change', () => setCbFilter(cbSelect.value));
}
if (gridOverlayBtn) gridOverlayBtn.addEventListener('click', cycleGridOverlay);
if (darkPairBtn) darkPairBtn.addEventListener('click', toggleDarkPair);
layoutBtns.forEach((b) => b.addEventListener('click', () => setLayoutMode(b.dataset.layout)));
if (videoBtn) videoBtn.addEventListener('click', () => recordVideo());
if (videoDurationSelect) {
  videoDurationSelect.addEventListener('change', () => {
    state.videoDuration = Number(videoDurationSelect.value);
    saveState();
  });
}
if (hideToolbarsBtn) hideToolbarsBtn.addEventListener('click', () => toggleToolbars());
if (revealToolbarsBtn) revealToolbarsBtn.addEventListener('click', () => toggleToolbars(false));
if (hideSidebarBtn) hideSidebarBtn.addEventListener('click', () => toggleSidebar());
if (revealSidebarBtn) revealSidebarBtn.addEventListener('click', () => toggleSidebar(false));
if (workspaceSaveBtn) workspaceSaveBtn.addEventListener('click', saveWorkspace);
if (workspaceNameInput) {
  workspaceNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveWorkspace(); });
}
if (clearRecentBtn) clearRecentBtn.addEventListener('click', clearRecent);

filterBtns.forEach((btn) => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));

panelBtns.forEach((b) => b.addEventListener('click', () => openInspect(b.dataset.tab)));
inspectTabs.forEach((t) => t.addEventListener('click', () => openInspect(t.dataset.tab)));

// Scale slider can fire 60+ input events/sec while dragging. saveState is
// synchronous localStorage (fine but wasteful), applyScale touches every
// device. Split the path: label + layout update via rAF on every input,
// localStorage persist only on change (commit at the end of the drag).
let scaleRaf = null;
function applyScaleRaf() {
  scaleRaf = null;
  scaleValue.textContent = `${Math.round(state.scale * 100)}%`;
  applyScale();
}

scaleInput.addEventListener('input', () => {
  state.scale = parseInt(scaleInput.value, 10) / 100;
  if (scaleRaf == null) scaleRaf = requestAnimationFrame(applyScaleRaf);
});

scaleInput.addEventListener('change', () => {
  // Fires on mouseup / keyboard commit — persist the final value once.
  saveState();
});

// ── Keyboard shortcuts ──────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key === 'l') { e.preventDefault(); urlInput.focus(); urlInput.select(); return; }
  if (meta && e.key === 'r') { e.preventDefault(); loadUrl(); return; }
  if (meta && e.key === 'd') { e.preventDefault(); addBookmark(); return; }
  if (meta && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (meta && e.key === '[') { e.preventDefault(); adjustRefOpacity(-0.1); return; }
  if (meta && e.key === ']') { e.preventDefault(); adjustRefOpacity(0.1); return; }
  if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); adjustScale(5); return; }
  if (meta && e.key === '-') { e.preventDefault(); adjustScale(-5); return; }
  if (meta && e.key === '.') { e.preventDefault(); toggleToolbars(); return; }
  if (meta && e.key === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (meta && e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (syncBtn) syncBtn.click();
    return;
  }
  if (e.key === 'Escape') {
    if (!inspectPanel.hidden) { closeInspect(); return; }
    if (!settingsPanel.hidden) { closeSettings(); return; }
    if (document.querySelector('.rt-device.is-maximized')) { exitMaximize(); return; }
  }
  if (meta && ['0','1','2','3'].includes(e.key) && document.activeElement !== urlInput) {
    e.preventDefault();
    const map = { '0':'all', '1':'mobile', '2':'tablet', '3':'desktop' };
    setFilter(map[e.key]);
  }
});

// ── Sync scroll (cross-origin opt-in) ───────────────────────────────
// Fan-out happens on every scroll event from every iframe — can be 20×
// per frame. Coalesce into a single rAF-batched rebroadcast so DOM query
// and postMessage spam don't starve the main thread.
//
// Echo suppression: when we programmatically scroll a receiving iframe
// via postMessage, its own scroll-event handler fires and posts the new
// position *back* to us — an echo that must not be rebroadcast, or every
// scroll turns into an N² ping-pong and the previews drift apart.
// WeakMap keyed by the iframe's contentWindow so GC reclaims entries
// when the iframe navigates or is removed.
const echoFilter = new WeakMap();
const ECHO_WINDOW_MS = 150;

let pendingScrollMsg = null;
let pulseTimer = null;
function pulseSyncBtn() {
  if (!syncBtn) return;
  syncBtn.classList.add('is-pulsing');
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => syncBtn.classList.remove('is-pulsing'), 250);
}

function flushSyncScroll() {
  const d = pendingScrollMsg;
  pendingScrollMsg = null;
  if (!d) return;
  const frames = grid.querySelectorAll('.rt-device:not(.is-hidden) .rt-device__frame');
  const expires = performance.now() + ECHO_WINDOW_MS;
  let sent = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const cw = frame.contentWindow;
    if (cw === d.source) continue;
    echoFilter.set(cw, { x: d.x, y: d.y, until: expires });
    try { cw.postMessage({ rt: 'scroll', x: d.x, y: d.y }, '*'); sent++; } catch {}
  }
  if (sent > 0) pulseSyncBtn();
}

window.addEventListener('message', (e) => {
  if (!state.syncScroll) return;
  const d = e.data;
  if (!d || d.rt !== 'scroll') return;
  // Drop echoes: this source was just sent an identical (x,y) — the post
  // we're seeing is the programmatic scroll handler firing back.
  const expected = echoFilter.get(e.source);
  if (expected && expected.x === d.x && expected.y === d.y && performance.now() < expected.until) {
    echoFilter.delete(e.source);
    return;
  }
  const wasEmpty = pendingScrollMsg === null;
  pendingScrollMsg = { x: d.x, y: d.y, source: e.source };
  if (wasEmpty) requestAnimationFrame(flushSyncScroll);
});

// ── CLI-arg preload ─────────────────────────────────────────────────
async function applyCliUrl() {
  try {
    const cliUrl = await invoke('get_cli_url');
    if (cliUrl && typeof cliUrl === 'string') {
      urlInput.value = cliUrl;
      loadUrl();
    }
  } catch { /* not available outside tauri */ }
}

// ── Init ────────────────────────────────────────────────────────────
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector('svg.rt-icon')) return;
    const size = Number(el.dataset.iconSize) || 14;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, size));
  });
}

function init() {
  injectFilterDefs();
  hydrateIcons();

  // Populate CB dropdown if empty (index.html may have a placeholder)
  if (cbSelect && cbSelect.options.length === 0) {
    cbSelect.innerHTML = CB_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }

  // Restore toolbar state
  scaleInput.value = Math.round(state.scale * 100);
  scaleValue.textContent = `${scaleInput.value}%`;
  setFilter(state.filter);
  setCbFilter(state.cbFilter);
  urlInput.value = state.url;
  renderRecent();
  if (syncBtn) syncBtn.classList.toggle('is-active', state.syncScroll);
  if (darkPairBtn) darkPairBtn.classList.toggle('is-active', state.darkPair);
  if (gridOverlayBtn) {
    gridOverlayBtn.textContent = state.gridOverlay === 0 ? 'Grid' : `Grid ${state.gridOverlay}`;
    gridOverlayBtn.classList.toggle('is-active', state.gridOverlay > 0);
  }
  if (videoDurationSelect) videoDurationSelect.value = String(state.videoDuration || 15);
  document.body.classList.toggle('rt-toolbars-hidden', !!state.toolbarsHidden);
  document.body.classList.toggle('rt-sidebar-hidden', !!state.sidebarHidden);

  buildAll();

  wireContrastWidget(document);
  renderWorkspaces();

  applyCliUrl();
}

init();

// ── Auto-updater ────────────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const update = await check();
    if (!update) return;
    showUpdateToast(update);
  } catch (err) {
    console.warn('Update check failed:', err);
  }
}

function showUpdateToast(update) {
  const toast = document.createElement('div');
  toast.className = 'rt-update-toast';
  toast.innerHTML = `
    <div class="rt-update-toast__body">
      <strong>Update available</strong>
      <span>v${update.version} is ready to install.</span>
    </div>
    <button class="rt-update-toast__btn js-rt-update-install">Install &amp; restart</button>
    <button class="rt-update-toast__close js-rt-update-close" aria-label="Dismiss">×</button>
  `;
  document.body.appendChild(toast);
  toast.querySelector('.js-rt-update-install').addEventListener('click', async () => {
    toast.querySelector('.rt-update-toast__body').innerHTML = '<strong>Installing…</strong>';
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      toast.querySelector('.rt-update-toast__body').innerHTML = `<strong>Update failed</strong><span>${err}</span>`;
    }
  });
  toast.querySelector('.js-rt-update-close').addEventListener('click', () => toast.remove());
}

checkForUpdate();
