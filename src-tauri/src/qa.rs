// QA Viewports bridge. Spawns the audit/live-session.js sidecar as a
// Node child process, streams its newline-delimited JSON stdout back
// to the frontend as Tauri events, and keeps stdin open for navigate /
// screenshot commands.
//
// Two paths:
// - Production: scripts copied to {app_data_dir}/audit on first install.
// - Development: scripts read directly from <repo>/audit so we don't have
//   to reinstall on every dev iteration. Resolution prefers the
//   production install if it has node_modules; otherwise falls back to
//   the dev path baked in via CARGO_MANIFEST_DIR at build time.
//
// Node + npm aren't on the launchd-inherited PATH on macOS — apps opened
// from Finder don't see /usr/local/bin or ~/.nvm/.../bin. All shell-outs
// go through `/bin/sh -lc` so the user's login shell loads ~/.zprofile
// and the right paths show up.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// ── Live sessions ──────────────────────────────────────────────────────
// Each entry is one headed Playwright window managed by audit/live-session.js.
// Keyed by `{engine}-{viewport-id}` so re-launching the same combo replaces
// the previous instance instead of stacking.

pub struct LiveSession {
    pub child: Child,
    pub stdin: ChildStdin,
}

#[derive(Default)]
pub struct LiveSessions {
    pub sessions: Mutex<HashMap<String, LiveSession>>,
}

#[derive(Deserialize)]
pub struct ViewportSpec {
    pub id: String,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "type")]
    pub kind: String, // "mobile" | "tablet" | "desktop"
}

#[derive(Deserialize, Serialize)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Deserialize)]
pub struct SessionConfig {
    pub url: String,
    pub engine: String,
    pub viewport: ViewportSpec,
    pub auth: Option<AuthCreds>,
    pub position: Option<WindowPosition>,
    // Optional viewport-fit metadata. When `fit_to_screen` is true and the
    // viewport is larger than `screen_*`, the sidecar scales the rendered
    // surface so it fits the user's display (Chromium via CDP, Firefox via
    // user-pref; WebKit emits a warning and ignores).
    #[serde(default, rename = "fitToScreen")]
    pub fit_to_screen: bool,
    #[serde(default, rename = "screenWidth")]
    pub screen_width: Option<u32>,
    #[serde(default, rename = "screenHeight")]
    pub screen_height: Option<u32>,
}

#[derive(Serialize)]
pub struct SetupStatus {
    pub node_found: bool,
    pub node_path: Option<String>,
    pub npm_found: bool,
    pub audit_dir: String,
    pub node_modules_installed: bool,
    pub playwright_browsers_installed: bool,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct AuthCreds {
    pub username: String,
    pub password: String,
}

// ── Path resolution ────────────────────────────────────────────────────

fn dev_audit_dir() -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR points at src-tauri/ on the dev machine where this
    // binary was compiled. In a shipped .app, that path won't exist on the
    // user's machine, so this fallback is a no-op there.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("audit");
    if dev.join("node_modules").exists() {
        Some(dev)
    } else {
        None
    }
}

fn prod_audit_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("audit"))
}

fn resolve_audit_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let prod = prod_audit_dir(app)?;
    if prod.join("node_modules").exists() {
        return Ok(prod);
    }
    if let Some(dev) = dev_audit_dir() {
        return Ok(dev);
    }
    Ok(prod)
}

fn ms_playwright_cache() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Caches/ms-playwright")
}

fn shell_resolve(cmd: &str) -> Option<PathBuf> {
    let out = Command::new("/bin/sh")
        .args(["-lc", &format!("command -v {}", cmd)])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn shell_quote(p: &Path) -> String {
    // Single-quote escape for /bin/sh.
    let s = p.display().to_string().replace('\'', "'\\''");
    format!("'{}'", s)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        // Skip node_modules — we npm-install fresh in the destination.
        if name == "node_modules" {
            continue;
        }
        let dst_path = dst.join(&name);
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn qa_check_setup(app: AppHandle) -> Result<SetupStatus, String> {
    let node = shell_resolve("node");
    let npm = shell_resolve("npm");
    let audit_dir = resolve_audit_dir(&app)?;
    let node_modules_installed = audit_dir.join("node_modules").exists();

    let cache = ms_playwright_cache();
    let has = |prefix: &str| -> bool {
        if let Ok(entries) = fs::read_dir(&cache) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(prefix) {
                    return true;
                }
            }
        }
        false
    };
    let playwright_browsers_installed =
        has("chromium-") && has("firefox-") && has("webkit-");

    Ok(SetupStatus {
        node_found: node.is_some(),
        node_path: node.as_ref().map(|p| p.display().to_string()),
        npm_found: npm.is_some(),
        audit_dir: audit_dir.display().to_string(),
        node_modules_installed,
        playwright_browsers_installed,
    })
}

#[tauri::command]
pub fn qa_resolve_audit_dir(app: AppHandle) -> Result<String, String> {
    Ok(resolve_audit_dir(&app)?.display().to_string())
}

