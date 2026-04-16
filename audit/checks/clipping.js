// Text clipping — element content wider than its box with overflow hidden or
// a truncation ellipsis applied. Misses canvas/SVG clipping but catches the
// common CSS overflow:hidden + text-overflow:ellipsis patterns and
// single-line headers that run long on narrow viewports.

export default async function check(page) {
  return page.evaluate(() => {
    const out = [];
    const all = Array.from(document.body.querySelectorAll('*'));

    for (const el of all) {
      if (!el.childNodes.length) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 3) continue;

      const style = getComputedStyle(el);
      const hiddenX = style.overflowX === 'hidden' || style.overflow === 'hidden';
      const clampEllipsis = style.textOverflow === 'ellipsis' && (style.whiteSpace === 'nowrap' || style.overflow === 'hidden');
      const lineClamp = parseInt(style.webkitLineClamp || '0', 10);

      const clippedX = hiddenX && el.scrollWidth > el.clientWidth + 1;
      const clippedY = lineClamp > 0 && el.scrollHeight > el.clientHeight + 1;

      if (!clippedX && !clippedY && !(clampEllipsis && el.scrollWidth > el.clientWidth + 1)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20) continue;

      out.push({
        selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        axis: clippedY ? 'vertical' : 'horizontal',
        preview: text.slice(0, 80),
      });
    }
    return out;
  }).then((items) => items.map((o) => ({
    check: 'clipping',
    severity: 'warning',
    message: `${o.axis} clipping — "${o.preview}${o.preview.length >= 80 ? '…' : ''}"`,
    selector: o.selector,
    meta: o,
  })));
}
