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
