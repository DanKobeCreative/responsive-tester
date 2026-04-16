// Copy hygiene — placeholder sniffer, stale years, weak link text, em-dash
// check (Kobe prefers double-dash). URL-level; runs once at default viewport.

const PLACEHOLDERS = [
  /lorem\s+ipsum/i,
  /\bTBD\b/,
  /\btk\b/i,
  /placeholder(?: text)?/i,
  /coming\s+soon/i,
  /under\s+construction/i,
];

const WEAK_LINK_TEXT = /^(click here|read more|learn more|here|more|link)$/i;

export default async function check(page) {
  const currentYear = new Date().getFullYear();
  const issues = await page.evaluate(({ placeholders, weakLink, currentYear }) => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const describe = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      const trimmed = text.trim();

      for (const re of placeholders) {
        const source = re.source;
        if (new RegExp(source, re.flags).test(text)) {
          out.push({ kind: 'placeholder', match: trimmed.slice(0, 80), selector: describe(node.parentElement) });
        }
      }

      if (text.includes('—')) {
        out.push({ kind: 'em-dash', match: trimmed.slice(0, 80), selector: describe(node.parentElement) });
      }

      // Stale copyright: look for a year 3+ years before current
      const yearMatch = text.match(/©\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/);
      if (yearMatch) {
        const y = parseInt(yearMatch[1], 10);
        if (!Number.isNaN(y) && currentYear - y >= 2) {
          out.push({ kind: 'stale-year', match: trimmed.slice(0, 80), year: y, selector: describe(node.parentElement) });
        }
      }
    }

    // Weak link text
    for (const a of document.querySelectorAll('a')) {
      const t = (a.textContent || '').trim();
      if (weakLink.some((re) => new RegExp(re.source, re.flags).test(t))) {
        out.push({ kind: 'weak-link-text', match: t, selector: describe(a) });
      }
    }

    return out;
  }, { placeholders: PLACEHOLDERS, weakLink: [WEAK_LINK_TEXT], currentYear });

  return issues.map((i) => {
    const severityByKind = { 'placeholder': 'error', 'em-dash': 'info', 'stale-year': 'warning', 'weak-link-text': 'warning' };
    const labelByKind = {
      'placeholder': `Placeholder copy: "${i.match}"`,
      'em-dash': `Em-dash found — Kobe style prefers double-dash: "${i.match}"`,
      'stale-year': `Stale copyright year (${i.year}): "${i.match}"`,
      'weak-link-text': `Weak link text: "${i.match}"`,
    };
    return {
      check: `copy:${i.kind}`,
      severity: severityByKind[i.kind],
      message: labelByKind[i.kind],
      selector: i.selector,
      meta: i,
    };
  });
}
