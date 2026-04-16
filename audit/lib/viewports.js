// Representative subset of the full device matrix. Audit runs against these by
// default; pass --viewports=all to fan out across every device the app knows.
export const DEFAULT_VIEWPORTS = [
  { id: 'galaxy-s24',     name: 'Galaxy S24',       w: 360,  h: 780,  type: 'mobile'  },
  { id: 'iphone-16',      name: 'iPhone 16',        w: 393,  h: 852,  type: 'mobile'  },
  { id: 'ipad-mini-7',    name: 'iPad Mini 7',      w: 744,  h: 1133, type: 'tablet'  },
  { id: 'ipad-pro-11-m4', name: 'iPad Pro 11" M4',  w: 834,  h: 1194, type: 'tablet'  },
  { id: 'macbook-air-13', name: 'MacBook Air 13"',  w: 1280, h: 832,  type: 'desktop' },
  { id: 'full-hd',        name: 'Full HD',          w: 1920, h: 1080, type: 'desktop' },
];

export const ALL_VIEWPORTS = [
  { id: 'galaxy-s24',        name: 'Galaxy S24',            w: 360,  h: 780,  type: 'mobile'  },
  { id: 'iphone-se',         name: 'iPhone SE',             w: 375,  h: 667,  type: 'mobile'  },
  { id: 'z-fold-cover',      name: 'Galaxy Z Fold (cover)', w: 344,  h: 882,  type: 'mobile'  },
  { id: 'iphone-16',         name: 'iPhone 16',             w: 393,  h: 852,  type: 'mobile'  },
  { id: 'iphone-16-pro',     name: 'iPhone 16 Pro',         w: 402,  h: 874,  type: 'mobile'  },
  { id: 'pixel-9',           name: 'Pixel 9',               w: 412,  h: 915,  type: 'mobile'  },
  { id: 'galaxy-s25',        name: 'Galaxy S25',            w: 412,  h: 915,  type: 'mobile'  },
  { id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max',     w: 440,  h: 956,  type: 'mobile'  },
  { id: 'ipad-mini-7',       name: 'iPad Mini 7',           w: 744,  h: 1133, type: 'tablet'  },
  { id: 'z-fold-open',       name: 'Galaxy Z Fold (open)',  w: 884,  h: 1168, type: 'tablet'  },
  { id: 'galaxy-tab-s9',     name: 'Galaxy Tab S9',         w: 800,  h: 1280, type: 'tablet'  },
  { id: 'ipad-air-m3',       name: 'iPad Air M3',           w: 820,  h: 1180, type: 'tablet'  },
  { id: 'ipad-pro-11-m4',    name: 'iPad Pro 11" M4',       w: 834,  h: 1194, type: 'tablet'  },
  { id: 'ipad-pro-13-m4',    name: 'iPad Pro 13" M4',       w: 1032, h: 1376, type: 'tablet'  },
  { id: 'macbook-air-13',    name: 'MacBook Air 13"',       w: 1280, h: 832,  type: 'desktop' },
  { id: 'laptop-hd',         name: 'Laptop HD',             w: 1366, h: 768,  type: 'desktop' },
  { id: 'macbook-pro-14',    name: 'MacBook Pro 14"',       w: 1512, h: 982,  type: 'desktop' },
  { id: 'macbook-pro-16',    name: 'MacBook Pro 16"',       w: 1728, h: 1117, type: 'desktop' },
  { id: 'full-hd',           name: 'Full HD',               w: 1920, h: 1080, type: 'desktop' },
  { id: 'qhd-1440p',         name: '1440p QHD',             w: 2560, h: 1440, type: 'desktop' },
];

export function resolveViewports(arg) {
  if (!arg || arg === 'default') return DEFAULT_VIEWPORTS;
  if (arg === 'all') return ALL_VIEWPORTS;
  const ids = arg.split(',').map((s) => s.trim());
  const hits = ALL_VIEWPORTS.filter((v) => ids.includes(v.id));
  if (!hits.length) throw new Error(`No viewports matched "${arg}"`);
  return hits;
}
