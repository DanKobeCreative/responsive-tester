// Server-side-fetch-based panels:
// - Meta/SEO inspector
// - Social previews
// - Link checker
// - CSS breakpoint detector

import { invoke } from '@tauri-apps/api/core';
import { escapeHtml, escapeAttr, normaliseUrl, hostOf, flash } from './utils.js';

const CACHE_TTL_MS = 60_000;
const fetchCache = new Map();

export function clearPanelCache() { fetchCache.clear(); }

async function getCachedMeta(url) {
  const now = Date.now();
  const cached = fetchCache.get(url);
  if (cached && cached.expiry > now) return cached;
  const result = await invoke('fetch_url_meta', { url });
  const entry = { ...result, expiry: now + CACHE_TTL_MS };
  fetchCache.set(url, entry);
  return entry;
}

// ── Parsing helpers ──────────────────────────────────────────────────
function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function pickMeta(doc) {
  const get = (sel, attr = 'content') => doc.querySelector(sel)?.getAttribute(attr) || '';
  const all = (sel, attr = 'content') => [...doc.querySelectorAll(sel)].map((el) => el.getAttribute(attr) || '');
  const title = doc.querySelector('title')?.textContent?.trim() || '';
  const h1s = [...doc.querySelectorAll('h1')].map((el) => el.textContent.trim());
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => ({
    level: Number(el.tagName.substring(1)),
    text: el.textContent.trim().slice(0, 120),
  }));
  const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
    .filter(Boolean);

  return {
    title,
    description: get('meta[name="description"]'),
    canonical: get('link[rel="canonical"]', 'href'),
    robots: get('meta[name="robots"]'),
    viewport: get('meta[name="viewport"]'),
    lang: doc.documentElement.getAttribute('lang') || '',
    charset: doc.querySelector('meta[charset]')?.getAttribute('charset') || '',
    og: {
      title: get('meta[property="og:title"]'),
      description: get('meta[property="og:description"]'),
      image: get('meta[property="og:image"]'),
      url: get('meta[property="og:url"]'),
      type: get('meta[property="og:type"]'),
      siteName: get('meta[property="og:site_name"]'),
    },
    twitter: {
      card: get('meta[name="twitter:card"]'),
      title: get('meta[name="twitter:title"]'),
      description: get('meta[name="twitter:description"]'),
      image: get('meta[name="twitter:image"]'),
      site: get('meta[name="twitter:site"]'),
    },
    hreflang: [...doc.querySelectorAll('link[rel="alternate"][hreflang]')].map((el) => ({
      lang: el.getAttribute('hreflang'),
      href: el.getAttribute('href'),
    })),
    favicons: [...doc.querySelectorAll('link[rel~="icon"]')].map((el) => el.getAttribute('href')).filter(Boolean),
    h1s,
    headings,
    jsonLd,
    stylesheets: all('link[rel="stylesheet"]', 'href').filter(Boolean),
    links: [...doc.querySelectorAll('a[href]')].map((el) => el.getAttribute('href')),
  };
}

function resolveUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

// ── Inspector panel ──────────────────────────────────────────────────
function row(label, value) {
  const v = value ? escapeHtml(value) : '<em class="rt-panel__missing">missing</em>';
  return `<tr><th>${escapeHtml(label)}</th><td>${v}</td></tr>`;
}

// ── Meta validation ─────────────────────────────────────────────────
function validateMeta(meta, finalUrl) {
  const warnings = [];
  if (!meta.title) warnings.push({ level: 'error', msg: 'Missing <title>' });
  else if (meta.title.length < 30) warnings.push({ level: 'warn', msg: `Title short (${meta.title.length} chars, aim 30–60)` });
  else if (meta.title.length > 60) warnings.push({ level: 'warn', msg: `Title long (${meta.title.length} chars, SERP truncates ~60)` });

  if (!meta.description) warnings.push({ level: 'error', msg: 'Missing meta description' });
  else if (meta.description.length > 160) warnings.push({ level: 'warn', msg: `Description long (${meta.description.length} chars, SERP truncates ~160)` });

  if (!meta.canonical) warnings.push({ level: 'warn', msg: 'Missing canonical link' });
  else {
    try {
      const canonAbs = new URL(meta.canonical, finalUrl).toString();
      if (canonAbs !== finalUrl) warnings.push({ level: 'warn', msg: `Canonical mismatch: points to ${canonAbs}` });
    } catch { /* malformed canonical */ }
  }

  if (!meta.viewport) warnings.push({ level: 'error', msg: 'Missing viewport meta — mobile rendering will break' });
  if (!meta.og.image) warnings.push({ level: 'warn', msg: 'Missing og:image — social shares look bad' });
  if (!meta.og.title && !meta.title) warnings.push({ level: 'warn', msg: 'Missing og:title' });
  if (/noindex/i.test(meta.robots)) warnings.push({ level: 'warn', msg: 'Page is marked noindex' });
  if (meta.h1s.length === 0) warnings.push({ level: 'warn', msg: 'No <h1> heading found' });
  else if (meta.h1s.length > 1) warnings.push({ level: 'warn', msg: `${meta.h1s.length} <h1> headings — should be one` });
  if (!meta.lang) warnings.push({ level: 'warn', msg: 'Missing <html lang=""> attribute' });
  if (!meta.charset) warnings.push({ level: 'warn', msg: 'Missing charset declaration' });

  return warnings;
}

