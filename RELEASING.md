# Releasing

Releases are **fully automated via GitHub Actions** — you do not need to build the DMG locally. Pushing a `v*` tag triggers the workflow at [.github/workflows/release.yml](.github/workflows/release.yml) which builds, signs, and publishes to a GitHub Release.

## Cutting a release

1. **Bump the version** in three files — they must match:
   - [package.json](package.json)
   - [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)
   - [src-tauri/Cargo.toml](src-tauri/Cargo.toml)

2. **Commit + tag + push:**
   ```bash
   git add -A
   git commit -m "chore(release): vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z — <summary>"
   git push origin master --tags
   ```

3. **Wait ~5 min** for the Actions run at [github.com/DanKobeCreative/responsive-tester/actions](https://github.com/DanKobeCreative/responsive-tester/actions) to finish. On success it produces:
   - `Responsive.Tester_X.Y.Z_aarch64.dmg` — installable bundle
   - `Responsive.Tester_aarch64.app.tar.gz` — updater payload
   - `Responsive.Tester_aarch64.app.tar.gz.sig` — minisign signature
   - `latest.json` — updater manifest (URL + signature)

   All four are attached to `https://github.com/DanKobeCreative/responsive-tester/releases/tag/vX.Y.Z`.

4. **Existing users auto-update** via [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/) on next launch. The app's `tauri.conf.json` `updater.endpoints` points at the `/releases/latest/download/latest.json` URL, so the manifest is always the most recent.

5. **Polish the release notes** on GitHub (the workflow uses a default "See the assets below to download" body). Paste a short summary of highlights + install instructions.

## Secrets + keys

- **Private key** lives at `~/.tauri/responsive-tester` on your Mac. **Do not commit it anywhere.**
- **Pubkey** is committed in `src-tauri/tauri.conf.json` under `updater.pubkey` — matches the private key. The updater refuses to install an update whose signature doesn't verify against this pubkey.
- **GitHub Actions secret** `TAURI_SIGNING_PRIVATE_KEY` — already set in the repo settings, matches your local private key. The workflow uses this to sign the updater tarball during the build.

If you ever rotate the key (lost machine, compromised, etc.):

1. Generate fresh pair: `npm run tauri signer generate -- -w ~/.tauri/responsive-tester`
2. Copy the new pubkey into `tauri.conf.json` `updater.pubkey`
3. Update the `TAURI_SIGNING_PRIVATE_KEY` repo secret on GitHub with the new private key content
4. Commit `tauri.conf.json` + cut a new release — existing installs will accept updates signed by the new key

## Local build (for testing only)

If you need to test the release build locally without publishing:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/responsive-tester)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export CARGO_BUILD_JOBS=2      # cap to 2 cores; default parallelism can freeze the Mac
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`. **Don't** upload locally-built artifacts to a GitHub release — CI-built ones are canonical because they run on a clean macos-latest VM with consistent toolchain versions.
