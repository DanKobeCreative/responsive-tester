// Touch-target sizing. WCAG 2.5.8 recommends at least 24×24 CSS px; Apple and
// Material target 44×44. We warn under 44, error under 24. Only runs on
// mobile viewports — desktop interactions aren't bound by finger size.

const INTERACTIVE = 'a, button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=radio], summary, label[for]';

export default async function check(page, viewport) {
  if (viewport.type !== 'mobile') return [];

  const offenders = await page.evaluate((selector) => {
    const items = [];
    for (const el of document.querySelectorAll(selector)) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const min = Math.min(rect.width, rect.height);
      if (min >= 44) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || el.value || el.getAttribute('title') || '').trim().slice(0, 60);
      items.push({
        selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        label,
      });
    }
    return items;
  }, INTERACTIVE);

  return offenders.map((o) => ({
    check: 'touch-target',
    severity: Math.min(o.w, o.h) < 24 ? 'error' : 'warning',
    message: `${o.w}×${o.h}px — below ${Math.min(o.w, o.h) < 24 ? '24×24 (WCAG)' : '44×44 (recommended)'}${o.label ? ` — "${o.label}"` : ''}`,
    selector: o.selector,
    meta: o,
  }));
}