function renderWarnings(warnings) {
  if (warnings.length === 0) {
    return '<div class="rt-warnings rt-warnings--ok">✓ No issues detected.</div>';
  }
  const rows = warnings.map((w) => `
    <li class="rt-warnings__item rt-warnings__item--${w.level}">
      <span class="rt-warnings__dot"></span>${escapeHtml(w.msg)}
    </li>
  `).join('');
  return `<ul class="rt-warnings">${rows}</ul>`;
}

function renderInspector(meta, finalUrl, status) {
  const ogTable = Object.entries(meta.og).map(([k, v]) => row(`og:${k}`, v)).join('');
  const twTable = Object.entries(meta.twitter).map(([k, v]) => row(`twitter:${k}`, v)).join('');
  const hreflangRows = meta.hreflang.length
    ? meta.hreflang.map((h) => row(h.lang, h.href)).join('')
    : '<tr><td colspan="2"><em class="rt-panel__missing">none</em></td></tr>';
  const jsonLdCount = meta.jsonLd.length;
  const headingsList = meta.headings.slice(0, 30).map((h) => `<li class="rt-panel__h rt-panel__h--${h.level}">H${h.level} · ${escapeHtml(h.text)}</li>`).join('');

  const warnings = validateMeta(meta, finalUrl);

  return `
    <div class="rt-panel__row-kv">
      <span>Final URL</span><code>${escapeHtml(finalUrl)}</code>
      <span>Status</span><code>${status}</code>
    </div>

    <h5>Issues</h5>
    ${renderWarnings(warnings)}

    <h5>Primary tags</h5>
    <table class="rt-panel__table">
      ${row('title', meta.title)}
      ${row('description', meta.description)}
      ${row('canonical', meta.canonical)}
      ${row('robots', meta.robots)}
      ${row('viewport', meta.viewport)}
      ${row('lang', meta.lang)}
      ${row('charset', meta.charset)}
    </table>

    <h5>Open Graph</h5>
    <table class="rt-panel__table">${ogTable}</table>

    <h5>Twitter Card</h5>
    <table class="rt-panel__table">${twTable}</table>

    <h5>hreflang</h5>
    <table class="rt-panel__table">${hreflangRows}</table>

    <h5>Favicons (${meta.favicons.length})</h5>
    <ul class="rt-panel__list">${meta.favicons.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('') || '<li><em class="rt-panel__missing">none</em></li>'}</ul>

    <h5>Structured data</h5>
    <p>${jsonLdCount} JSON-LD block${jsonLdCount === 1 ? '' : 's'} found.</p>

    <h5>Headings outline (${meta.headings.length})</h5>
    <ul class="rt-panel__outline">${headingsList || '<li><em class="rt-panel__missing">no headings</em></li>'}</ul>
  `;
}

// ── Social previews ──────────────────────────────────────────────────
function socialCards(meta, finalUrl) {
  const host = hostOf(finalUrl);
  const title = meta.og.title || meta.title || '(no title)';
  const desc = meta.og.description || meta.description || '(no description)';
  const img = meta.og.image || meta.twitter.image || '';
  const twTitle = meta.twitter.title || title;
  const twDesc = meta.twitter.description || desc;
  const twImg = meta.twitter.image || img;

  const imgHtml = (src) => src
    ? `<img src="${escapeAttr(src)}" alt="" onerror="this.style.display='none'">`
    : '<div class="rt-social__noimg">No image</div>';

  return `
    <div class="rt-social__grid">
      <div class="rt-social__card rt-social--fb">
        <div class="rt-social__label">Facebook / LinkedIn</div>
        <div class="rt-social__img">${imgHtml(img)}</div>
        <div class="rt-social__body">
          <div class="rt-social__host">${escapeHtml(host).toUpperCase()}</div>
          <div class="rt-social__title">${escapeHtml(title)}</div>
          <div class="rt-social__desc">${escapeHtml(desc)}</div>
        </div>
      </div>

      <div class="rt-social__card rt-social--tw">
        <div class="rt-social__label">Twitter / X</div>
        <div class="rt-social__img">${imgHtml(twImg)}</div>
        <div class="rt-social__body rt-social__body--tw">
          <div class="rt-social__title">${escapeHtml(twTitle)}</div>
          <div class="rt-social__desc">${escapeHtml(twDesc)}</div>
          <div class="rt-social__host">${escapeHtml(host)}</div>
        </div>
      </div>

      <div class="rt-social__card rt-social--slack">
        <div class="rt-social__label">Slack / Discord</div>
        <div class="rt-social__slack-bar"></div>
        <div class="rt-social__slack-body">
          <div class="rt-social__slack-site">${escapeHtml(host)}</div>
          <div class="rt-social__slack-title">${escapeHtml(title)}</div>
          <div class="rt-social__slack-desc">${escapeHtml(desc)}</div>
          <div class="rt-social__img rt-social__img--slack">${imgHtml(img)}</div>
        </div>
      </div>

      <div class="rt-social__card rt-social--imessage">
        <div class="rt-social__label">iMessage</div>
        <div class="rt-social__img rt-social__img--square">${imgHtml(img)}</div>
        <div class="rt-social__body">
          <div class="rt-social__title">${escapeHtml(title)}</div>
          <div class="rt-social__host">${escapeHtml(host)}</div>
        </div>
      </div>
    </div>
  `;
}

