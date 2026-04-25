// Cross-browser QA bridge. Spawns the audit/cross-browser.js sidecar as
// a Node child process, streams its newline-delimited JSON stdout back
// to the frontend as Tauri events, and tracks the live child handle so
// it can be cancelled.
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct QaState {
    pub child: Mutex<Option<Child>>,
}

// ── Live sessions (Layer 3) ────────────────────────────────────────────
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

#[derive(Deserialize)]
pub struct ScreenshotConfig {
    pub url: String,
    #[serde(rename = "viewportIds")]
    pub viewport_ids: Vec<String>,
    pub engines: Vec<String>,
    #[serde(default = "default_full_page", rename = "fullPage")]
    pub full_page: bool,
    pub auth: Option<AuthCreds>,
}

fn default_full_page() -> bool {
    true
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

#[tauri::command]
pub fn qa_run_screenshot_audit(
    app: AppHandle,
    state: State<'_, QaState>,
    config: ScreenshotConfig,
) -> Result<String, String> {
    {
        let guard = state.child.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("An audit is already running.".into());
        }
    }

    let audit_dir = resolve_audit_dir(&app)?;
    if !audit_dir.join("node_modules").exists() {
        return Err("Audit deps not installed. Run setup first.".into());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let out_dir = app_data.join("qa-runs").join(format!("{}", ts));
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let run_id = format!("{}", ts);

    cleanup_old_qa_runs(&app_data.join("qa-runs"), 5);

    let sidecar_config = serde_json::json!({
        "url": config.url,
        "viewportIds": config.viewport_ids,
        "engines": config.engines,
        "outputDir": out_dir.display().to_string(),
        "fullPage": config.full_page,
        "auth": config.auth,
    });

    let script_path = audit_dir.join("cross-browser.js");
    let cmd_string = format!(
        "cd {} && node {}",
        shell_quote(&audit_dir),
        shell_quote(&script_path),
    );

    // Spawn in a new process group so that on cancel we can `killpg` the
    // entire tree (sh → node → playwright-browser-bin → its renderer /
    // gpu / network children). A plain `child.kill()` SIGKILLs the shell
    // only and orphans every browser process beneath it.
    let mut child = Command::new("/bin/sh")
        .args(["-lc", &cmd_string])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        let json = sidecar_config.to_string();
        stdin
            .write_all(json.as_bytes())
            .map_err(|e| e.to_string())?;
        // Closing stdin (drop) signals EOF to the child's `for await` loop.
    }

    let stdout = child.stdout.take().ok_or("Could not capture stdout.")?;
    let stderr = child.stderr.take().ok_or("Could not capture stderr.")?;

    // Stderr → log events. Helps diagnose Playwright launch failures from
    // the frontend without having to attach a debugger.
    {
        let app_for_stderr = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                let _ = app_for_stderr.emit(
                    "qa-stderr",
                    serde_json::json!({ "line": line }),
                );
            }
        });
    }

    // Stdout → typed events keyed off each NDJSON line's "type" field. EOF
    // means the child process is done; clear the live-child slot and emit
    // qa-finished so the UI always gets a terminal signal.
    let app_for_events = app.clone();
    let out_dir_for_events = out_dir.clone();
    let run_id_for_events = run_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let payload: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| serde_json::json!({ "type": "log", "raw": line }));
            let event_name = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("log");
            let _ = app_for_events.emit(&format!("qa-{}", event_name), &payload);
        }
        // Reap the child if it's still tracked here.
        let qa_state = app_for_events.state::<QaState>();
        if let Ok(mut guard) = qa_state.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.wait();
            }
        }
        let _ = app_for_events.emit(
            "qa-finished",
            serde_json::json!({
                "runId": run_id_for_events,
                "outputDir": out_dir_for_events.display().to_string(),
            }),
        );
    });

    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    Ok(run_id)
}

