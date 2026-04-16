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
- `--vision` — enable the aesthetic pass (alias for `--vision=ollama`)
- `--vision=ollama` — local Ollama vision (free, modest quality, ~30–45s/viewport)
- `--vision=api` — Anthropic API via Claude Haiku (pennies/run, Claude-grade judgment, ~2–5s/viewport)
- `--vision-model=<id>` — override the vision model (any Ollama vision-capable model, or a specific Claude model id)
- `--vision-host=http://localhost:11434` — override Ollama host
- `--yes` / `-y` — skip the pre-run confirmation prompt on `--vision=api` (for scripting / CI)

### Vision backends

#### Ollama (local, free, modest quality)

Apple Silicon: **install the cask**, not the formula — the formula ships Intel-only and runs under Rosetta (10–20× slower).

```bash
brew install --cask ollama-app
open /Applications/Ollama.app    # starts the server, sits in menubar
ollama pull llama3.2-vision
```

Quality: ~40% signal / ~60% noise. The 11B model reliably catches overflow and obvious layout issues but hallucinates, misreads brand text, and struggles with nuance. Every finding needs human review.

#### Anthropic API (Claude Haiku 4.5 — pennies per run, Claude-grade judgment)

Get a key from [console.anthropic.com](https://console.anthropic.com) and drop it into a `.env` file at the project root (gitignored):

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
```

Then:

```bash
npm run audit -- --url https://... --vision=api
```

Every `--vision=api` run prints a cost estimate and waits for a `y/N` confirmation before spending — pair with `--yes` in scripts / CI to skip. Approximate cost: **1–2p per 6-viewport run on Haiku**, scaling linearly with viewport count.

You can override the model if you want sharper judgement:

```bash
npm run audit -- --url https://... --vision=api --vision-model=claude-sonnet-4-6
```

Roughly 3× the Haiku cost for measurably better taste-level critique.

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
