// Visual overlays: color-blindness CSS filters, grid overlay, reference images.
// These all work through the cross-origin iframe boundary because they are
// applied to the iframe wrapper on our side (CSS filter, absolute-positioned
// overlay div, image overlay).

import { escapeAttr } from './utils.js';

const CB_FILTERS = {
  none: '',
  protanopia: 'url(#rt-cb-protanopia)',
  deuteranopia: 'url(#rt-cb-deuteranopia)',
  tritanopia: 'url(#rt-cb-tritanopia)',
  achromatopsia: 'grayscale(1)',
  grayscale: 'grayscale(1)',
};

export const CB_OPTIONS = [
  ['none', 'None'],
  ['protanopia', 'Protanopia (red-blind)'],
  ['deuteranopia', 'Deuteranopia (green-blind)'],
  ['tritanopia', 'Tritanopia (blue-blind)'],
  ['achromatopsia', 'Achromatopsia (total)'],
  ['grayscale', 'Grayscale'],
];

// SVG color matrices for the three red-green/blue-yellow simulations.
// Values from Machado et al. (2009), widely cited and used in dev tools.
export function injectFilterDefs() {
  if (document.getElementById('rt-cb-svg')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'rt-cb-svg';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `
    <defs>
      <filter id="rt-cb-protanopia">
        <feColorMatrix type="matrix" values="
          0.567 0.433 0     0 0
          0.558 0.442 0     0 0
          0     0.242 0.758 0 0
          0     0     0     1 0"/>
      </filter>
      <filter id="rt-cb-deuteranopia">
        <feColorMatrix type="matrix" values="
          0.625 0.375 0    0 0
          0.7   0.3   0    0 0
          0     0.3   0.7  0 0
          0     0     0    1 0"/>
      </filter>
      <filter id="rt-cb-tritanopia">
        <feColorMatrix type="matrix" values="
          0.95 0.05  0     0 0
          0    0.433 0.567 0 0
          0    0.475 0.525 0 0
          0    0     0     1 0"/>
      </filter>
    </defs>
  `;
  document.body.appendChild(svg);
}

export function applyColorBlindFilter(grid, key) {
  const filter = CB_FILTERS[key] || '';
  grid.style.filter = filter;
}

// ── Grid overlay ────────────────────────────────────────────────────
// Absolute-positioned overlay div with N evenly-spaced vertical lines.
// Rendered inside each device shell above the iframe.
export function renderGridOverlay(shell, cols) {
  let overlay = shell.querySelector('.rt-grid-overlay');
  if (!cols) {
    if (overlay) overlay.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'rt-grid-overlay';
    shell.appendChild(overlay);
  }
  const lines = Array.from({ length: cols - 1 }, (_, i) => {
    const pct = ((i + 1) / cols) * 100;
    return `<span style="left:${pct}%"></span>`;
  }).join('');
  overlay.innerHTML = lines;
}

// ── Reference image overlay ─────────────────────────────────────────
export function renderRefImage(shell, ref) {
  let img = shell.querySelector('.rt-ref-image');
  if (!ref || !ref.dataUrl) {
    if (img) img.remove();
    return;
  }
  if (!img) {
    img = document.createElement('img');
    img.className = 'rt-ref-image';
    shell.appendChild(img);
  }
  img.src = ref.dataUrl;
  img.style.opacity = ref.opacity ?? 0.5;
}

export async function pickImageAsDataUrl() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

// Toolbar dropdown HTML (populates options from CB_OPTIONS)
export function cbSelectHtml() {
  return `
    <select class="rt-toolbar__select js-rt-cb" title="Color-blindness simulator">
      ${CB_OPTIONS.map(([v, l]) => `<option value="${v}">${escapeAttr(l)}</option>`).join('')}
    </select>
  `;
}
