// Curated device matrix covering common real-world viewports.
// Width/height are CSS pixels — what the page sees via window.innerWidth.
const DEVICES = [
  // ── Mobile ──
  { id: 'galaxy-s24',        name: 'Galaxy S24',          w: 360,  h: 780,  type: 'mobile' },
  { id: 'iphone-se',         name: 'iPhone SE',           w: 375,  h: 667,  type: 'mobile' },
  { id: 'iphone-15',         name: 'iPhone 15',           w: 390,  h: 844,  type: 'mobile' },
  { id: 'pixel-8',           name: 'Pixel 8',             w: 412,  h: 915,  type: 'mobile' },
  { id: 'galaxy-s24-ultra',  name: 'Galaxy S24 Ultra',    w: 412,  h: 915,  type: 'mobile' },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max',   w: 430,  h: 932,  type: 'mobile' },
  // ── Tablet ──
  { id: 'ipad-mini',         name: 'iPad Mini',           w: 744,  h: 1133, type: 'tablet' },
  { id: 'galaxy-tab-s9',     name: 'Galaxy Tab S9',       w: 800,  h: 1280, type: 'tablet' },
  { id: 'ipad',              name: 'iPad',                w: 810,  h: 1080, type: 'tablet' },
  { id: 'ipad-pro-11',       name: 'iPad Pro 11"',        w: 834,  h: 1194, type: 'tablet' },
  // ── Desktop ──
  { id: 'macbook-air-13',    name: 'MacBook Air 13"',     w: 1280, h: 800,  type: 'desktop' },
  { id: 'laptop-hd',         name: 'Laptop HD',           w: 1366, h: 768,  type: 'desktop' },
  { id: 'macbook-pro-16',    name: 'MacBook Pro 16"',     w: 1728, h: 1117, type: 'desktop' },
  { id: 'full-hd',           name: 'Full HD',             w: 1920, h: 1080, type: 'desktop' },
  { id: 'qhd-1440p',         name: '1440p QHD',           w: 2560, h: 1440, type: 'desktop' },
];

const TYPE_LABEL = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop' };
const TYPES = ['mobile', 'tablet', 'desktop'];

const grid = document.querySelector('.js-rt-grid');
const sidebar = document.querySelector('.js-rt-sidebar');
const urlInput = document.querySelector('.js-rt-url');
const loadBtn = document.querySelector('.js-rt-load');
const refreshBtn = document.querySelector('.js-rt-refresh');
const filterBtns = document.querySelectorAll('.js-rt-filter');
const scaleInput = document.querySelector('.js-rt-scale');
const scaleValue = document.querySelector('.js-rt-scale-value');

const enabled = DEVICES.reduce((acc, d) => { acc[d.id] = true; return acc; }, {});

const state = {
  url: '',
  scale: 0.4,
  filter: 'all',
};

function buildSidebar() {
  sidebar.innerHTML = TYPES.map((type) => {
    const rows = DEVICES.filter((d) => d.type === type).map((d) => `
      <label class="rt-sidebar__toggle">
        <input type="checkbox" data-device="${d.id}" checked>
        <span class="rt-sidebar__toggle-name">${d.name}</span>
        <span class="rt-sidebar__toggle-dims">${d.w}</span>
      </label>
    `).join('');
    return `
      <div class="rt-sidebar__section">
        <div class="rt-sidebar__title"><span class="rt-dot rt-dot--${type}"></span>${TYPE_LABEL[type]}</div>
        ${rows}
      </div>
    `;
  }).join('');

  sidebar.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      enabled[cb.dataset.device] = cb.checked;
      applyVisibility();
    });
  });
}

function buildGrid() {
  grid.innerHTML = DEVICES.map((d) => `
    <div class="rt-device" data-type="${d.type}" data-id="${d.id}">
      <div class="rt-device__label">
        <span class="rt-device__label-name"><span class="rt-dot rt-dot--${d.type}"></span>${d.name}</span>
        <span class="rt-device__dims">${d.w} × ${d.h}</span>
      </div>
      <div class="rt-device__shell">
        <iframe class="rt-device__frame" title="${d.name} preview" loading="lazy"></iframe>
      </div>
    </div>
  `).join('');
  applyScale();
  applyVisibility();
}

function applyScale() {
  DEVICES.forEach((d) => {
    const wrap = grid.querySelector(`.rt-device[data-id="${d.id}"]`);
    if (!wrap) return;
    const shell = wrap.querySelector('.rt-device__shell');
    const iframe = wrap.querySelector('.rt-device__frame');
    const scaledW = Math.round(d.w * state.scale);
    const scaledH = Math.round(d.h * state.scale);
    shell.style.width = `${scaledW + 16}px`;
    shell.style.height = `${scaledH + 16}px`;
    iframe.style.width = `${d.w}px`;
    iframe.style.height = `${d.h}px`;
    iframe.style.transform = `scale(${state.scale})`;
  });
}

function applyVisibility() {
  DEVICES.forEach((d) => {
    const wrap = grid.querySelector(`.rt-device[data-id="${d.id}"]`);
    if (!wrap) return;
    const matchesFilter = state.filter === 'all' || state.filter === d.type;
    const show = enabled[d.id] && matchesFilter;
    wrap.classList.toggle('is-hidden', !show);
  });
}

function loadUrl() {
  const raw = urlInput.value.trim();
  if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  urlInput.value = url;
  state.url = url;
  const bust = `_rt=${Date.now()}`;
  grid.querySelectorAll('.rt-device__frame').forEach((iframe) => {
    const sep = url.indexOf('?') > -1 ? '&' : '?';
    iframe.src = `${url}${sep}${bust}`;
  });
}

loadBtn.addEventListener('click', loadUrl);
refreshBtn.addEventListener('click', loadUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrl();
});

filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterBtns.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.filter = btn.dataset.filter;
    applyVisibility();
  });
});

scaleInput.addEventListener('input', () => {
  state.scale = parseInt(scaleInput.value, 10) / 100;
  scaleValue.textContent = `${scaleInput.value}%`;
  applyScale();
});

buildSidebar();
buildGrid();
