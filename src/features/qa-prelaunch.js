// Pre-Launch tab. Crawls the site to populate a page list, then runs
// per-page checks (SEO / a11y / performance / console / links) plus an
// optional Lighthouse pass. Streams progress back from the audit/
// crawl.js + audit/prelaunch.js sidecars and renders a categorised
// report. Manual checklist at the bottom is persisted per URL slug in
// localStorage.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { escapeHtml, escapeAttr, slug, flash, hostOf } from './utils.js';
import { icon } from './icons.js';

const MANUAL_CHECKS = [
  'Content has been proofread',
  'Client has approved the design',
  'Contact form sends to the correct email',
  'Analytics / tracking is connected and receiving data',
  'Domain DNS is pointed correctly',
  'SSL certificate is valid and auto-renewing',
  'Backup strategy is in place',
  '404 page works',
  'Cookie / privacy consent works',
];

const MANUAL_KEY_PREFIX = 'rt-prelaunch-manual:';

export function initPrelaunch({ container, getCurrentUrl, getAuth }) {
  const ui = buildLayout(container);

  let crawledPages = [];
  let runningCrawl = false;
  let runningAudit = false;
  let lastResults = {
    pages: new Map(), // url → { findings, lighthouseScores, counts }
    siteWide: [],
    totals: { pass: 0, warn: 0, fail: 0 },
    completedAt: null,
  };

  // ── Crawl ───────────────────────────────────────────────────────────
  ui.crawlBtn.addEventListener('click', async () => {
    const url = getCurrentUrl();
    if (!url) { flash('Load a URL first.', true); return; }
    if (runningCrawl || runningAudit) { flash('Operation already in progress.', true); return; }
    runningCrawl = true;
    crawledPages = [];
    ui.pagesList.innerHTML = '<div class="rt-prelaunch__placeholder">Crawling…</div>';
    setRunButtons();
    const auth = getAuth(hostOf(url)) || null;
    try {
      await invoke('qa_run_crawl', {
        config: { startUrl: url, maxPages: 50, auth },
      });
    } catch (err) {
      flash(`Crawl failed to start: ${err}`, true);
      runningCrawl = false;
      setRunButtons();
    }
  });

  listen('qa-page-crawled', (e) => {
    const p = e.payload || {};
    crawledPages.push({ url: p.url, title: p.title, status: p.status, include: true });
    renderPageList();
  });

  listen('qa-crawl-complete', () => {
    runningCrawl = false;
    setRunButtons();
    flash(`Crawl complete — ${crawledPages.length} page(s).`);
  });

  listen('qa-crawl-finished', () => {
    runningCrawl = false;
    setRunButtons();
  });

  function renderPageList() {
    if (!crawledPages.length) {
      ui.pagesList.innerHTML = '<div class="rt-prelaunch__placeholder">No pages crawled yet.</div>';
      return;
    }
    ui.pagesList.innerHTML = `
      <div class="rt-prelaunch__pages-head">
        <label><input type="checkbox" class="js-toggle-all" checked> Audit all (${crawledPages.length})</label>
      </div>
      <ul class="rt-prelaunch__pages">
        ${crawledPages.map((p, i) => `
          <li>
            <input type="checkbox" class="js-page" data-i="${i}" ${p.include ? 'checked' : ''}>
            <span class="rt-prelaunch__page-status">${p.status}</span>
            <span class="rt-prelaunch__page-url" title="${escapeAttr(p.url)}">${escapeHtml(p.url)}</span>
          </li>`).join('')}
      </ul>`;
    ui.pagesList.querySelector('.js-toggle-all').addEventListener('change', (e) => {
      const checked = e.target.checked;
      crawledPages.forEach((p) => { p.include = checked; });
      ui.pagesList.querySelectorAll('.js-page').forEach((cb) => { cb.checked = checked; });
    });
    ui.pagesList.querySelectorAll('.js-page').forEach((cb) => {
      cb.addEventListener('change', () => {
        const i = Number(cb.dataset.i);
        crawledPages[i].include = cb.checked;
      });
    });
  }

  // ── Audit ───────────────────────────────────────────────────────────
  ui.auditBtn.addEventListener('click', async () => {
    if (runningCrawl || runningAudit) { flash('Operation already in progress.', true); return; }
    const pages = crawledPages.filter((p) => p.include).map((p) => p.url);
    if (!pages.length) { flash('Pick at least one page (or run the crawler first).', true); return; }
    runningAudit = true;
    lastResults = { pages: new Map(), siteWide: [], totals: { pass: 0, warn: 0, fail: 0 }, completedAt: null };
    renderResults();
    setRunButtons();
    const url = getCurrentUrl();
    const auth = getAuth(hostOf(url)) || null;
    try {
      await invoke('qa_run_prelaunch', {
        config: { pages, auth, runLighthouse: ui.lighthouseToggle.checked },
      });
    } catch (err) {
      flash(`Audit failed to start: ${err}`, true);
      runningAudit = false;
      setRunButtons();
    }
  });

  ui.cancelBtn.addEventListener('click', async () => {
    try { await invoke('qa_cancel_prelaunch'); } catch (err) { flash(String(err), true); }
  });

  function setRunButtons() {
    const busy = runningCrawl || runningAudit;
    ui.crawlBtn.disabled = busy;
    ui.auditBtn.disabled = busy;
    ui.cancelBtn.hidden = !busy;
    ui.crawlBtn.textContent = runningCrawl ? 'Crawling…' : 'Crawl site';
    ui.auditBtn.textContent = runningAudit ? 'Auditing…' : 'Run pre-launch audit';
  }

  listen('qa-prelaunch-page-start', (e) => {
    const { url, pageIndex, totalPages } = e.payload || {};
    ui.statusText.textContent = `Auditing ${pageIndex}/${totalPages} — ${url}`;
    ui.statusText.hidden = false;
  });

  listen('qa-prelaunch-check', (e) => {
    const { url, category, check, status, detail } = e.payload || {};
    if (url === '__site__') {
      lastResults.siteWide.push({ category, check, status, detail });
    } else {
      let pageData = lastResults.pages.get(url);
      if (!pageData) {
        pageData = { findings: [], lighthouse: null, counts: { pass: 0, warn: 0, fail: 0 } };
        lastResults.pages.set(url, pageData);
      }
      pageData.findings.push({ category, check, status, detail });
      pageData.counts[status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'pass']++;
      lastResults.totals[status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'pass']++;
    }
    renderResults();
  });

  listen('qa-prelaunch-lighthouse', (e) => {
    const { url, scores, coreWebVitals } = e.payload || {};
    let pageData = lastResults.pages.get(url);
    if (!pageData) {
      pageData = { findings: [], lighthouse: null, counts: { pass: 0, warn: 0, fail: 0 } };
      lastResults.pages.set(url, pageData);
    }
    pageData.lighthouse = { scores, coreWebVitals };
    renderResults();
  });

  listen('qa-prelaunch-complete', (e) => {
    const t = e.payload || {};
    lastResults.totals = { pass: t.totalPassed, warn: t.totalWarnings, fail: t.totalFailed };
    lastResults.completedAt = new Date().toISOString();
    runningAudit = false;
    setRunButtons();
    ui.statusText.textContent = `Complete — ${t.totalPassed}/${t.totalChecks} checks passed across ${t.totalPages} page(s).`;
    flash('Pre-launch audit complete.');
    renderResults();
  });

  listen('qa-prelaunch-cancelled', () => {
    runningAudit = false;
    setRunButtons();
    ui.statusText.textContent = 'Cancelled.';
  });

  listen('qa-prelaunch-finished', () => {
    runningAudit = false;
    setRunButtons();
  });

  // ── Results render ──────────────────────────────────────────────────
  function statusBadge(status) {
    const sym = { pass: '✓', warn: '⚠', fail: '✗' }[status] ?? '·';
    return `<span class="rt-prelaunch__badge rt-prelaunch__badge--${status}">${sym}</span>`;
  }

  function scoreColour(score) {
    if (score >= 90) return 'is-pass';
    if (score >= 50) return 'is-review';
    return 'is-fail';
  }

  function renderResults() {
    const { pages, siteWide, totals, completedAt } = lastResults;
    const pageEntries = [...pages.entries()];

    let lhAvg = null;
    const pagesWithLh = pageEntries.filter(([, d]) => d.lighthouse?.scores);
    if (pagesWithLh.length) {
      const sums = { performance: 0, accessibility: 0, seo: 0, bestPractices: 0 };
      const cwvSums = { lcp: 0, cls: 0, tbt: 0 };
      let cwvCount = 0;
      for (const [, d] of pagesWithLh) {
        for (const k of Object.keys(sums)) sums[k] += d.lighthouse.scores[k] ?? 0;
        if (d.lighthouse.coreWebVitals) {
          cwvSums.lcp += d.lighthouse.coreWebVitals.lcp ?? 0;
          cwvSums.cls += d.lighthouse.coreWebVitals.cls ?? 0;
          cwvSums.tbt += d.lighthouse.coreWebVitals.tbt ?? 0;
          cwvCount++;
        }
      }
      lhAvg = {
        scores: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v / pagesWithLh.length)])),
        coreWebVitals: cwvCount ? {
          lcp: Math.round(cwvSums.lcp / cwvCount),
          cls: (cwvSums.cls / cwvCount).toFixed(3),
          tbt: Math.round(cwvSums.tbt / cwvCount),
        } : null,
      };
    }

    const summaryHtml = pages.size > 0 ? `
      <div class="rt-prelaunch__summary">
        <div class="rt-prelaunch__summary-row">
          <strong>${totals.pass}</strong> passed ·
          <strong>${totals.fail}</strong> failed ·
          <strong>${totals.warn}</strong> warnings ·
          across <strong>${pages.size}</strong> page${pages.size === 1 ? '' : 's'}
        </div>
        ${lhAvg ? `
          <div class="rt-prelaunch__summary-lh">
            <span class="rt-prelaunch__lh-score ${scoreColour(lhAvg.scores.performance)}">Perf ${lhAvg.scores.performance}</span>
            <span class="rt-prelaunch__lh-score ${scoreColour(lhAvg.scores.accessibility)}">A11y ${lhAvg.scores.accessibility}</span>
            <span class="rt-prelaunch__lh-score ${scoreColour(lhAvg.scores.seo)}">SEO ${lhAvg.scores.seo}</span>
            <span class="rt-prelaunch__lh-score ${scoreColour(lhAvg.scores.bestPractices)}">Best ${lhAvg.scores.bestPractices}</span>
            ${lhAvg.coreWebVitals ? `
              <span class="rt-prelaunch__cwv">LCP ${(lhAvg.coreWebVitals.lcp / 1000).toFixed(1)}s · CLS ${lhAvg.coreWebVitals.cls} · TBT ${lhAvg.coreWebVitals.tbt}ms</span>
            ` : ''}
          </div>
        ` : ''}
      </div>
    ` : '';

    const pagesHtml = pageEntries.length ? `
      <div class="rt-prelaunch__pages-results">
        ${pageEntries.map(([url, data]) => {
          const byCategory = {};
          for (const f of data.findings) {
            (byCategory[f.category] = byCategory[f.category] || []).push(f);
          }
          const cats = Object.entries(byCategory).map(([cat, fs]) => `
            <div class="rt-prelaunch__cat">
              <h4>${escapeHtml(cat)}</h4>
              <ul>
                ${fs.map((f) => `<li>${statusBadge(f.status)}<span>${escapeHtml(f.detail)}</span></li>`).join('')}
              </ul>
            </div>`).join('');
          return `
            <details class="rt-prelaunch__page" open>
              <summary>
                <span class="rt-qa-section__chev">${icon('chevron-right', 14)}</span>
                <span class="rt-prelaunch__page-summary-url">${escapeHtml(url)}</span>
                <span class="rt-prelaunch__page-summary-counts">${data.counts.pass}✓ ${data.counts.warn}⚠ ${data.counts.fail}✗</span>
                ${data.lighthouse?.scores ? `<span class="rt-prelaunch__lh-mini">P:${data.lighthouse.scores.performance} A:${data.lighthouse.scores.accessibility}</span>` : ''}
              </summary>
              <div class="rt-prelaunch__page-body">${cats}</div>
            </details>`;
        }).join('')}
      </div>` : '';

    const siteWideHtml = siteWide.length ? `
      <div class="rt-prelaunch__site-wide">
        <h4>Site-wide</h4>
        <ul>
          ${siteWide.map((f) => `<li>${statusBadge(f.status)}<span>${escapeHtml(f.detail)}</span></li>`).join('')}
        </ul>
      </div>` : '';

    const manualHtml = renderManual();
    const exportHtml = completedAt ? `
      <div class="rt-prelaunch__export">
        <button class="rt-toolbar__btn js-export">${icon('download', 14)}<span>Export report</span></button>
      </div>` : '';

    ui.results.innerHTML = summaryHtml + pagesHtml + siteWideHtml + manualHtml + exportHtml;

    wireManualHandlers();
    const exportBtn = ui.results.querySelector('.js-export');
    if (exportBtn) exportBtn.addEventListener('click', () => exportReport(lhAvg));
  }

  function renderManual() {
    const url = getCurrentUrl() || '';
    const slugged = slug(url);
    const stored = JSON.parse(localStorage.getItem(MANUAL_KEY_PREFIX + slugged) || '{}');
    const items = MANUAL_CHECKS.map((label, i) => {
      const checked = !!stored[i];
      return `<li><label><input type="checkbox" class="js-manual" data-i="${i}" ${checked ? 'checked' : ''}> ${escapeHtml(label)}</label></li>`;
    }).join('');
    return `
      <div class="rt-prelaunch__manual">
        <h4>Manual checks</h4>
        <p>These can't be automated — verify each one yourself before launch.</p>
        <ul>${items}</ul>
      </div>`;
  }

  function wireManualHandlers() {
    const url = getCurrentUrl() || '';
    const slugged = slug(url);
    ui.results.querySelectorAll('.js-manual').forEach((cb) => {
      cb.addEventListener('change', () => {
        const stored = JSON.parse(localStorage.getItem(MANUAL_KEY_PREFIX + slugged) || '{}');
        stored[cb.dataset.i] = cb.checked;
        localStorage.setItem(MANUAL_KEY_PREFIX + slugged, JSON.stringify(stored));
      });
    });
  }

  // ── Export report ───────────────────────────────────────────────────
  async function exportReport(lhAvg) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const url = getCurrentUrl() || '';
      const path = await save({
        defaultPath: `prelaunch-${slug(hostOf(url))}-${new Date().toISOString().slice(0, 10)}.html`,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (!path) return;
      const html = buildReportHtml(url, lastResults, lhAvg);
      await invoke('qa_write_text', { path, contents: html });
      flash('Report exported.');
    } catch (err) {
      flash(`Export failed: ${err}`, true);
    }
  }

  return {};
}

