use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LLAMA_PORT: u16 = 11544;
const AUX_PORT: u16 = 11545;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Common shape of a managed llama-server instance so the spawn/poll logic is
/// shared between the main translator (11544) and the aux terminologist (11545).
trait LlamaSrv: Send + Sync + 'static {
    const LABEL: &'static str;
    const PORT: u16;
    const CTX: &'static str;
    const MODEL_FILE: &'static str;
    /// Status string used once the port answers ("spawned" for the main server
    /// to keep the existing frontend contract, "up" for aux).
    const UP: &'static str;
    fn child(&self) -> &Mutex<Option<Child>>;
    fn status(&self) -> &Mutex<String>;
}

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

impl LlamaSrv for TranslationState {
    const LABEL: &'static str = "translation";
    const PORT: u16 = LLAMA_PORT;
    const CTX: &'static str = "4096";
    const MODEL_FILE: &'static str = "HY-MT1.5-7B-Q4_K_M.gguf";
    const UP: &'static str = "spawned";
    fn child(&self) -> &Mutex<Option<Child>> {
        &self.child
    }
    fn status(&self) -> &Mutex<String> {
        &self.status
    }
}

struct AuxState {
    /// The aux llama-server child process, present ONLY if we spawned it ourselves.
    child: Mutex<Option<Child>>,
    /// "none" | "external" | "starting" | "up" | "dead"
    status: Mutex<String>,
}

impl Default for AuxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            // Not started on app launch: idle until aux_model_start is invoked.
            status: Mutex::new("none".into()),
        }
    }
}

impl LlamaSrv for AuxState {
    const LABEL: &'static str = "aux";
    const PORT: u16 = AUX_PORT;
    const CTX: &'static str = "8192";
    const MODEL_FILE: &'static str = "Qwen3.5-4B-Q4_K_M.gguf";
    const UP: &'static str = "up";
    fn child(&self) -> &Mutex<Option<Child>> {
        &self.child
    }
    fn status(&self) -> &Mutex<String> {
        &self.status
    }
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Run `llama-server.exe --list-devices` and pick the best GPU:
/// prefer NVIDIA, else the first non-integrated device. None => CPU mode.
fn pick_device(exe: &Path, label: &str) -> Option<String> {
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
            eprintln!("[{label}] --list-devices failed to run: {e}");
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
            eprintln!("[{label}] device pick: {id} ({}) [NVIDIA, preferred]", name.trim());
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
        Some(id) => eprintln!("[{label}] device pick: {id} [non-integrated fallback]"),
        None => eprintln!("[{label}] device pick: none (no discrete GPU) -> CPU mode"),
    }
    fallback
}

fn set_status<S: LlamaSrv>(app: &tauri::AppHandle, s: &str) {
    let state = app.state::<S>();
    *state.status().lock().unwrap() = s.into();
}

