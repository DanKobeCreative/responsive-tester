mod qa;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use qa::{LiveSessions, PrelaunchState, QaState};


struct CliState {
    url: Option<String>,
}

struct VideoState {
    proc: Option<Child>,
    path: Option<PathBuf>,
}

#[tauri::command]
fn get_cli_url(state: State<'_, Mutex<CliState>>) -> Option<String> {
    state.lock().ok().and_then(|s| s.url.clone())
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn new_batch_dir() -> Result<PathBuf, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let dir = home_dir()
        .join("Desktop")
        .join(format!("responsive-tester-{}", ts));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn screenshot_batch_start() -> Result<String, String> {
    Ok(new_batch_dir()?.to_string_lossy().to_string())
}

/// Launch the given URL in an external macOS app or the iOS Simulator.
/// `target` is one of: "safari", "chrome", "firefox", "ios-simulator".
/// For ios-simulator we first boot Simulator.app (auto-selects the last-
/// used device, or a default), then pipe the URL in via `xcrun simctl`.
#[tauri::command]
fn open_externally(target: String, url: String) -> Result<(), String> {
    match target.as_str() {
        "safari" => run_open(&["-a", "Safari", &url]),
        "chrome" => run_open(&["-a", "Google Chrome", &url]),
        "firefox" => run_open(&["-a", "Firefox", &url]),
        "ios-simulator" => {
            // Boot Simulator.app (no-op if already open) so a device is
            // available for simctl to pipe the URL to.
            let _ = Command::new("open").args(["-a", "Simulator"]).output();
            // Give the Simulator a moment to finish booting a device — a
            // cold-start takes ~2–3 seconds before simctl sees "booted".
            std::thread::sleep(Duration::from_millis(2500));
            let status = Command::new("xcrun")
                .args(["simctl", "openurl", "booted", &url])
                .output()
                .map_err(|e| format!("xcrun failed: {}", e))?;
            if !status.status.success() {
                let stderr = String::from_utf8_lossy(&status.stderr);
                return Err(format!(
                    "iOS Simulator couldn't open the URL — make sure Xcode is installed and a simulator is booted ({}).",
                    stderr.trim()
                ));
            }
            Ok(())
        }
        other => Err(format!("Unknown target: {}", other)),
    }
}

fn run_open(args: &[&str]) -> Result<(), String> {
    Command::new("open")
        .args(args)
        .output()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn safe_filename(label: &str) -> String {
    label
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

#[tauri::command]
fn screenshot_region(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    label: String,
    batch_dir: Option<String>,
) -> Result<String, String> {
    let pos = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let logical = pos.to_logical::<f64>(scale);

    let screen_x = logical.x + x;
    let screen_y = logical.y + y;

    let dir = match batch_dir {
        Some(d) => PathBuf::from(d),
        None => new_batch_dir()?,
    };
    let path = dir.join(format!("{}.png", safe_filename(&label)));

    let status = Command::new("screencapture")
        .arg("-x")
        .arg("-R")
        .arg(format!("{},{},{},{}", screen_x, screen_y, w, h))
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err(format!("screencapture exited with {:?}", status.code()));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Video recording ──────────────────────────────────────────────────
// macOS `screencapture -V <seconds>` records a fixed-duration .mov.
// We spawn it with a region matching the app window. Process handle is
// tracked so we can cancel early via `video_stop`.
#[tauri::command]
fn video_start(
    window: tauri::WebviewWindow,
    seconds: u32,
    state: State<'_, Mutex<VideoState>>,
) -> Result<String, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if guard.proc.is_some() {
        return Err("recording already in progress".into());
    }

    let pos = window.inner_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_pos = pos.to_logical::<f64>(scale);
    let logical_size = size.to_logical::<f64>(scale);

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let path = home_dir()
        .join("Desktop")
        .join(format!("responsive-tester-{}.mov", ts));

    let child = Command::new("screencapture")
        .arg("-v")
        .arg("-V")
        .arg(seconds.to_string())
        .arg("-R")
        .arg(format!(
            "{},{},{},{}",
            logical_pos.x, logical_pos.y, logical_size.width, logical_size.height
        ))
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    guard.proc = Some(child);
    guard.path = Some(path.clone());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn video_stop(state: State<'_, Mutex<VideoState>>) -> Result<Option<String>, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.proc.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(guard.path.as_ref().map(|p| p.to_string_lossy().to_string()))
}

// ── HTTP fetching ────────────────────────────────────────────────────
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ResponsiveTester/1.0")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_url_text(url: String) -> Result<String, String> {
    let client = http_client()?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_url_meta(url: String) -> Result<serde_json::Value, String> {
    let client = http_client()?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "finalUrl": final_url,
        "status": status,
        "headers": headers,
        "body": body,
    }))
}

// ── Link checker ─────────────────────────────────────────────────────
#[derive(Serialize, Deserialize)]
struct LinkResult {
    url: String,
    status: Option<u16>,
    error: Option<String>,
    redirect: Option<String>,
}

#[tauri::command]
async fn check_links(urls: Vec<String>) -> Result<Vec<LinkResult>, String> {
    let client = http_client()?;
    let results = stream::iter(urls.into_iter().map(|url| {
        let client = client.clone();
        async move {
            // Try HEAD first; some servers respond 405, fall back to GET.
            let head_res = client.head(&url).send().await;
            let resp = match head_res {
                Ok(r) if r.status().as_u16() != 405 => Ok(r),
                _ => client.get(&url).send().await,
            };
            match resp {
                Ok(r) => {
                    let status = r.status().as_u16();
                    let final_url = r.url().to_string();
                    LinkResult {
                        redirect: if final_url != url { Some(final_url) } else { None },
                        url,
                        status: Some(status),
                        error: None,
                    }
                }
                Err(e) => LinkResult {
                    url,
                    status: None,
                    error: Some(e.to_string()),
                    redirect: None,
                },
            }
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;

    Ok(results)
}

fn parse_cli_url() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        !a.starts_with('-')
            && (a.starts_with("http://") || a.starts_with("https://") || a.contains('.'))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_url = parse_cli_url();

    // Pick an unused port on startup and serve the built frontend from
    // http://localhost:<port> via tauri-plugin-localhost. This replaces
    // the default tauri://localhost scheme so the app shell is same-
    // protocol (http) as the http://localhost:8080 sites we point it
    // at. Without this, WKWebView blocks those iframes as mixed content.
    let port = portpicker::pick_unused_port().expect("failed to find a free localhost port");
    let app_url = format!("http://localhost:{}", port);

    tauri::Builder::default()
        .plugin(tauri_plugin_localhost::Builder::new(port).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(CliState { url: cli_url }))
        .manage(Mutex::new(VideoState {
            proc: None,
            path: None,
        }))
        .manage(QaState::default())
        .manage(LiveSessions::default())
        .manage(PrelaunchState::default())
        .invoke_handler(tauri::generate_handler![
            get_cli_url,
            screenshot_batch_start,
            screenshot_region,
            reveal_in_finder,
            video_start,
            video_stop,
            fetch_url_text,
            fetch_url_meta,
            check_links,
            open_externally,
            qa::qa_check_setup,
            qa::qa_resolve_audit_dir,
            qa::qa_install_audit_deps,
            qa::qa_run_screenshot_audit,
            qa::qa_cancel_audit,
            qa::qa_launch_session,
            qa::qa_navigate_session,
            qa::qa_close_session,
            qa::qa_close_all_sessions,
            qa::qa_list_sessions,
            qa::qa_save_checklist,
            qa::qa_load_checklist,
            qa::qa_list_checklists,
            qa::qa_write_text,
            qa::qa_sweep_orphans,
            qa::qa_save_baseline,
            qa::qa_list_baselines,
            qa::qa_delete_baseline,
            qa::qa_get_baseline_for_url,
            qa::qa_save_baseline_masks,
            qa::qa_run_diff,
            qa::qa_run_crawl,
            qa::qa_run_prelaunch,
            qa::qa_cancel_prelaunch,
        ])
        .setup(move |app| {
            use tauri::{WebviewUrl, WebviewWindowBuilder};
            // The windows array in tauri.conf.json is ignored when we build
            // a window programmatically. Production builds load via the
            // localhost plugin so http://localhost:8080 dev sites stop
            // hitting WKWebView's mixed-content block. Dev builds have to
            // use Vite's dev URL because tauri-plugin-localhost resolves
            // frontendDist from resource_dir(), which is empty under
            // `cargo tauri dev` — pointing the webview there yields a
            // blank page. HMR is the bigger DX win in dev anyway.
            let main_url: tauri::Url = if cfg!(dev) {
                "http://localhost:1420".parse().expect("invalid dev url")
            } else {
                app_url.parse().expect("invalid localhost url")
            };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(main_url))
                .title("Responsive Tester")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .build()?;

            // Sweep any leftover live-session / cross-browser children
            // from a previous force-quit so they don't accumulate as
            // hidden orphans across launches.
            match qa::qa_sweep_orphans() {
                Ok(n) if n > 0 => eprintln!("qa: cleaned up {} orphan QA child process(es)", n),
                Ok(_) => {}
                Err(e) => eprintln!("qa: orphan sweep failed: {}", e),
            }

            // Cmd+Q / window close → kill every live session before the
            // window goes away. Fired by Tauri before the window actually
            // closes, so the kills land cleanly.
            let app_for_close = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let _ = qa::qa_close_all_sessions(
                        app_for_close.clone(),
                        app_for_close.state::<LiveSessions>(),
                    );
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Backstop for paths that bypass the window-event hook (the
            // platform exit, an unexpected app-process shutdown, etc.).
            if let tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } = event {
                let _ = qa::qa_close_all_sessions(
                    app.clone(),
                    app.state::<LiveSessions>(),
                );
            }
        });
}
