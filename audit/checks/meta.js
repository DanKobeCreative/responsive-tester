// URL-level SEO / social meta checks. Runs once per page at default viewport.

const REQUIRED = [
  { key: 'title',        selector: 'title',                          kind: 'text' },
  { key: 'description',  selector: 'meta[name="description"]',       attr: 'content' },
  { key: 'viewport',     selector: 'meta[name="viewport"]',          attr: 'content' },
  { key: 'og:title',     selector: 'meta[property="og:title"]',      attr: 'content' },
  { key: 'og:description', selector: 'meta[property="og:description"]', attr: 'content' },
  { key: 'og:image',     selector: 'meta[property="og:image"]',      attr: 'content' },
  { key: 'twitter:card', selector: 'meta[name="twitter:card"]',      attr: 'content' },
  { key: 'canonical',    selector: 'link[rel="canonical"]',          attr: 'href' },
];

export default async function check(page) {
  const data = await page.evaluate((required) => {
    const out = {};
    for (const { key, selector, attr, kind } of required) {
      const el = document.querySelector(selector);
      if (!el) { out[key] = null; continue; }
      out[key] = kind === 'text' ? el.textContent?.trim() : el.getAttribute(attr);
    }
    return out;
  }, REQUIRED);

  const findings = [];
  for (const { key } of REQUIRED) {
    if (!data[key]) {
      findings.push({
        check: 'meta',
        severity: key === 'canonical' || key.startsWith('twitter') ? 'warning' : 'error',
        message: `Missing ${key}`,
        meta: { key },
      });
    }
  }
  if (data.title && data.title.length > 65) {
    findings.push({ check: 'meta', severity: 'warning', message: `Title is ${data.title.length} chars (recommend ≤65)`, meta: { title: data.title } });
  }
  if (data.description && data.description.length > 160) {
    findings.push({ check: 'meta', severity: 'warning', message: `Description is ${data.description.length} chars (recommend ≤160)`, meta: { description: data.description } });
  }
  return findings;
}
