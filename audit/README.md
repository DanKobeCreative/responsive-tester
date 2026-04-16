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
- `--delay-ms=1000` — pause between viewports; useful when the target is behind aggressive rate-limiting (Hetzner fail2ban, Cloudflare, etc.)
- `--vision` — enable the aesthetic pass via a local Ollama vision model (opt-in — adds ~10–30s per viewport)
- `--vision-model=llama3.2-vision` — override the vision model (any Ollama vision-capable model works; must be `ollama pull`-ed already)
- `--vision-host=http://localhost:11434` — override Ollama host

### Vision prerequisites

The aesthetic check needs a local Ollama server with a vision model pulled. On Apple Silicon, **install the Ollama.app cask** (universal binary with Metal GPU support) rather than the formula, which ships an Intel-only binary that runs under Rosetta and is 10–20× slower:

```bash
brew install --cask ollama-app
open /Applications/Ollama.app    # starts the server, sits in menubar
ollama pull llama3.2-vision
```

### Quality expectations — read this

Local 11B vision models are a blunt instrument. Expect:

- **Signal** — ~40% of findings are real and actionable (overflow, cropping, obvious misalignment)
- **Noise** — ~60% are hallucinations ("text appears out of focus" on an intentionally stylised hero) or misreadings ("MONARCHS" when the word is "MONVRCHS")

Every finding needs a human pass before you act on it. The model is useful as a second set of eyes that points you at areas to inspect yourself, not as an authoritative QA.

If you want Claude-quality aesthetic review, swap `audit/checks/aesthetic.js` to call the Anthropic API (~£0.50 per audit on Haiku). Local inference will never match a frontier model on nuanced taste.

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