#[tauri::command]
pub fn qa_cancel_audit(app: AppHandle, state: State<'_, QaState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        // Kill the whole process group, not just the shell. Without this
        // the Node + Playwright browser processes survive as orphans.
        // The PGID equals the spawned shell's PID because we set
        // `process_group(0)` at spawn time.
        let pid = child.id() as i32;
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
        // Belt-and-braces: also SIGKILL the direct child in case the
        // group kill missed it for any reason, then reap.
        let _ = child.kill();
        let _ = child.wait();
        let _ = app.emit("qa-cancelled", serde_json::json!({}));
    }
    Ok(())
}

// Keep only the most recent `keep` non-baseline run dirs.
fn cleanup_old_qa_runs(runs_root: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(runs_root) else {
        return;
    };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    // Sort newest-first by directory name (timestamps).
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for old in dirs.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(old.path());
    }
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

// ── Checklist persistence (Layer 3) ────────────────────────────────────

fn checklists_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("qa-checklists");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct ChecklistMeta {
    pub url_slug: String,
    pub last_modified_ms: u128,
    pub bytes: u64,
}

#[tauri::command]
pub fn qa_save_checklist(
    app: AppHandle,
    url_slug: String,
    json: String,
) -> Result<(), String> {
    let dir = checklists_dir(&app)?;
    let path = dir.join(format!("{}.json", sanitise_slug(&url_slug)));
    fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn qa_load_checklist(
    app: AppHandle,
    url_slug: String,
) -> Result<Option<String>, String> {
    let dir = checklists_dir(&app)?;
    let path = dir.join(format!("{}.json", sanitise_slug(&url_slug)));
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
pub fn qa_list_checklists(app: AppHandle) -> Result<Vec<ChecklistMeta>, String> {
    let dir = checklists_dir(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        out.push(ChecklistMeta {
            url_slug: stem,
            last_modified_ms: modified_ms,
            bytes: metadata.len(),
        });
    }
    out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
    Ok(out)
}

fn sanitise_slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

// ── Generic file write (used by HTML report export) ───────────────────

#[tauri::command]
pub fn qa_write_text(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())
}

// ── Orphan sweep (Layer 3 startup) ─────────────────────────────────────
// Force-quit (kill -9, Activity Monitor) leaves zero chance for the
// app's normal cleanup hooks to run, so any live-session or cross-browser
// child processes survive as orphans. Sweep them on next launch.

#[tauri::command]
pub fn qa_sweep_orphans() -> Result<u32, String> {
    let patterns = ["audit/live-session.js", "audit/cross-browser.js"];
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

// ── Baselines + visual diff (Layer 4) ──────────────────────────────────

fn baselines_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("qa-baselines");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Deserialize)]
pub struct SaveBaselineConfig {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub url: String,
    pub label: Option<String>,
}

