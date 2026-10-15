#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct ServerState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
}

fn server_entry_path() -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("OPENCURSOR_SERVER_ENTRY") {
        let path = std::path::PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let candidates = [
        "../../packages/server/dist/main.js",
        "packages/server/dist/main.js",
        "../packages/server/dist/main.js",
    ];
    for candidate in candidates {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            if let Ok(abs) = std::fs::canonicalize(&path) {
                return Some(abs);
            }
        }
    }
    if let Ok(resource_dir) = std::env::current_exe() {
        if let Some(dir) = resource_dir.parent() {
            let bundled = dir.join("server").join("main.js");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }
    None
}

fn node_binary() -> String {
    std::env::var("OPENCURSOR_NODE").unwrap_or_else(|_| "node".to_string())
}

#[tauri::command]
fn start_server(state: State<'_, ServerState>, app: AppHandle, cwd: Option<String>) -> Result<u16, String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_mut() {
        if existing.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(*state.port.lock().map_err(|e| e.to_string())?);
        }
    }

    let entry = server_entry_path().ok_or_else(|| {
        "opencursor server entry not found; build packages/server (npm run build) or set OPENCURSOR_SERVER_ENTRY".to_string()
    })?;

    let mut command = Command::new(node_binary());
    command
        .arg(entry)
        .arg("--port")
        .arg("0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if let Some(dir) = cwd.or_else(|| std::env::var("OPENCURSOR_CWD").ok()) {
        command.current_dir(dir);
    }

    let mut child = command.spawn().map_err(|e| format!("failed to spawn server: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut port: u16 = 0;
    let mut line = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if let Some(value) = trimmed.strip_prefix("OPENCURSOR_SERVER_PORT=") {
                    port = value.trim().parse::<u16>().unwrap_or(0);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if port == 0 {
        let _ = child.kill();
        return Err("server did not report a port within 20s".to_string());
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_handle.emit("server-log", line);
        }
    });

    if let Some(mut stderr) = child.stderr.take() {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let mut reader = BufReader::new(&mut stderr);
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        while let Some(index) = buffer.find('\n') {
                            let line = buffer[..index].to_string();
                            buffer.drain(..=index);
                            let _ = app_handle.emit("server-log", line);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    *guard = Some(child);
    *state.port.lock().map_err(|e| e.to_string())? = port;
    Ok(port)
}

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
fn server_port(state: State<'_, ServerState>) -> u16 {
    state.port.lock().map(|value| *value).unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![start_server, stop_server, server_port])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<ServerState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
