// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
//
// Pitwall's window. The data work happens in a Python process (FastF1);
// this starts it, tells the page where it is listening, and stops it on exit.
// Installed copies run the bundled backend (no Python needed) and can update
// themselves from the project's releases.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Default, Serialize)]
struct BackendInfo {
    url: Option<String>,
    token: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct Backend {
    info: Mutex<BackendInfo>,
    child: Mutex<Option<Child>>,
    /// bumped on every start and deliberate stop, so a backend that was
    /// stopped on purpose doesn't report itself as having failed
    generation: Mutex<u64>,
}

#[tauri::command]
fn backend_info(state: tauri::State<'_, Arc<Backend>>) -> BackendInfo {
    state.info.lock().unwrap().clone()
}

/// What the page shows when an update is available.
#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

/// Whether this build was made with an updater configuration (release builds).
fn updater_configured(app: &AppHandle) -> bool {
    app.config().plugins.0.contains_key("updater")
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !updater_configured(&app) {
        return Ok(None);
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download the update, stop the backend (its files are replaced), install,
/// and restart. On Windows the installer closes the app itself.
#[tauri::command]
async fn install_update(app: AppHandle, state: tauri::State<'_, Arc<Backend>>) -> Result<(), String> {
    if !updater_configured(&app) {
        return Err("This build doesn't update itself.".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update is available any more.")?;
    // the download is checked against the signing key before anything changes
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    // Windows can't replace the backend's files while it runs; elsewhere it
    // keeps running until the restart
    if cfg!(windows) {
        stop_backend(&state);
    }
    if let Err(e) = update.install(bytes) {
        if cfg!(windows) {
            // nothing was replaced: bring the backend back so the app keeps working
            start_backend(&app, state.inner().clone());
        }
        return Err(e.to_string());
    }
    app.restart();
}

fn stop_backend(state: &Backend) {
    *state.generation.lock().unwrap() += 1;
    {
        let mut info = state.info.lock().unwrap();
        info.url = None;
        info.token = None;
        info.error = None;
    }
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn is_backend_dir(dir: &Path) -> bool {
    dir.join("pitwall_backend").join("__init__.py").is_file()
}

/// The folder holding the `pitwall_backend` package.
///
/// A source checkout wins over the copy the build places beside the executable
/// (`target/release/backend`), so backend edits take effect without a rebuild.
fn find_backend_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = env::var("PITWALL_BACKEND_DIR") {
        let dir = PathBuf::from(dir);
        if is_backend_dir(&dir) {
            return Some(dir);
        }
    }
    let exe = env::current_exe().ok();
    // running from a checkout: the folder that holds both backend/ and src-tauri/
    if let Some(exe) = &exe {
        for d in exe.ancestors().skip(1) {
            let candidate = d.join("backend");
            if is_backend_dir(&candidate) && d.join("src-tauri").is_dir() {
                return Some(candidate);
            }
        }
    }
    // installed: bundled next to the app
    if let Ok(res) = app.path().resource_dir() {
        let dir = res.join("backend");
        if is_backend_dir(&dir) {
            return Some(dir);
        }
    }
    let exe = exe?;
    exe.ancestors().skip(1).map(|d| d.join("backend")).find(|c| is_backend_dir(c))
}

/// The bundled backend of an installed copy (built with PyInstaller), unless
/// this is running from a source checkout, where Python and the source win.
fn find_frozen_backend(app: &tauri::AppHandle) -> Option<PathBuf> {
    if env::var("PITWALL_BACKEND_DIR").is_ok() || env::var("PITWALL_PYTHON").is_ok() {
        return None;
    }
    if let Ok(exe) = env::current_exe() {
        if exe.ancestors().skip(1).any(|d| is_backend_dir(&d.join("backend")) && d.join("src-tauri").is_dir()) {
            return None;
        }
    }
    let name = if cfg!(windows) { "pitwall-backend.exe" } else { "pitwall-backend" };
    let exe = app.path().resource_dir().ok()?.join("backend-bin").join(name);
    if !exe.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        // packaging can drop the executable bit; put it back if we're allowed to
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&exe) {
            if meta.permissions().mode() & 0o111 == 0 {
                let mut p = meta.permissions();
                p.set_mode(p.mode() | 0o755);
                let _ = std::fs::set_permissions(&exe, p);
            }
        }
    }
    Some(exe)
}

/// A virtual environment's interpreter in `dir`, if there is one.
fn venv_python(dir: &Path) -> Option<PathBuf> {
    for venv in [".venv", "venv"] {
        let win = dir.join(venv).join("Scripts").join("python.exe");
        let unix = dir.join(venv).join("bin").join("python");
        if win.is_file() {
            return Some(win);
        }
        if unix.is_file() {
            return Some(unix);
        }
    }
    None
}

/// Python interpreters to try, best first.
fn python_candidates(backend: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let mut out: Vec<(PathBuf, Vec<String>)> = Vec::new();
    if let Ok(p) = env::var("PITWALL_PYTHON") {
        out.push((PathBuf::from(p), vec![]));
    }
    // a virtual environment in any folder above the backend or the executable
    let exe_dir = env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
    let mut seen = Vec::new();
    for start in [Some(backend.to_path_buf()), exe_dir].into_iter().flatten() {
        for d in start.ancestors() {
            if let Some(py) = venv_python(d) {
                if !seen.contains(&py) {
                    seen.push(py.clone());
                    out.push((py, vec![]));
                }
            }
        }
    }
    if cfg!(windows) {
        out.push((PathBuf::from("python"), vec![]));
        out.push((PathBuf::from("py"), vec!["-3".into()]));
    } else {
        out.push((PathBuf::from("python3"), vec![]));
        out.push((PathBuf::from("python"), vec![]));
    }
    out
}

fn spawn(python: &Path, pre: &[String], backend: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.args(pre)
        .args(["-u", "-m", "pitwall_backend", "--port", "0"])
        .current_dir(backend)
        .env("PYTHONPATH", backend);
    run(cmd)
}

fn spawn_frozen(exe: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.args(["--port", "0"]);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    run(cmd)
}

fn run(mut cmd: Command) -> std::io::Result<Child> {
    cmd.env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

fn set_error(state: &Backend, msg: String) {
    let mut info = state.info.lock().unwrap();
    if info.url.is_none() {
        info.error = Some(msg);
    }
}

fn start_backend(app: &tauri::AppHandle, state: Arc<Backend>) {
    let generation = {
        let mut g = state.generation.lock().unwrap();
        *g += 1;
        *g
    };
    let frozen = find_frozen_backend(app);
    let mut child = None;
    if let Some(exe) = &frozen {
        match spawn_frozen(exe) {
            Ok(c) => child = Some(c),
            Err(e) => {
                set_error(&state, format!("Couldn't start the bundled backend ({}): {e}. \
                    Reinstalling Pitwall usually fixes this.", exe.display()));
                return;
            }
        }
    }
    if child.is_none() {
        let Some(backend) = find_backend_dir(app) else {
            set_error(&state, "Couldn't find the backend folder (backend/pitwall_backend). \
                Set PITWALL_BACKEND_DIR to the folder that contains it.".into());
            return;
        };
        let mut tried = Vec::new();
        for (py, pre) in python_candidates(&backend) {
            match spawn(&py, &pre, &backend) {
                Ok(c) => {
                    child = Some(c);
                    break;
                }
                Err(_) => tried.push(py.display().to_string()),
            }
        }
        if child.is_none() {
            set_error(&state, format!("Couldn't start Python (tried {}). Install Python 3.10 or newer, \
                or set PITWALL_PYTHON to its path.", tried.join(", ")));
            return;
        }
    }
    let mut child = child.unwrap();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(child);

    // keep the last lines of stderr so a crash can be explained
    let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    if let Some(err) = stderr {
        let tail = tail.clone();
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut t = tail.lock().unwrap();
                t.push_back(line);
                if t.len() > 12 {
                    t.pop_front();
                }
            }
        });
    }

    if let Some(out) = stdout {
        let state = state.clone();
        let frozen = frozen.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if *state.generation.lock().unwrap() != generation {
                    break;   // stopped on purpose, or replaced by a newer start
                }
                if let Some(rest) = line.strip_prefix("PITWALL_READY ") {
                    let mut parts = rest.split_whitespace();
                    if let (Some(port), Some(token)) = (parts.next(), parts.next()) {
                        let mut info = state.info.lock().unwrap();
                        info.url = Some(format!("http://127.0.0.1:{port}"));
                        info.token = Some(token.to_string());
                        info.error = None;
                    }
                }
            }
            // stdout closed: the process has ended
            thread::sleep(std::time::Duration::from_millis(300));
            if *state.generation.lock().unwrap() != generation {
                return;   // stopped on purpose: not a failure
            }
            let detail: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
            let mut msg = String::from("The Python backend stopped.");
            if detail.iter().any(|l| l.contains("No module named")) && frozen.is_none() {
                msg.push_str(" A package is missing: run  pip install -r backend/requirements.txt");
            }
            if !detail.is_empty() {
                msg.push_str("\n\n");
                msg.push_str(&detail.join("\n"));
            }
            let mut info = state.info.lock().unwrap();
            info.url = None;
            info.token = None;
            info.error = Some(msg);
        });
    }
}

fn main() {
    let state = Arc::new(Backend::default());
    let app = tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![backend_info, check_update, install_update])
        .setup({
            let state = state.clone();
            move |app| {
                // the updater needs its settings (signing key, where to look),
                // which only release builds carry
                if updater_configured(app.handle()) {
                    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                }
                start_backend(app.handle(), state);
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Pitwall");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            stop_backend(&state);
        }
    });
}
