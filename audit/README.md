# Responsive audit

Drives Chromium across a grid of viewports and produces a QA-grade audit report per page — no API costs, fully deterministic.

## Run

```bash
npm run audit -- --url https://studio.staging.kobecreative.co.uk
```

### Flags

- `--url <url>` — required; the page to audit
- `--viewports=default` — six-device representative set (default)
- `--viewports=all` — every device in `audit/lib/viewports.js`
- `--viewports=galaxy-s24,iphone-16,full-hd` — explicit list
- `--out <dir>` — custom output directory (defaults to `audit-runs/<timestamp>/`)

## Output

```
audit-runs/<timestamp>/
├── report.md           # Human-readable audit grouped by viewport
├── findings.json       # Structured findings for programmatic use
└── screenshots/
    ├── galaxy-s24.png
    ├── iphone-16.png
    └── ...
```

The process exits non-zero if any `error`-severity findings are recorded.

## Checks

Per viewport:
- **overflow** — root elements whose right edge crosses the viewport
- **touch-targets** — interactive elements under 44×44 CSS px on mobile (error under 24×24)
- **clipping** — text truncated by `overflow:hidden` or `-webkit-line-clamp`
- **a11y** — full axe-core WCAG 2.1 AA + best-practice pass
- **console / network** — JS errors and failed requests captured during load

Page-level (once per URL):
- **meta** — title, description, viewport, OG + Twitter cards, canonical
- **copy** — placeholder text (Lorem ipsum, TBD, coming soon), stale copyright years, weak link text ("click here"), em-dashes (Kobe style prefers double-dash)

## Adding a new check

1. Create `audit/checks/<name>.js` exporting `default async function check(page, viewport, ctx)` that returns an array of findings:

   ```js
   { check: 'your-check', severity: 'error' | 'warning' | 'info', message: '…', selector?: '…', meta?: {} }
   ```

2. Register it in `audit/run.js` under `VIEWPORT_CHECKS` or `PAGE_CHECKS`.

## Dependencies

- [playwright](https://playwright.dev/) — browser automation
- [@axe-core/playwright](https://github.com/dequelabs/axe-core-npm) — WCAG scanner

Both are dev-only and have zero per-run cost.
