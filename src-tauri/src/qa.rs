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

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct QaState {
    pub child: Mutex<Option<Child>>,
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
