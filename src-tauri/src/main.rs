// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The Pitwall contributors
//
// Pitwall's window. The data work happens in a Python process (FastF1);
// this starts it, tells the page where it is listening, and stops it on exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{Manager, RunEvent};

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
}

#[tauri::command]
fn backend_info(state: tauri::State<'_, Arc<Backend>>) -> BackendInfo {
    state.info.lock().unwrap().clone()
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
        .env("PYTHONPATH", backend)
        .env("PYTHONIOENCODING", "utf-8")
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
    let Some(backend) = find_backend_dir(app) else {
        set_error(&state, "Couldn't find the backend folder (backend/pitwall_backend). \
            Set PITWALL_BACKEND_DIR to the folder that contains it.".into());
        return;
    };

    let mut child = None;
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
    let Some(mut child) = child else {
        set_error(&state, format!("Couldn't start Python (tried {}). Install Python 3.10 or newer, \
            or set PITWALL_PYTHON to its path.", tried.join(", ")));
        return;
    };

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
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
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
            let detail: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
            let mut msg = String::from("The Python backend stopped.");
            if detail.iter().any(|l| l.contains("No module named")) {
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
        .invoke_handler(tauri::generate_handler![backend_info])
        .setup({
            let state = state.clone();
            move |app| {
                start_backend(app.handle(), state);
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Pitwall");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
