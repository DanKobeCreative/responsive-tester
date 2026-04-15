# Responsive Tester

Native macOS app (Tauri) for previewing URLs across a curated device matrix. Internal tool for Kobe Creative.

## Run in dev

```bash
source "$HOME/.cargo/env"   # or restart your shell
npm install                  # first time only
npm run tauri dev
```

First launch compiles ~400 Rust crates — takes 5–10 minutes. Subsequent runs are instant.

## Build a `.app`

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/dmg/Responsive Tester_0.1.0_aarch64.dmg`

Drag the contained `.app` into `/Applications`. It'll show in Spotlight, Launchpad and the Dock. Use the green button or ⌃⌘F for fullscreen.

## Notes

- The app loads URLs in iframes. Sites must allow framing from `tauri:` origin via `Content-Security-Policy: frame-ancestors`. All Kobe Creative client staging sites are configured for this.
- Not code-signed or notarised. Gatekeeper will show a "downloaded from internet" warning on first open — right-click → Open to bypass.
- Bundled icons are the default Tauri set; swap them in `src-tauri/icons/` before shipping to clients.

## Stack

- Tauri 2 (Rust + WKWebView on macOS)
- Vanilla HTML/CSS/JS — no framework. Mirrors the web version at `/responsive-tester/` on the studio site.