/// Spawn (or attach to) a llama-server instance for S. Blocking: run on a
/// background thread. Status transitions:
///   model missing / exe missing -> "none"
///   port already answering      -> "external" (reused, never killed)
///   spawn failed / died early / no answer in 120s -> "dead"
///   port answers                -> S::UP
fn init_llama_server<S: LlamaSrv>(app: tauri::AppHandle) {
    let label = S::LABEL;
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[{label}] cannot resolve app data dir: {e} -> status none");
            set_status::<S>(&app, "none");
            return;
        }
    };
    let model = data_dir.join("models").join(S::MODEL_FILE);
    let exe = data_dir.join("llama").join("llama-server.exe");

    if !model.exists() {
        eprintln!("[{label}] model not found at {} -> status none", model.display());
        set_status::<S>(&app, "none");
        return;
    }
    if port_open(S::PORT) {
        eprintln!(
            "[{label}] port {} already answering -> reusing external llama-server (no spawn, will never kill it)",
            S::PORT
        );
        set_status::<S>(&app, "external");
        return;
    }
    if !exe.exists() {
        eprintln!("[{label}] llama-server.exe not found at {} -> status none", exe.display());
        set_status::<S>(&app, "none");
        return;
    }

    set_status::<S>(&app, "starting");
    let device = pick_device(&exe, label);

    let mut cmd = Command::new(&exe);
    cmd.arg("-m")
        .arg(&model)
        .arg("--port")
        .arg(S::PORT.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("-c")
        .arg(S::CTX)
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
            eprintln!("[{label}] failed to spawn llama-server: {e} -> status dead");
            set_status::<S>(&app, "dead");
            return;
        }
    };
    let pid = child.id();
    eprintln!(
        "[{label}] spawned llama-server pid {pid} on port {} (device: {})",
        S::PORT,
        device.as_deref().unwrap_or("CPU")
    );
    {
        let state = app.state::<S>();
        *state.child().lock().unwrap() = Some(child);
    }

    // Poll until the HTTP port answers (model load can take a while).
    for _ in 0..240 {
        std::thread::sleep(Duration::from_millis(500));
        {
            let state = app.state::<S>();
            let mut guard = state.child().lock().unwrap();
            if let Some(c) = guard.as_mut() {
                if let Ok(Some(code)) = c.try_wait() {
                    eprintln!("[{label}] llama-server pid {pid} exited early ({code}) -> status dead");
                    drop(guard);
                    set_status::<S>(&app, "dead");
                    return;
                }
            } else {
                return; // child already taken: app exiting or explicitly stopped
            }
        }
        if port_open(S::PORT) {
            eprintln!("[{label}] llama-server pid {pid} is up -> status {}", S::UP);
            set_status::<S>(&app, S::UP);
            return;
        }
    }
    eprintln!("[{label}] llama-server pid {pid} did not answer within 120s -> status dead");
    set_status::<S>(&app, "dead");
}

/// Re-derive the aux status: a spawned child that exited => "dead";
/// an external instance whose port stopped answering => "dead".
fn refresh_aux_status(state: &AuxState) -> String {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                *state.status.lock().unwrap() = "dead".into();
            }
        }
    }
    let mut status = state.status.lock().unwrap();
    if status.as_str() == "external" && !port_open(AUX_PORT) {
        *status = "dead".into();
    }
    status.clone()
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

/// Start the aux (terminologist) llama-server on port 11545. Returns
/// immediately; poll aux_model_status for progress. Idempotent: if already
/// starting/up/external, no second spawn happens and the current status is
/// returned.
#[tauri::command]
fn aux_model_start(app: tauri::AppHandle, state: tauri::State<'_, AuxState>) -> String {
    let current = refresh_aux_status(&state);
    match current.as_str() {
        "starting" | "up" | "external" => current,
        _ => {
            // Reap a dead child if one is still stored, then respawn.
            if let Some(mut old) = state.child.lock().unwrap().take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *state.status.lock().unwrap() = "starting".into();
            let handle = app.clone();
            std::thread::spawn(move || init_llama_server::<AuxState>(handle));
            "starting".into()
        }
    }
}

/// Stop the aux llama-server if WE spawned it (an external instance is left
/// untouched). Safe to call when nothing is running.
#[tauri::command]
fn aux_model_stop(state: tauri::State<'_, AuxState>) {
    let taken = state.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        eprintln!("[aux] stop -> killing spawned llama-server pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
        *state.status.lock().unwrap() = "none".into();
    } else {
        let mut status = state.status.lock().unwrap();
        if status.as_str() != "external" {
            *status = "none".into();
        }
    }
}

/// "none" | "external" | "starting" | "up" | "dead"
#[tauri::command]
fn aux_model_status(state: tauri::State<'_, AuxState>) -> String {
    refresh_aux_status(&state)
}

fn kill_spawned<S: LlamaSrv>(app: &tauri::AppHandle) {
    let state = app.state::<S>();
    let taken = state.child().lock().unwrap().take();
    if let Some(mut child) = taken {
        eprintln!(
            "[{}] app exit -> killing spawned llama-server pid {}",
            S::LABEL,
            child.id()
        );
        let _ = child.kill();
        let _ = child.wait();
    }
    // external instance: nothing in state.child, nothing to kill
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(TranslationState::default())
        .manage(AuxState::default())
        .invoke_handler(tauri::generate_handler![
            translation_status,
            aux_model_start,
            aux_model_stop,
            aux_model_status
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || init_llama_server::<TranslationState>(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_spawned::<TranslationState>(app_handle);
                kill_spawned::<AuxState>(app_handle);
            }
        });
}