function buildLayout(container) {
  container.innerHTML = `
    <div class="rt-prelaunch">
      <div class="rt-prelaunch__controls">
        <button class="rt-toolbar__btn js-crawl">Crawl site</button>
        <label class="rt-qa-controls__toggle"><input type="checkbox" class="js-lh" checked><span>Run Lighthouse</span></label>
        <div class="rt-qa-controls__spacer"></div>
        <button class="rt-toolbar__btn js-cancel" hidden>Cancel</button>
        <button class="rt-toolbar__btn rt-toolbar__btn--primary js-audit">Run pre-launch audit</button>
      </div>
      <div class="rt-prelaunch__status js-status" hidden></div>
      <div class="rt-prelaunch__pages-list js-pages-list">
        <div class="rt-prelaunch__placeholder">Hit "Crawl site" to populate the page list.</div>
      </div>
      <div class="rt-prelaunch__results js-results"></div>
    </div>`;

  return {
    crawlBtn: container.querySelector('.js-crawl'),
    auditBtn: container.querySelector('.js-audit'),
    cancelBtn: container.querySelector('.js-cancel'),
    lighthouseToggle: container.querySelector('.js-lh'),
    statusText: container.querySelector('.js-status'),
    pagesList: container.querySelector('.js-pages-list'),
    results: container.querySelector('.js-results'),
  };
}

