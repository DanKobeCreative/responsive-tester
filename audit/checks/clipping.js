// Text clipping — flags genuine text truncation (text-overflow:ellipsis or
// -webkit-line-clamp). Skips purely decorative overflow:hidden on sections
// with off-screen animation children, which is a valid design pattern and
// not actually clipping any readable content.

export default async function check(page) {
  return page.evaluate(() => {
    const out = [];
    const all = Array.from(document.body.querySelectorAll('*'));

    for (const el of all) {
      if (!el.childNodes.length) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 3) continue;

      const style = getComputedStyle(el);
      const textEllipsis = style.textOverflow === 'ellipsis' &&
        (style.whiteSpace === 'nowrap' || style.overflow === 'hidden' || style.overflowX === 'hidden');
      const lineClamp = parseInt(style.webkitLineClamp || '0', 10);

      const clippedText = textEllipsis && el.scrollWidth > el.clientWidth + 1;
      const clippedLines = lineClamp > 0 && el.scrollHeight > el.clientHeight + 1;

      if (!clippedText && !clippedLines) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20) continue;

      out.push({
        selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        axis: clippedLines ? 'vertical' : 'horizontal',
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
