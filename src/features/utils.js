import { invoke } from '@tauri-apps/api/core';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function escapeAttr(s) { return escapeHtml(s); }

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function flash(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `rt-flash${isError ? ' rt-flash--error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 200);
  }, 2800);
}

export async function safeInvoke(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    return { __error: String(err) };
  }
}

export function normaliseUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export function isoSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// In-app prompt + confirm. window.prompt() / window.confirm() don't work
// in Tauri 2's WKWebView — the embedding app has to implement the
// WKUIDelegate methods (runJavaScriptTextInputPanelWithPrompt: etc.),
// and Tauri intentionally doesn't. Native calls return null / false
// silently, which made the bookmark add a silent no-op since v0.4.0.
// These two helpers replicate the API as Promises so callers can await.

let modalRoot = null;

function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.className = 'rt-modal-root';
  document.body.appendChild(modalRoot);
  return modalRoot;
}

function buildModal({ title, message, defaultValue, mode }) {
  const root = ensureModalRoot();
  const overlay = document.createElement('div');
  overlay.className = 'rt-modal';
  const isPrompt = mode === 'prompt';
  overlay.innerHTML = `
    <div class="rt-modal__sheet">
      ${title ? `<div class="rt-modal__title">${escapeHtml(title)}</div>` : ''}
      ${message ? `<div class="rt-modal__msg">${escapeHtml(message)}</div>` : ''}
      ${isPrompt ? `<input type="text" class="rt-modal__input" value="${escapeAttr(defaultValue ?? '')}">` : ''}
      <div class="rt-modal__actions">
        <button class="rt-toolbar__btn js-cancel">Cancel</button>
        <button class="rt-toolbar__btn rt-toolbar__btn--primary js-ok">${isPrompt ? 'OK' : 'Confirm'}</button>
      </div>
    </div>`;
  root.appendChild(overlay);
  return overlay;
}

export function promptModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = buildModal({ title, defaultValue, mode: 'prompt' });
    const input = overlay.querySelector('.rt-modal__input');
    const ok = overlay.querySelector('.js-ok');
    const cancel = overlay.querySelector('.js-cancel');
    const cleanup = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
    };
    document.addEventListener('keydown', onKey);
    ok.addEventListener('click', () => cleanup(input.value));
    cancel.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

export function confirmModal(message, title = 'Confirm') {
  return new Promise((resolve) => {
    const overlay = buildModal({ title, message, mode: 'confirm' });
    const ok = overlay.querySelector('.js-ok');
    const cancel = overlay.querySelector('.js-cancel');
    const cleanup = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };
    document.addEventListener('keydown', onKey);
    ok.addEventListener('click', () => cleanup(true));
    cancel.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    setTimeout(() => ok.focus(), 0);
  });
}

// Simple concurrency-limited queue. Used to stagger iframe loads so that
// hitting Load with 20 devices doesn't fire 20 concurrent requests at a
// rate-limited staging server.
export class LoadQueue {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.completed = 0;
    this.total = 0;
    this.onProgress = null;   // ({ completed, total, running, pending }) => void
  }
  clear() {
    this.queue.length = 0;
    this.completed = 0;
    this.total = 0;
    this.emit();
  }
  add(task) {
    this.total++;
    this.emit();
    return new Promise((resolve) => {
      this.queue.push(async () => {
        try { resolve(await task()); } catch (e) { resolve(); }
        finally { this.completed++; this.emit(); }
      });
      this.drain();
    });
  }
  drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      Promise.resolve().then(task).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }
  emit() {
    if (!this.onProgress) return;
    this.onProgress({
      completed: this.completed,
      total: this.total,
      running: this.running,
      pending: this.queue.length,
    });
  }
}