// Re-sync audit JS scripts from the app bundle into the writable app
// data directory on every launch. Without this, the auto-updater
// replaces the .app bundle (with new live-session.js, smoke.js, etc.)
// but the runtime keeps using the old copies in app_data_dir that were
// installed at first run — so JS-only fixes never reach the user.
//
// Only the JS files / package manifests are synced; node_modules is
// left intact so we don't redownload Playwright on every launch. If a
// release ever bumps audit deps, the package.json copy here will trigger
// a npm-install mismatch which the next click on a session will surface.
pub fn sync_audit_scripts(app: &AppHandle) -> Result<(), String> {
    let prod = match prod_audit_dir(app) {
        Ok(p) => p,
        Err(_) => return Ok(()),  // No app_data_dir — dev mode, skip
    };
    if !prod.exists() {
        return Ok(());  // Audit deps never installed — nothing to sync yet
    }
    let resources = match app.path().resource_dir() {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    let candidates = [
        resources.join("_up_").join("audit"),
        resources.join("audit"),
    ];
    for bundled in candidates {
        if !bundled.exists() {
            continue;
        }
        // copy_dir_recursive overwrites files but doesn't delete entries
        // missing from src, so prod/node_modules survives the sync.
        copy_dir_recursive(&bundled, &prod)?;
        return Ok(());
    }
    Ok(())
}

#[tauri::command]
pub async fn qa_install_audit_deps(app: AppHandle) -> Result<(), String> {
    let prod = prod_audit_dir(&app)?;
    fs::create_dir_all(&prod).map_err(|e| e.to_string())?;

    // In production builds, copy bundled scripts from the resource dir
    // into the writable app data dir before npm install. Tauri's bundler
    // puts anything pulled in via a `..`-prefixed path (e.g. `../audit`
    // from src-tauri/) under a `_up_/` subdirectory, so check that first
    // and fall back to a flat `audit/` for future bundle layouts.
    if let Ok(resources) = app.path().resource_dir() {
        let candidates = [
            resources.join("_up_").join("audit"),
            resources.join("audit"),
        ];
        for bundled in candidates {
            if bundled.exists() {
                copy_dir_recursive(&bundled, &prod)?;
                break;
            }
        }
    }

    let emit = |status: &str, message: &str| {
        let _ = app.emit(
            "qa-install-progress",
            serde_json::json!({ "status": status, "message": message }),
        );
    };

    emit("installing", "Running npm install…");
    let output = Command::new("/bin/sh")
        .args([
            "-lc",
            &format!("cd {} && npm install --omit=dev", shell_quote(&prod)),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        emit("error", &format!("npm install failed: {}", stderr));
        return Err(format!("npm install failed: {}", stderr));
    }

    emit(
        "installing",
        "Downloading Playwright browsers — this can take a few minutes…",
    );
    let output = Command::new("/bin/sh")
        .args([
            "-lc",
            &format!("cd {} && npx playwright install", shell_quote(&prod)),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        emit("error", &format!("playwright install failed: {}", stderr));
        return Err(format!("playwright install failed: {}", stderr));
    }

    // macOS Gatekeeper attaches a quarantine attribute to every downloaded
    // browser binary; without clearing it Playwright fails on first run
    // with a cryptic "cannot be opened" error.
    let _ = Command::new("/bin/sh")
        .args(["-lc", "xattr -cr ~/Library/Caches/ms-playwright/"])
        .output();

    emit("complete", "Setup complete.");
    Ok(())
}

// ── Live sessions (Layer 3) ────────────────────────────────────────────

fn kill_session_processes(session: &mut LiveSession) {
    let pid = session.child.id() as i32;
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = session.child.kill();
    let _ = session.child.wait();
}

#[tauri::command]
pub async fn qa_launch_session(
    app: AppHandle,
    state: State<'_, LiveSessions>,
    config: SessionConfig,
) -> Result<String, String> {
    let session_id = format!("{}-{}", config.engine, config.viewport.id);

    // If an instance for this engine+viewport is already up, kill it
    // first so launches act as "replace" rather than "stack".
    {
        let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(mut existing) = guard.remove(&session_id) {
            kill_session_processes(&mut existing);
            let _ = app.emit(
                "qa-session-closed",
                serde_json::json!({ "sessionId": session_id, "reason": "replaced" }),
            );
        }
    }

    let audit_dir = resolve_audit_dir(&app)?;
    if !audit_dir.join("node_modules").exists() {
        return Err("Audit deps not installed. Run setup first.".into());
    }
    let script_path = audit_dir.join("live-session.js");
    let cmd_string = format!(
        "cd {} && node {}",
        shell_quote(&audit_dir),
        shell_quote(&script_path),
    );

    let mut child = Command::new("/bin/sh")
        .args(["-lc", &cmd_string])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut stdin = child.stdin.take().ok_or("Could not capture stdin.")?;
    let stdout = child.stdout.take().ok_or("Could not capture stdout.")?;
    let stderr = child.stderr.take().ok_or("Could not capture stderr.")?;

    // Send the initial config followed by a newline (the sidecar reads
    // exactly one line for its config, then keeps stdin open for
    // navigate commands).
    let config_json = serde_json::json!({
        "url": config.url,
        "engine": config.engine,
        "viewport": {
            "id": config.viewport.id,
            "width": config.viewport.width,
            "height": config.viewport.height,
            "type": config.viewport.kind,
        },
        "auth": config.auth,
        "position": config.position,
        "fitToScreen": config.fit_to_screen,
        "screenWidth": config.screen_width,
        "screenHeight": config.screen_height,
    });
    let mut payload = config_json.to_string();
    payload.push('\n');
    stdin
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;

    // Stderr → log events.
    {
        let app_for_stderr = app.clone();
        let id_for_stderr = session_id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                let _ = app_for_stderr.emit(
                    "qa-session-stderr",
                    serde_json::json!({ "sessionId": id_for_stderr, "line": line }),
                );
            }
        });
    }

    // Stdout reader — first reads lines synchronously until session-ready
    // (or fatal) arrives; signals back via channel; then continues to
    // emit subsequent events for the rest of the session lifetime.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let app_for_reader = app.clone();
    let id_for_reader = session_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut signalled = false;
        for line in reader.lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let mut payload: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| serde_json::json!({ "type": "log", "raw": line }));
            let event_type = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("log")
                .to_string();
            if !signalled {
                if event_type == "session-ready" {
                    let _ = tx.send(Ok(()));
                    signalled = true;
                } else if event_type == "fatal" {
                    let msg = payload
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown error")
                        .to_string();
                    let _ = tx.send(Err(msg));
                    break;
                }
            }
            if let Some(obj) = payload.as_object_mut() {
                obj.insert(
                    "sessionId".to_string(),
                    serde_json::Value::String(id_for_reader.clone()),
                );
            }
            let _ = app_for_reader.emit(&format!("qa-{}", event_type), &payload);
        }
        // Stdout EOF — sidecar exited. Clean up the entry if it's still
        // tracked, and emit a close event so the UI updates.
        let qa_state = app_for_reader.state::<LiveSessions>();
        if let Ok(mut sessions) = qa_state.sessions.lock() {
            if let Some(mut existing) = sessions.remove(&id_for_reader) {
                let _ = existing.child.wait();
            }
        }
        let _ = app_for_reader.emit(
            "qa-session-closed",
            serde_json::json!({ "sessionId": id_for_reader, "reason": "exited" }),
        );
    });

    // Block until ready or timeout.
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Session sidecar failed: {}", msg));
        }
        Err(_) => {
            // Timeout. Tear it down before returning.
            let pid = child.id() as i32;
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("Timed out waiting for browser to launch (30s).".into());
        }
    }

    {
        let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
        guard.insert(session_id.clone(), LiveSession { child, stdin });
    }

    Ok(session_id)
}