#[tauri::command]
pub fn qa_save_baseline(
    app: AppHandle,
    config: SaveBaselineConfig,
) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = app_data.join("qa-runs").join(&config.run_id);
    if !src.exists() {
        return Err(format!("Run not found: {}", config.run_id));
    }
    let url_slug = sanitise_slug(&config.url);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let id = format!("{}_{}", url_slug, ts);
    let dst = baselines_root(&app)?.join(&id);
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    copy_dir_recursive(&src, &dst)?;

    let manifest_src = src.join("manifest.json");
    let manifest_value: serde_json::Value = if manifest_src.exists() {
        fs::read_to_string(&manifest_src)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let meta = serde_json::json!({
        "id": id,
        "url": config.url,
        "urlSlug": url_slug,
        "label": config.label,
        "createdMs": ts,
        "viewports": manifest_value.get("viewports").cloned().unwrap_or(serde_json::json!([])),
        "engines": manifest_value.get("engines").cloned().unwrap_or(serde_json::json!([])),
        "masks": [],
    });
    fs::write(dst.join("baseline-meta.json"), serde_json::to_string_pretty(&meta).unwrap())
        .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn qa_list_baselines(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let root = baselines_root(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("baseline-meta.json");
        if !meta_path.exists() {
            continue;
        }
        if let Ok(txt) = fs::read_to_string(&meta_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&txt) {
                out.push(value);
            }
        }
    }
    out.sort_by(|a, b| {
        b.get("createdMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .cmp(&a.get("createdMs").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    Ok(out)
}

#[tauri::command]
pub fn qa_delete_baseline(app: AppHandle, baseline_id: String) -> Result<(), String> {
    let dir = baselines_root(&app)?.join(sanitise_slug(&baseline_id));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn qa_get_baseline_for_url(
    app: AppHandle,
    url: String,
) -> Result<Option<serde_json::Value>, String> {
    let url_slug = sanitise_slug(&url);
    let baselines = qa_list_baselines(app)?;
    Ok(baselines
        .into_iter()
        .find(|v| v.get("urlSlug").and_then(|s| s.as_str()) == Some(url_slug.as_str())))
}

#[tauri::command]
pub fn qa_save_baseline_masks(
    app: AppHandle,
    baseline_id: String,
    masks: serde_json::Value,
) -> Result<(), String> {
    let dir = baselines_root(&app)?.join(sanitise_slug(&baseline_id));
    let meta_path = dir.join("baseline-meta.json");
    if !meta_path.exists() {
        return Err("Baseline not found.".into());
    }
    let txt = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("masks".to_string(), masks);
    }
    fs::write(&meta_path, serde_json::to_string_pretty(&value).unwrap())
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct RunDiffConfig {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "baselineId")]
    pub baseline_id: String,
    #[serde(default)]
    pub masks: serde_json::Value,
    #[serde(default = "default_diff_threshold")]
    pub threshold: f32,
}

fn default_diff_threshold() -> f32 {
    0.1
}

#[tauri::command]
pub fn qa_run_diff(
    app: AppHandle,
    state: State<'_, QaState>,
    config: RunDiffConfig,
) -> Result<String, String> {
    {
        let guard = state.child.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("An audit / diff is already running.".into());
        }
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let baseline_dir = baselines_root(&app)?.join(sanitise_slug(&config.baseline_id));
    let current_dir = app_data.join("qa-runs").join(&config.run_id);
    if !baseline_dir.exists() {
        return Err(format!("Baseline not found: {}", config.baseline_id));
    }
    if !current_dir.exists() {
        return Err(format!("Run not found: {}", config.run_id));
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let out_dir = app_data.join("qa-diffs").join(format!("{}", ts));
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let diff_id = format!("{}", ts);

    let audit_dir = resolve_audit_dir(&app)?;
    if !audit_dir.join("node_modules").exists() {
        return Err("Audit deps not installed. Run setup first.".into());
    }

    let sidecar_config = serde_json::json!({
        "baselineDir": baseline_dir.display().to_string(),
        "currentDir": current_dir.display().to_string(),
        "outputDir": out_dir.display().to_string(),
        "masks": config.masks,
        "threshold": config.threshold,
    });

    let script_path = audit_dir.join("diff-runner.js");
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

    if let Some(mut stdin_pipe) = child.stdin.take() {
        let payload = sidecar_config.to_string();
        stdin_pipe
            .write_all(payload.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let stdout = child.stdout.take().ok_or("Could not capture stdout.")?;
    let stderr = child.stderr.take().ok_or("Could not capture stderr.")?;

    {
        let app_for_stderr = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                let _ = app_for_stderr
                    .emit("qa-diff-stderr", serde_json::json!({ "line": line }));
            }
        });
    }

    let app_for_events = app.clone();
    let out_dir_for_events = out_dir.clone();
    let diff_id_for_events = diff_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let payload: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|_| serde_json::json!({ "type": "log", "raw": line }));
            let event_type = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("log");
            let _ = app_for_events.emit(&format!("qa-{}", event_type), &payload);
        }
        let qa_state = app_for_events.state::<QaState>();
        if let Ok(mut guard) = qa_state.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.wait();
            }
        }
        let _ = app_for_events.emit(
            "qa-diff-finished",
            serde_json::json!({
                "diffId": diff_id_for_events,
                "outputDir": out_dir_for_events.display().to_string(),
            }),
        );
    });

    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    Ok(diff_id)
}
