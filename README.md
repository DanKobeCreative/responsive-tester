# Responsive Tester

Native macOS app (Tauri) for previewing URLs across a curated device matrix. Internal tool for Kobe Creative.

## Run in dev

```bash
source "$HOME/.cargo/env"   # or restart your shell
npm install                  # first time only
npm run tauri dev
```

First launch compiles ~400 Rust crates — takes 5–10 minutes. Subsequent runs are instant.

## Build

Apple Silicon only (fast):

```bash
npm run tauri build
```

Universal binary (Intel + Apple Silicon, ~2× build time):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build:universal
```

Output: `src-tauri/target/release/bundle/dmg/Responsive Tester_<version>_*.dmg`. Drag the contained `.app` into `/Applications`.

## Features

- **Persisted state** — URL, scale, filter, device toggles, bookmarks, custom devices, auth, recent URLs all stored in `localStorage` and restored on launch.
- **Bookmarks** — bookmark the current URL (⌘D or ☆ button); one-click load from the sidebar.
- **Recent URLs** — last 8 URLs appear as suggestions under the URL input.
- **Per-device controls** — hover a device to reveal: rotate (⇄), reload just this frame (↻), focus/maximize (⤢), screenshot (📷).
- **Screenshots** — per-frame or "capture all visible" → saved to `~/Desktop/responsive-tester-<timestamp>/`. Finder opens automatically after batch.
- **Custom devices** — add your own width/height under Settings → Add custom device.
- **Basic auth** — save `user:pass` per host in Settings; credentials auto-embedded in the URL on load.
- **Load-failure detection** — frames that fail or time out (8s) show a card explaining the likely cause (CSP `frame-ancestors`, network, etc).
- **Sync scroll** — optional; requires a one-line opt-in script on client staging sites (snippet in Settings panel).
- **Dark mode** — follows system `prefers-color-scheme`.
- **CLI launch** — `open -a "Responsive Tester" --args https://foo.staging.kobecreative.co.uk` preloads the URL. Hooks cleanly into `/verify`, `/audit`, etc.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘L | Focus URL |
| ⌘R | Reload all frames |
| ⌘D | Bookmark current URL |
| ⌘0 / ⌘1 / ⌘2 / ⌘3 | Filter all / mobile / tablet / desktop |
| ⌘, | Open settings |
| Esc | Close settings or exit focused device |

## Notes

- Frames are iframes. Sites must allow framing via `Content-Security-Policy: frame-ancestors`. All Kobe Creative client staging sites are configured for this.
- Per-iframe user-agent / devicePixelRatio / touch emulation is not possible inside a single WebView — all frames inherit the host WebView's identity. Sites doing UA-based redirects see `Safari/WKWebView`, not "iPhone Safari". This is a browser-enforced limitation, not an app bug.
- Not code-signed or notarised. Gatekeeper will warn on first open — right-click → Open to bypass. For distribution outside the studio, sign with an Apple Developer ID and notarise via `xcrun notarytool`.

## Stack

- Tauri 2 (Rust + WKWebView on macOS)
- Vanilla HTML/CSS/JS — no framework. Mirrors the web version at `/responsive-tester/` on the studio site.