#[tauri::command]
pub fn qa_navigate_session(
    state: State<'_, LiveSessions>,
    session_id: String,
    url: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    let payload = format!(
        "{}\n",
        serde_json::json!({ "type": "navigate", "url": url })
    );
    session
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn qa_screenshot_session(
    state: State<'_, LiveSessions>,
    session_id: String,
    output_path: String,
    full_page: Option<bool>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    let payload = format!(
        "{}\n",
        serde_json::json!({
            "type": "screenshot",
            "path": output_path,
            "fullPage": full_page.unwrap_or(false),
        })
    );
    session
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    session.stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn qa_close_session(
    app: AppHandle,
    state: State<'_, LiveSessions>,
    session_id: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = guard.remove(&session_id) {
        kill_session_processes(&mut session);
        let _ = app.emit(
            "qa-session-closed",
            serde_json::json!({ "sessionId": session_id, "reason": "user" }),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn qa_close_all_sessions(
    app: AppHandle,
    state: State<'_, LiveSessions>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().map_err(|e| e.to_string())?;
    let ids: Vec<String> = guard.keys().cloned().collect();
    for id in ids {
        if let Some(mut session) = guard.remove(&id) {
            kill_session_processes(&mut session);
            let _ = app.emit(
                "qa-session-closed",
                serde_json::json!({ "sessionId": id, "reason": "user" }),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn qa_list_sessions(state: State<'_, LiveSessions>) -> Result<Vec<String>, String> {
    let guard = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(guard.keys().cloned().collect())
}

// ── Orphan sweep (startup) ─────────────────────────────────────────────
// Force-quit (kill -9, Activity Monitor) leaves zero chance for the
// app's normal cleanup hooks to run, so any live-session child
// processes survive as orphans. Sweep them on next launch.

#[tauri::command]
pub fn qa_sweep_orphans() -> Result<u32, String> {
    let patterns = ["audit/live-session.js"];
    let mut killed = 0u32;
    for pattern in patterns {
        let pids_out = Command::new("/bin/sh")
            .args(["-lc", &format!("pgrep -f {}", shell_quote_str(pattern))])
            .output();
        let count = match pids_out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32,
            _ => 0,
        };
        if count > 0 {
            let _ = Command::new("/bin/sh")
                .args(["-lc", &format!("pkill -9 -f {}", shell_quote_str(pattern))])
                .status();
            killed += count;
        }
    }
    Ok(killed)
}

fn shell_quote_str(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}
