// Horizontal overflow — elements whose right edge crosses the viewport.
// Only reports the *outermost* offending element in each chain so one hero
// section bleeding 40px right doesn't produce 200 findings for its children.

export default async function check(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const TOLERANCE = 1;
    const offenders = new Set();
    const all = Array.from(document.body.querySelectorAll('*'));

    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 10 || rect.height <= 4) continue;
      if (rect.right - vw <= TOLERANCE) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') continue;
      offenders.add(el);
    }

    // Prune children whose ancestor is already flagged.
    const roots = [...offenders].filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (offenders.has(p)) return false;
      }
      return true;
    });

    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      return tag + id + cls;
    };

    return roots.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        selector: describe(el),
        overflowPx: Math.round(rect.right - vw),
        elementWidth: Math.round(rect.width),
      };
    });
  }).then((raw) => raw.map((o) => ({
    check: 'overflow',
    severity: 'error',
    message: `Extends ${o.overflowPx}px past the viewport (element width ${o.elementWidth}px)`,
    selector: o.selector,
    meta: o,
  })));
}
