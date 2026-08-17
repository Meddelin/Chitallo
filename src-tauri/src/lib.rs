use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LLAMA_PORT: u16 = 11544;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct TranslationState {
    /// The llama-server child process, present ONLY if we spawned it ourselves.
    child: Mutex<Option<Child>>,
    /// "none" | "external" | "starting" | "spawned" | "dead"
    status: Mutex<String>,
}

impl Default for TranslationState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new("starting".into()),
        }
    }
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Run `llama-server.exe --list-devices` and pick the best GPU:
/// prefer NVIDIA, else the first non-integrated device. None => CPU mode.
fn pick_device(exe: &Path) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--list-devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[translation] --list-devices failed to run: {e}");
            return None;
        }
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let mut fallback: Option<String> = None;
    for line in text.lines() {
        // e.g. "  Vulkan0: NVIDIA GeForce RTX 5080 (15977 MiB, 15209 MiB free)"
        let Some((id, name)) = line.trim().split_once(':') else {
            continue;
        };
        let id = id.trim();
        let is_device_id = (id.starts_with("Vulkan")
            || id.starts_with("CUDA")
            || id.starts_with("ROCm")
            || id.starts_with("SYCL"))
            && id.chars().last().is_some_and(|c| c.is_ascii_digit());
        if !is_device_id {
            continue;
        }
        let name_l = name.trim().to_lowercase();
        if name_l.contains("nvidia") {
            eprintln!("[translation] device pick: {id} ({}) [NVIDIA, preferred]", name.trim());
            return Some(id.to_string());
        }
        let integrated = name_l.contains("radeon(tm) graphics")
            || name_l.contains("iris")
            || name_l.contains("uhd")
            || name_l.contains("integrated");
        if !integrated && fallback.is_none() {
            fallback = Some(id.to_string());
        }
    }
    match &fallback {
        Some(id) => eprintln!("[translation] device pick: {id} [non-integrated fallback]"),
        None => eprintln!("[translation] device pick: none (no discrete GPU) -> CPU mode"),
    }
    fallback
}

fn set_status(app: &tauri::AppHandle, s: &str) {
    let state = app.state::<TranslationState>();
    *state.status.lock().unwrap() = s.into();
}

fn init_translation_server(app: tauri::AppHandle) {
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[translation] cannot resolve app data dir: {e} -> status none");
            set_status(&app, "none");
            return;
        }
    };
    let model = data_dir.join("models").join("HY-MT1.5-7B-Q4_K_M.gguf");
    let exe = data_dir.join("llama").join("llama-server.exe");

    if !model.exists() {
        eprintln!("[translation] model not found at {} -> status none", model.display());
        set_status(&app, "none");
        return;
    }
    if port_open(LLAMA_PORT) {
        eprintln!(
            "[translation] port {LLAMA_PORT} already answering -> reusing external llama-server (no spawn, will never kill it)"
        );
        set_status(&app, "external");
        return;
    }
    if !exe.exists() {
        eprintln!("[translation] llama-server.exe not found at {} -> status none", exe.display());
        set_status(&app, "none");
        return;
    }

    set_status(&app, "starting");
    let device = pick_device(&exe);

    let mut cmd = Command::new(&exe);
    cmd.arg("-m")
        .arg(&model)
        .arg("--port")
        .arg(LLAMA_PORT.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("-c")
        .arg("4096")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(id) = &device {
        cmd.arg("-ngl").arg("99").arg("--device").arg(id);
    } // else: CPU mode, omit -ngl entirely
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[translation] failed to spawn llama-server: {e} -> status dead");
            set_status(&app, "dead");
            return;
        }
    };
    let pid = child.id();
    eprintln!(
        "[translation] spawned llama-server pid {pid} on port {LLAMA_PORT} (device: {})",
        device.as_deref().unwrap_or("CPU")
    );
    {
        let state = app.state::<TranslationState>();
        *state.child.lock().unwrap() = Some(child);
    }

    // Poll until the HTTP port answers (model load can take a while).
    for _ in 0..240 {
        std::thread::sleep(Duration::from_millis(500));
        {
            let state = app.state::<TranslationState>();
            let mut guard = state.child.lock().unwrap();
            if let Some(c) = guard.as_mut() {
                if let Ok(Some(code)) = c.try_wait() {
                    eprintln!("[translation] llama-server pid {pid} exited early ({code}) -> status dead");
                    drop(guard);
                    set_status(&app, "dead");
                    return;
                }
            } else {
                return; // app is exiting, child already taken
            }
        }
        if port_open(LLAMA_PORT) {
            eprintln!("[translation] llama-server pid {pid} is up -> status spawned");
            set_status(&app, "spawned");
            return;
        }
    }
    eprintln!("[translation] llama-server pid {pid} did not answer within 120s -> status dead");
    set_status(&app, "dead");
}

#[tauri::command]
fn translation_status(state: tauri::State<'_, TranslationState>) -> String {
    // If we spawned it, verify the child is still alive.
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                *state.status.lock().unwrap() = "dead".into();
            }
        }
    }
    state.status.lock().unwrap().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(TranslationState::default())
        .invoke_handler(tauri::generate_handler![translation_status])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || init_translation_server(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<TranslationState>();
                let taken = state.child.lock().unwrap().take();
                if let Some(mut child) = taken {
                    eprintln!(
                        "[translation] app exit -> killing spawned llama-server pid {}",
                        child.id()
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                }
                // external instance: nothing in state.child, nothing to kill
            }
        });
}