function buildReportHtml(url, results, lhAvg) {
  const date = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
  const totals = results.totals;
  const pageEntries = [...results.pages.entries()];
  const pagesHtml = pageEntries.map(([u, d]) => {
    const cats = {};
    for (const f of d.findings) (cats[f.category] = cats[f.category] || []).push(f);
    const sections = Object.entries(cats).map(([cat, fs]) => `
      <h3>${escapeHtml(cat)}</h3>
      <ul>${fs.map((f) => `<li><span class="b ${f.status}">${f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '⚠'}</span>${escapeHtml(f.detail)}</li>`).join('')}</ul>`).join('');
    const lh = d.lighthouse?.scores ? `
      <div class="lh">Lighthouse — Perf ${d.lighthouse.scores.performance} · A11y ${d.lighthouse.scores.accessibility} · SEO ${d.lighthouse.scores.seo} · Best ${d.lighthouse.scores.bestPractices}</div>` : '';
    return `<section><h2>${escapeHtml(u)}</h2>${lh}${sections}</section>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pre-launch report — ${escapeHtml(url)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #0f172a; background: #fff; margin: 0; padding: 40px; max-width: 900px; margin-inline: auto; }
  header { border-bottom: 1px solid #e2e8f0; padding-bottom: 18px; margin-bottom: 28px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .meta { color: #64748b; font-size: 12px; }
  .summary { display: flex; gap: 14px; padding: 14px 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 28px; font-size: 13px; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
  section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; margin: 16px 0 6px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 6px 0; border-bottom: 1px solid #f1f5f9; display: flex; gap: 8px; align-items: baseline; }
  .b { font-weight: 700; padding: 1px 6px; border-radius: 999px; font-size: 11px; }
  .b.pass { background: #dcfce7; color: #166534; }
  .b.fail { background: #fee2e2; color: #991b1b; }
  .b.warn { background: #fef3c7; color: #854d0e; }
  .lh { padding: 8px 12px; background: #f8fafc; border-radius: 8px; margin: 8px 0; font-size: 12px; color: #334155; }
  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 11px; }
</style>
</head><body>
  <header>
    <h1>Pre-launch report</h1>
    <div class="meta">${escapeHtml(url)} · ${escapeHtml(date)}</div>
  </header>
  <div class="summary">
    <span><strong>${totals.pass}</strong> passed</span>
    <span><strong>${totals.fail}</strong> failed</span>
    <span><strong>${totals.warn}</strong> warnings</span>
    ${lhAvg?.scores ? `<span><strong>${lhAvg.scores.performance}</strong> avg performance</span>` : ''}
  </div>
  ${pagesHtml}
  <footer>Prepared by Kobe Creative Studio Ltd · kobecreative.co.uk</footer>
</body></html>`;
}