// ── Link checker ────────────────────────────────────────────────────
async function runLinkCheck(links, base) {
  const urls = [...new Set(
    links.map((h) => resolveUrl(h, base))
      .filter((u) => u && /^https?:/.test(u))
  )];
  if (urls.length === 0) return [];
  return invoke('check_links', { urls });
}

function renderLinkResults(results) {
  if (results.length === 0) return '<p class="rt-panel__missing">No HTTP links found.</p>';
  const rows = results
    .sort((a, b) => (b.status || 999) - (a.status || 999))
    .map((r) => {
      const status = r.status ?? '—';
      const cls = r.error ? 'is-err' : r.status >= 400 ? 'is-err' : r.status >= 300 ? 'is-warn' : 'is-ok';
      const extra = r.redirect ? ` → <code>${escapeHtml(r.redirect)}</code>` : r.error ? ` <em>${escapeHtml(r.error)}</em>` : '';
      return `<tr class="${cls}"><td class="rt-links__status">${status}</td><td><code>${escapeHtml(r.url)}</code>${extra}</td></tr>`;
    }).join('');
  return `
    <div class="rt-links__summary">
      ${countBadge(results, (r) => r.status >= 200 && r.status < 300, 'OK')}
      ${countBadge(results, (r) => r.status >= 300 && r.status < 400, '3xx')}
      ${countBadge(results, (r) => r.status >= 400 && r.status < 500, '4xx')}
      ${countBadge(results, (r) => r.status >= 500, '5xx')}
      ${countBadge(results, (r) => !r.status, 'Err')}
    </div>
    <table class="rt-panel__table rt-links__table">${rows}</table>
  `;
}

function countBadge(results, pred, label) {
  const n = results.filter(pred).length;
  return `<span class="rt-links__badge rt-links__badge--${label.toLowerCase()}">${label}: ${n}</span>`;
}

// ── CSS breakpoint detection ────────────────────────────────────────
async function detectBreakpoints(stylesheetUrls) {
  const widths = new Set();
  const results = await Promise.all(stylesheetUrls.map(async (url) => {
    try {
      return await invoke('fetch_url_text', { url });
    } catch {
      return '';
    }
  }));
  const re = /@media[^{]*?\(\s*(min|max)-width\s*:\s*(\d+)(px|em|rem)/gi;
  for (const css of results) {
    let m;
    while ((m = re.exec(css)) !== null) {
      const value = Number(m[2]);
      const unit = m[3];
      const px = unit === 'px' ? value : value * 16;
      widths.add(`${m[1]}:${px}`);
    }
  }
  return [...widths]
    .map((s) => {
      const [dir, px] = s.split(':');
      return { dir, px: Number(px) };
    })
    .sort((a, b) => a.px - b.px);
}

function renderBreakpoints(bps) {
  if (bps.length === 0) return '<p class="rt-panel__missing">No breakpoints detected.</p>';
  const rows = bps.map((b) => `<tr><td><code>${b.dir}-width</code></td><td class="rt-bp__px">${b.px}px</td></tr>`).join('');
  return `<table class="rt-panel__table">${rows}</table>`;
}

// ── Panel orchestration ─────────────────────────────────────────────
export async function openPanel(panel, tab, url, targetEl) {
  if (!url) {
    flash('Load a URL first.', true);
    return;
  }
  targetEl.innerHTML = '<div class="rt-panel__loading">Fetching…</div>';
  panel.hidden = false;

  let meta, finalUrl, status;
  try {
    const result = await getCachedMeta(url);
    finalUrl = result.finalUrl;
    status = result.status;
    meta = pickMeta(parseHtml(result.body));
  } catch (err) {
    targetEl.innerHTML = `<div class="rt-panel__error">Failed to fetch: ${escapeHtml(String(err))}</div>`;
    return;
  }

  if (tab === 'inspector') {
    targetEl.innerHTML = renderInspector(meta, finalUrl, status);
  } else if (tab === 'social') {
    targetEl.innerHTML = socialCards(meta, finalUrl);
  } else if (tab === 'links') {
    targetEl.innerHTML = '<div class="rt-panel__loading">Checking links…</div>';
    const results = await runLinkCheck(meta.links, finalUrl);
    targetEl.innerHTML = renderLinkResults(results);
  } else if (tab === 'breakpoints') {
    targetEl.innerHTML = '<div class="rt-panel__loading">Fetching stylesheets…</div>';
    const absoluteSheets = meta.stylesheets
      .map((href) => resolveUrl(href, finalUrl))
      .filter(Boolean);
    const bps = await detectBreakpoints(absoluteSheets);
    targetEl.innerHTML = renderBreakpoints(bps);
  }
}
