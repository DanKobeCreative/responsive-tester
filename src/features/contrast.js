// WCAG contrast ratio calculator.

function hexToRgb(hex) {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function relLuminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(hex1, hex2) {
  const a = hexToRgb(hex1);
  const b = hexToRgb(hex2);
  if (!a || !b) return null;
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function gradeContrast(ratio) {
  return {
    aaNormal: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaaNormal: ratio >= 7,
    aaaLarge: ratio >= 4.5,
  };
}

export function wireContrastWidget(root) {
  const fg = root.querySelector('.js-rt-contrast-fg');
  const bg = root.querySelector('.js-rt-contrast-bg');
  const out = root.querySelector('.js-rt-contrast-out');
  const preview = root.querySelector('.js-rt-contrast-preview');

  const update = () => {
    const ratio = contrastRatio(fg.value, bg.value);
    if (ratio == null) {
      out.innerHTML = '<em>Enter valid 3- or 6-digit hex values.</em>';
      return;
    }
    const grade = gradeContrast(ratio);
    const badge = (ok, label) =>
      `<span class="rt-contrast__badge ${ok ? 'is-pass' : 'is-fail'}">${label}: ${ok ? 'PASS' : 'FAIL'}</span>`;
    out.innerHTML = `
      <div class="rt-contrast__ratio">${ratio.toFixed(2)} : 1</div>
      <div class="rt-contrast__badges">
        ${badge(grade.aaNormal, 'AA text')}
        ${badge(grade.aaLarge, 'AA large')}
        ${badge(grade.aaaNormal, 'AAA text')}
        ${badge(grade.aaaLarge, 'AAA large')}
      </div>
    `;
    preview.style.color = fg.value;
    preview.style.background = bg.value;
  };

  fg.addEventListener('input', update);
  bg.addEventListener('input', update);
  update();
}
