use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
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

/// Resolve llama-server.exe: the copy bundled as an installer resource wins
/// (решение Р-5 — the installer ships the engine, only weights are
/// downloaded); the appData copy remains as a fallback for dev setups and
/// manual installs. The DLLs live next to the exe either way, so spawning
/// from the returned path always finds them.
fn llama_server_exe(app: &tauri::AppHandle, data_dir: &Path) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("llama").join("llama-server.exe");
        if bundled.exists() {
            return bundled;
        }
    }
    data_dir.join("llama").join("llama-server.exe")
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
    let exe = llama_server_exe(&app, &data_dir);

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
    // An external instance whose port stopped answering is dead too (mirrors
    // refresh_aux_status) — otherwise the status row would say «готова» forever.
    let mut status = state.status.lock().unwrap();
    if status.as_str() == "external" && !port_open(LLAMA_PORT) {
        *status = "dead".into();
    }
    status.clone()
}

/// Restart (or first-start) the main translation llama-server. Serves the
/// model-status surfaces: "dead" → «Перезапустить», and the moment right after
/// the weights download completes ("none" → first spawn). Idempotent: while
/// starting or already up nothing is spawned and the current status returns.
#[tauri::command]
fn restart_translation(app: tauri::AppHandle, state: tauri::State<'_, TranslationState>) -> String {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                *state.status.lock().unwrap() = "dead".into();
            }
        }
    }
    {
        let mut status = state.status.lock().unwrap();
        if status.as_str() == "external" && !port_open(LLAMA_PORT) {
            *status = "dead".into();
        }
    }
    let current = state.status.lock().unwrap().clone();
    match current.as_str() {
        "starting" | "spawned" | "external" => current,
        _ => {
            // Reap a dead child if one is still stored, then respawn.
            if let Some(mut old) = state.child.lock().unwrap().take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            *state.status.lock().unwrap() = "starting".into();
            let handle = app.clone();
            std::thread::spawn(move || init_llama_server::<TranslationState>(handle));
            "starting".into()
        }
    }
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

// ---------------------------------------------------------------------------
// «Спросить»: headless Claude Code CLI (claude.exe -p, stream-json over stdin)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct AskInner {
    /// The running claude.exe child, if an ask is in flight.
    child: Option<Child>,
    /// Generation counter: lets a finishing ask detect that its child was
    /// cancelled and a NEWER ask has already stored its own child, so the old
    /// reap never steals the new one.
    generation: u64,
}

#[derive(Default)]
struct AskState {
    inner: Mutex<AskInner>,
}

/// Resolve the Claude Code CLI binary: %USERPROFILE%\.local\bin\claude.exe
/// if present, else bare "claude.exe" (PATH lookup at spawn time).
fn claude_exe_path() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = Path::new(&profile).join(".local").join("bin").join("claude.exe");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("claude.exe")
}

/// Stable working directory for every claude.exe invocation. Claude Code
/// 2.1.220 stores sessions per working directory, so --resume must run from
/// the SAME cwd as the call that created the session: pin all calls to the
/// app data dir (stable across app restarts), falling back to the home dir.
fn ask_cwd(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(d) = app.path().app_data_dir() {
        if d.exists() {
            return Some(d);
        }
    }
    app.path().home_dir().ok()
}

/// Blocking body of ask_claude: spawn claude.exe, pipe the prompt via stdin,
/// forward every stdout NDJSON line raw to the channel, then reap. If the
/// process dies without emitting a result line, a synthetic result line is
/// appended so the frontend always sees a terminal event.
fn run_ask(
    app: tauri::AppHandle,
    prompt: String,
    session_id: Option<String>,
    system_prompt: Option<String>,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let state = app.state::<AskState>();

    // Spawn under the lock: busy-check + store are atomic w.r.t. cancel.
    let (my_gen, stdin, stdout, stderr) = {
        let mut inner = state.inner.lock().unwrap();
        if let Some(c) = inner.child.as_mut() {
            match c.try_wait() {
                Ok(Some(_)) => {
                    // Stale dead child (should not normally happen): reap it.
                    if let Some(mut old) = inner.child.take() {
                        let _ = old.wait();
                    }
                }
                _ => return Err("busy: an ask is already running".into()),
            }
        }

        let exe = claude_exe_path();
        let mut cmd = Command::new(&exe);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages")
            .arg("--allowedTools")
            .arg("");
        if let Some(sp) = system_prompt.as_deref() {
            if !sp.is_empty() {
                cmd.arg("--append-system-prompt").arg(sp);
            }
        }
        if let Some(sid) = session_id.as_deref() {
            if !sid.is_empty() {
                cmd.arg("--resume").arg(sid);
            }
        }
        if let Some(dir) = ask_cwd(&app) {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("claude_not_found: {}", exe.display())
            } else {
                format!("spawn_failed: {e}")
            }
        })?;
        eprintln!("[ask] spawned claude.exe pid {}", child.id());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        inner.generation += 1;
        let my_gen = inner.generation;
        inner.child = Some(child);
        (my_gen, stdin, stdout, stderr)
    };

    // Write the prompt on its own thread (avoids pipe deadlock on large
    // prompts), then close stdin so claude.exe starts the turn.
    if let Some(mut si) = stdin {
        std::thread::spawn(move || {
            let _ = si.write_all(prompt.as_bytes());
            // drop closes the pipe
        });
    }

    // Drain stderr concurrently so a chatty stderr can never block the child.
    let stderr_thread = stderr.map(|mut se| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = se.read_to_string(&mut buf);
            buf
        })
    });

    // Forward stdout NDJSON lines raw; remember whether a result line passed.
    let mut saw_result = false;
    if let Some(so) = stdout {
        for line in BufReader::new(so).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if !saw_result {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                        saw_result = true;
                    }
                }
            }
            let _ = on_event.send(line);
        }
    }

    // Reap: only take the child if it is still OURS (same generation).
    let taken = {
        let mut inner = state.inner.lock().unwrap();
        if inner.generation == my_gen {
            inner.child.take()
        } else {
            None
        }
    };
    let (cancelled, exit_desc) = match taken {
        Some(mut child) => match child.wait() {
            Ok(st) if st.success() => (false, String::new()),
            Ok(st) => (false, format!("{st}")),
            Err(e) => (false, format!("wait failed: {e}")),
        },
        None => (true, "cancelled".into()),
    };
    let stderr_text = stderr_thread
        .and_then(|t| t.join().ok())
        .unwrap_or_default();

    if !saw_result {
        // Synthesize a terminal result line so the frontend always settles.
        let (subtype, msg) = if cancelled {
            ("cancelled".to_string(), "Запрос отменён".to_string())
        } else {
            let tail: String = {
                let t = stderr_text.trim();
                let chars: Vec<char> = t.chars().collect();
                if chars.len() > 600 {
                    chars[chars.len() - 600..].iter().collect()
                } else {
                    t.to_string()
                }
            };
            let msg = if tail.is_empty() {
                format!("claude.exe завершился без ответа ({exit_desc})")
            } else {
                format!("claude.exe завершился без ответа ({exit_desc}): {tail}")
            };
            ("error_process".to_string(), msg)
        };
        let synth = serde_json::json!({
            "type": "result",
            "subtype": subtype,
            "is_error": true,
            "result": msg,
            "synthetic": true,
        });
        let _ = on_event.send(synth.to_string());
    } else if !exit_desc.is_empty() && !cancelled {
        eprintln!("[ask] claude.exe non-zero exit after result line: {exit_desc}");
    }
    Ok(())
}

/// Ask Claude (headless CLI) with streaming NDJSON forwarded over `on_event`.
/// Resolves when the process exits (every stream already got a terminal
/// result line by then). Errors: "busy: ...", "claude_not_found: <path>",
/// "spawn_failed: <err>".
#[tauri::command]
async fn ask_claude(
    app: tauri::AppHandle,
    prompt: String,
    session_id: Option<String>,
    system_prompt: Option<String>,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_ask(app, prompt, session_id, system_prompt, on_event)
    })
    .await
    .map_err(|e| format!("ask task failed: {e}"))?
}

/// Kill the in-flight claude.exe, if any. The streaming ask_claude call then
/// finishes with a synthetic {"type":"result","subtype":"cancelled"} line.
#[tauri::command]
fn ask_claude_cancel(state: tauri::State<'_, AskState>) {
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[ask] cancel -> killing claude.exe pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn kill_ask_child(app: &tauri::AppHandle) {
    let state = app.state::<AskState>();
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[ask] app exit -> killing claude.exe pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
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

// ---------------------------------------------------------------------------
// Model weights download: HF resolve URLs, HTTP Range resume, sha256 verify.
// One slot per model key ("main" | "aux"). The <file>.part next to the final
// path survives cancel, app restart and network loss — the next call continues
// from the byte where the previous one stopped, then the finished file is
// hash-checked and renamed into place atomically.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct ModelSpec {
    file: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

/// size + sha256 pinned from the HF API (lfs.oid), cross-checked against the
/// known-good local weights on 2026-08-17.
fn model_spec(key: &str) -> Option<ModelSpec> {
    match key {
        "main" => Some(ModelSpec {
            file: TranslationState::MODEL_FILE,
            url: "https://huggingface.co/tencent/HY-MT1.5-7B-GGUF/resolve/main/HY-MT1.5-7B-Q4_K_M.gguf",
            size: 4_624_649_312,
            sha256: "fc87637e4dd29547811a28170770c2ac17725fb7690b7c4aafa4f463c3e77568",
        }),
        "aux" => Some(ModelSpec {
            file: AuxState::MODEL_FILE,
            url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
            size: 2_740_937_888,
            sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        }),
        _ => None,
    }
}

#[derive(Clone, serde::Serialize)]
struct DlEvent {
    /// "idle" | "running" | "verifying" | "done" | "cancelled" | "error"
    status: String,
    received: u64,
    total: u64,
    bps: u64,
    /// machine-readable: "no_space:<missing bytes>" | "http:<status>" | "io:<detail>" | "checksum"
    error: Option<String>,
}

struct DlSlot {
    running: bool,
    cancel: Arc<AtomicBool>,
    /// latest subscriber wins — a reloaded webview re-attaches by calling
    /// download_model again, which replaces this channel
    chan: Option<Channel<DlEvent>>,
    last: DlEvent,
}

#[derive(Default)]
struct DownloadsState {
    slots: Mutex<HashMap<String, DlSlot>>,
}

fn dl_emit(app: &tauri::AppHandle, key: &str, ev: DlEvent) {
    let state = app.state::<DownloadsState>();
    let ch = {
        let mut slots = state.slots.lock().unwrap();
        match slots.get_mut(key) {
            Some(slot) => {
                slot.last = ev.clone();
                slot.chan.clone()
            }
            None => None,
        }
    };
    if let Some(ch) = ch {
        let _ = ch.send(ev);
    }
}

/// Free bytes available on the volume holding `dir` (which must exist).
/// None = unknown (non-Windows or API failure) — the space check is skipped.
#[cfg(windows)]
fn free_disk_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut avail: u64 = 0;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut avail,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(avail)
}

#[cfg(not(windows))]
fn free_disk_space(_dir: &Path) -> Option<u64> {
    None
}

fn resolve_location(base: &str, loc: &str) -> String {
    if loc.starts_with("http://") || loc.starts_with("https://") {
        return loc.to_string();
    }
    let origin_end = base
        .find("://")
        .map(|i| i + 3)
        .and_then(|i| base[i..].find('/').map(|j| i + j))
        .unwrap_or(base.len());
    if loc.starts_with('/') {
        format!("{}{}", &base[..origin_end], loc)
    } else {
        match base.rfind('/') {
            Some(i) if i > origin_end => format!("{}/{}", &base[..i], loc),
            _ => format!("{}/{}", &base[..origin_end], loc),
        }
    }
}

/// GET with an explicit Range header, following redirects MANUALLY so the
/// Range is guaranteed to reach the final CDN host (HF resolve → 302 → CDN;
/// automatic redirect handling is allowed to drop request headers).
fn http_get_ranged(agent: &ureq::Agent, url: &str, offset: u64) -> Result<ureq::Response, String> {
    let mut cur = url.to_string();
    for _ in 0..8 {
        let mut req = agent.get(&cur);
        if offset > 0 {
            req = req.set("Range", &format!("bytes={offset}-"));
        }
        let resp = match req.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r, // caller inspects the status
            Err(e) => return Err(format!("io:{e}")),
        };
        match resp.status() {
            301 | 302 | 303 | 307 | 308 => match resp.header("Location") {
                Some(loc) => cur = resolve_location(&cur, loc),
                None => return Err(format!("http:{}", resp.status())),
            },
            _ => return Ok(resp),
        }
    }
    Err("http:too_many_redirects".into())
}

enum DlOutcome {
    Done,
    Cancelled,
}

/// headroom beyond the missing bytes for the free-space check
const DL_MARGIN: u64 = 300 * 1024 * 1024;

fn do_download(
    app: &tauri::AppHandle,
    key: &str,
    dir: &Path,
    spec: &ModelSpec,
    cancel: &AtomicBool,
) -> Result<DlOutcome, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("io:{e}"))?;
    let final_path = dir.join(spec.file);
    if final_path.exists() {
        return Ok(DlOutcome::Done); // already installed — nothing to do
    }
    let part_path = dir.join(format!("{}.part", spec.file));
    let mut offset = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if offset > spec.size {
        // partial of some other upstream file — start over
        std::fs::remove_file(&part_path).map_err(|e| format!("io:{e}"))?;
        offset = 0;
    }

    if offset < spec.size {
        if let Some(free) = free_disk_space(dir) {
            let need = spec.size - offset + DL_MARGIN;
            if free < need {
                return Err(format!("no_space:{}", need - free));
            }
        }
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(Duration::from_secs(20))
            .timeout_read(Duration::from_secs(40))
            .build();
        if offset > 0 {
            eprintln!("[dl:{key}] resuming from byte {offset}");
        }
        let mut resp = http_get_ranged(&agent, spec.url, offset)?;
        match resp.status() {
            206 => {}
            200 => offset = 0, // server ignored the Range — full body follows
            416 => {
                // server refuses our offset (upstream changed?) — restart clean
                std::fs::remove_file(&part_path).map_err(|e| format!("io:{e}"))?;
                offset = 0;
                resp = http_get_ranged(&agent, spec.url, 0)?;
                if resp.status() != 200 {
                    return Err(format!("http:{}", resp.status()));
                }
            }
            s => return Err(format!("http:{s}")),
        }
        let mut file = if offset > 0 {
            OpenOptions::new().append(true).open(&part_path)
        } else {
            OpenOptions::new().write(true).create(true).truncate(true).open(&part_path)
        }
        .map_err(|e| format!("io:{e}"))?;
        let mut reader = resp.into_reader();
        let mut received = offset;
        let mut buf = vec![0u8; 256 * 1024];
        let mut last_emit = Instant::now();
        let mut last_bytes = received;
        dl_emit(app, key, DlEvent { status: "running".into(), received, total: spec.size, bps: 0, error: None });
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(DlOutcome::Cancelled); // .part stays for resume
            }
            let n = reader.read(&mut buf).map_err(|e| format!("io:{e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("io:{e}"))?;
            received += n as u64;
            if received > spec.size {
                return Err("io:body longer than expected".into());
            }
            let dt = last_emit.elapsed();
            if dt >= Duration::from_millis(300) {
                let bps = ((received - last_bytes) as f64 / dt.as_secs_f64()) as u64;
                dl_emit(app, key, DlEvent { status: "running".into(), received, total: spec.size, bps, error: None });
                last_emit = Instant::now();
                last_bytes = received;
            }
        }
        file.flush().map_err(|e| format!("io:{e}"))?;
        drop(file);
        if received != spec.size {
            return Err(format!("io:connection closed at {received} of {}", spec.size));
        }
    }

    // integrity: full sha256 of the .part against the HF-published oid
    dl_emit(app, key, DlEvent { status: "verifying".into(), received: spec.size, total: spec.size, bps: 0, error: None });
    let mut f = File::open(&part_path).map_err(|e| format!("io:{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(DlOutcome::Cancelled);
        }
        let n = f.read(&mut buf).map_err(|e| format!("io:{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if hex != spec.sha256 {
        std::fs::remove_file(&part_path).ok(); // poisoned bytes — never resume from them
        return Err("checksum".into());
    }
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("io:{e}"))?;
    Ok(DlOutcome::Done)
}

fn run_model_download(app: tauri::AppHandle, key: String, dir: PathBuf, spec: ModelSpec, cancel: Arc<AtomicBool>) {
    eprintln!("[dl:{key}] starting into {}", dir.display());
    let res = do_download(&app, &key, &dir, &spec, &cancel);
    let part_len = || {
        std::fs::metadata(dir.join(format!("{}.part", spec.file)))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    let ev = match &res {
        Ok(DlOutcome::Done) => {
            eprintln!("[dl:{key}] done -> {}", dir.join(spec.file).display());
            DlEvent { status: "done".into(), received: spec.size, total: spec.size, bps: 0, error: None }
        }
        Ok(DlOutcome::Cancelled) => {
            let received = part_len();
            eprintln!("[dl:{key}] cancelled at {received} of {}", spec.size);
            DlEvent { status: "cancelled".into(), received, total: spec.size, bps: 0, error: None }
        }
        Err(e) => {
            let received = part_len();
            eprintln!("[dl:{key}] error at {received}: {e}");
            DlEvent { status: "error".into(), received, total: spec.size, bps: 0, error: Some(e.clone()) }
        }
    };
    let state = app.state::<DownloadsState>();
    let ch = {
        let mut slots = state.slots.lock().unwrap();
        match slots.get_mut(&key) {
            Some(slot) => {
                slot.running = false;
                slot.last = ev.clone();
                slot.chan.clone()
            }
            None => None,
        }
    };
    if let Some(ch) = ch {
        let _ = ch.send(ev);
    }
}

fn resolve_models_dir(app: &tauri::AppHandle, dest_dir: Option<String>) -> Result<PathBuf, String> {
    // dev-build-only escape hatch: tests download into a TEMP dir and can
    // never touch the real models directory; release builds ignore the param
    if cfg!(debug_assertions) {
        if let Some(d) = dest_dir {
            if !d.is_empty() {
                return Ok(PathBuf::from(d));
            }
        }
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("models"))
        .map_err(|e| format!("no app data dir: {e}"))
}

/// Start (or attach to) the resumable download of a model's weights. The
/// channel immediately receives the current snapshot, then live progress.
/// Calling while a download is in flight only re-subscribes the channel
/// (that's how a reloaded webview picks a running download back up).
#[tauri::command]
fn download_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadsState>,
    model: String,
    dest_dir: Option<String>,
    on_event: Channel<DlEvent>,
) -> Result<(), String> {
    let spec = model_spec(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let dir = resolve_models_dir(&app, dest_dir)?;
    let mut slots = state.slots.lock().unwrap();
    let slot = slots.entry(model.clone()).or_insert_with(|| DlSlot {
        running: false,
        cancel: Arc::new(AtomicBool::new(false)),
        chan: None,
        last: DlEvent { status: "idle".into(), received: 0, total: spec.size, bps: 0, error: None },
    });
    let _ = on_event.send(slot.last.clone());
    slot.chan = Some(on_event);
    if slot.running {
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    slot.cancel = cancel.clone();
    slot.running = true;
    drop(slots);
    std::thread::spawn({
        let app = app.clone();
        move || run_model_download(app, model, dir, spec, cancel)
    });
    Ok(())
}

/// Ask a running download to stop after the current chunk. The .part file is
/// kept — the next download_model call resumes from it.
#[tauri::command]
fn cancel_model_download(state: tauri::State<'_, DownloadsState>, model: String) {
    if let Some(slot) = state.slots.lock().unwrap().get_mut(&model) {
        slot.cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(serde::Serialize)]
struct DlStatus {
    running: bool,
    file_ready: bool,
    received: u64,
    total: u64,
}

/// Snapshot for surfaces that (re)open without a live channel: is the final
/// file on disk, is a download in flight, how many bytes are already local.
#[tauri::command]
fn model_download_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, DownloadsState>,
    model: String,
    dest_dir: Option<String>,
) -> Result<DlStatus, String> {
    let spec = model_spec(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let dir = resolve_models_dir(&app, dest_dir)?;
    let file_ready = dir.join(spec.file).exists();
    let (running, live) = state
        .slots
        .lock()
        .unwrap()
        .get(&model)
        .map(|s| (s.running, s.last.received))
        .unwrap_or((false, 0));
    let received = if running {
        live
    } else if file_ready {
        spec.size
    } else {
        std::fs::metadata(dir.join(format!("{}.part", spec.file)))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    Ok(DlStatus { running, file_ready, received, total: spec.size })
}

/// Delete a model's weights from disk (Settings → Модели). Frees the mmap
/// lock first by killing the llama-server WE spawned for that model; an
/// external instance (user-run, on the same port) is never touched — if it
/// happens to hold this very file, the remove below fails and the error
/// surfaces honestly. The .part of an interrupted download is removed too.
/// Refused while a download for the model is in flight.
#[tauri::command]
fn delete_model(
    app: tauri::AppHandle,
    dls: tauri::State<'_, DownloadsState>,
    model: String,
    dest_dir: Option<String>,
) -> Result<(), String> {
    let spec = model_spec(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    if dls
        .slots
        .lock()
        .unwrap()
        .get(&model)
        .map(|s| s.running)
        .unwrap_or(false)
    {
        return Err("busy: download in progress".into());
    }
    let dir = resolve_models_dir(&app, dest_dir)?;

    fn stop_spawned<S: LlamaSrv>(app: &tauri::AppHandle) {
        let state = app.state::<S>();
        let taken = state.child().lock().unwrap().take();
        if let Some(mut child) = taken {
            eprintln!(
                "[{}] delete_model -> killing spawned llama-server pid {}",
                S::LABEL,
                child.id()
            );
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut status = state.status().lock().unwrap();
        if status.as_str() != "external" {
            *status = "none".into();
        }
    }
    match model.as_str() {
        "main" => stop_spawned::<TranslationState>(&app),
        _ => stop_spawned::<AuxState>(&app),
    }

    let _ = std::fs::remove_file(dir.join(format!("{}.part", spec.file)));
    let final_path = dir.join(spec.file);
    if final_path.exists() {
        std::fs::remove_file(&final_path).map_err(|e| format!("io:{e}"))?;
        eprintln!("[dl:{model}] deleted {}", final_path.display());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// PDF export: print a local HTML file to PDF through WebView2's PrintToPdf.
//
// Flow: a hidden WebviewWindow navigates to file://<html_path>; once the page
// (including its data-URI images) fires the load event, PrintToPdf renders it
// to <pdf_path> silently — no print dialog, no visible window. The command
// resolves when the COM completion handler reports the outcome.
//
// Threading: WebView2 is single-threaded (STA on the app's main/UI thread).
// The command runs async on the tokio pool, so the main thread stays free to
// pump Windows messages — that pump is exactly what delivers both the
// with_webview closure and the PrintToPdf completion callback. We therefore
// do NOT need webview2_com::wait_with_pump (that is for apps whose UI thread
// blocks before an event loop exists); plain mpsc channels + recv_timeout on
// a blocking-pool thread are enough and cannot deadlock the UI.
//
// Teardown: the hidden window is destroyed on every exit path (success,
// setup error, COM error, timeout) — `drive_print` is the only thing between
// window creation and the unconditional destroy() below it. If a timeout
// fires while PrintToPdf is still running, destroying the window tears down
// the WebView2 controller, which cancels the print job; a completion callback
// that races the teardown sends into a dropped Receiver and is ignored.

/// JS contract: invoke("print_html_to_pdf", { htmlPath, pdfPath,
///   pageWidthMm?, pageHeightMm?, marginMm? })
/// Defaults: A4 portrait (210×297 mm), 12 mm margins on all sides, scale 1.0,
/// backgrounds printed, no browser headers/footers. Both paths must be
/// absolute; the output directory is created if missing.
#[cfg(windows)]
#[tauri::command]
async fn print_html_to_pdf(
    app: tauri::AppHandle,
    html_path: String,
    pdf_path: String,
    page_width_mm: Option<f64>,
    page_height_mm: Option<f64>,
    margin_mm: Option<f64>,
) -> Result<(), String> {
    let html = PathBuf::from(&html_path);
    if !html.is_file() {
        return Err(format!("html file not found: {html_path}"));
    }
    let url = tauri::Url::from_file_path(&html)
        .map_err(|_| format!("cannot build a file:// url from {html_path} (must be absolute)"))?;
    if !Path::new(&pdf_path).is_absolute() {
        return Err("pdf_path must be absolute".into());
    }
    if let Some(parent) = Path::new(&pdf_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
        }
    }

    const MM_PER_INCH: f64 = 25.4;
    let page_w_in = page_width_mm.unwrap_or(210.0) / MM_PER_INCH;
    let page_h_in = page_height_mm.unwrap_or(297.0) / MM_PER_INCH;
    let margin_in = margin_mm.unwrap_or(12.0) / MM_PER_INCH;

    // Unique label per call: a lagging teardown of a previous export can never
    // collide with (and thus fail) the next one.
    static PRINT_SEQ: AtomicU64 = AtomicU64::new(0);
    let label = format!("pdf-print-{}", PRINT_SEQ.fetch_add(1, Ordering::Relaxed));

    let (load_tx, load_rx) = std::sync::mpsc::channel::<()>();
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title("Экспорт в PDF")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(900.0, 1200.0)
        .on_page_load(move |_win, payload| {
            // Finished == wry's NavigationCompleted == the document's load
            // event, which waits for <img> decoding incl. data: URIs.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = load_tx.send(());
            }
        })
        .build()
        .map_err(|e| format!("failed to create hidden print window: {e}"))?;

    // From here the hidden window exists: whatever happens, destroy it.
    let result = drive_print(&window, &pdf_path, page_w_in, page_h_in, margin_in, load_rx).await;
    let _ = window.destroy();
    result
}

#[cfg(not(windows))]
#[tauri::command]
async fn print_html_to_pdf(
    _app: tauri::AppHandle,
    _html_path: String,
    _pdf_path: String,
    _page_width_mm: Option<f64>,
    _page_height_mm: Option<f64>,
    _margin_mm: Option<f64>,
) -> Result<(), String> {
    Err("PDF export via WebView2 is only available on Windows".into())
}

/// Everything between window creation and teardown, so the caller can
/// unconditionally destroy() no matter where this errors out.
#[cfg(windows)]
async fn drive_print(
    window: &tauri::WebviewWindow,
    pdf_path: &str,
    page_w_in: f64,
    page_h_in: f64,
    margin_in: f64,
    load_rx: std::sync::mpsc::Receiver<()>,
) -> Result<(), String> {
    // Big books arrive as one HTML file with many MB of data-URI images;
    // parsing + decoding can be slow, hence the generous load budget.
    recv_off_thread(load_rx, 120, "page load in the hidden print window").await?;

    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let pdf = pdf_path.to_string();
    window
        .with_webview(move |wv| {
            // Runs on the UI thread. Synchronous COM failures are reported
            // through the same channel the completion handler uses.
            if let Err(e) =
                start_print_to_pdf(&wv, &pdf, page_w_in, page_h_in, margin_in, done_tx.clone())
            {
                let _ = done_tx.send(Err(e));
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    recv_off_thread(done_rx, 600, "PrintToPdf completion").await??;

    if !Path::new(pdf_path).is_file() {
        return Err("PrintToPdf reported success but no file appeared".into());
    }
    Ok(())
}

/// Wait for a channel message on the blocking pool so neither the async
/// runtime nor the main thread stalls — the main thread must keep pumping
/// Windows messages, because that is what delivers WebView2's callbacks.
#[cfg(windows)]
async fn recv_off_thread<T: Send + 'static>(
    rx: std::sync::mpsc::Receiver<T>,
    secs: u64,
    what: &'static str,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(secs)).map_err(|e| match e {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                format!("timeout ({secs}s) waiting for {what}")
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                format!("hidden print window died while waiting for {what}")
            }
        })
    })
    .await
    .map_err(|e| format!("blocking task join: {e}"))?
}

/// UI-thread half: configure ICoreWebView2PrintSettings and kick off
/// PrintToPdf. The completion handler (invoked later, also on the UI thread,
/// via the app's normal message loop) reports the outcome through `done`.
#[cfg(windows)]
fn start_print_to_pdf(
    wv: &tauri::webview::PlatformWebview,
    pdf_path: &str,
    page_w_in: f64,
    page_h_in: f64,
    margin_in: f64,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, PCWSTR};

    let core = unsafe { wv.controller().CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;
    let wv7: ICoreWebView2_7 = core
        .cast()
        .map_err(|e| format!("WebView2 runtime too old for PrintToPdf (needs ICoreWebView2_7): {e}"))?;
    let env6: ICoreWebView2Environment6 = wv
        .environment()
        .cast()
        .map_err(|e| format!("WebView2 runtime too old (needs ICoreWebView2Environment6): {e}"))?;

    let settings =
        unsafe { env6.CreatePrintSettings() }.map_err(|e| format!("CreatePrintSettings: {e}"))?;
    unsafe {
        settings
            .SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)
            .and_then(|_| settings.SetScaleFactor(1.0))
            .and_then(|_| settings.SetPageWidth(page_w_in))
            .and_then(|_| settings.SetPageHeight(page_h_in))
            .and_then(|_| settings.SetMarginTop(margin_in))
            .and_then(|_| settings.SetMarginBottom(margin_in))
            .and_then(|_| settings.SetMarginLeft(margin_in))
            .and_then(|_| settings.SetMarginRight(margin_in))
            .and_then(|_| settings.SetShouldPrintBackgrounds(true))
            .and_then(|_| settings.SetShouldPrintSelectionOnly(false))
            .and_then(|_| settings.SetShouldPrintHeaderAndFooter(false))
            .map_err(|e| format!("print settings: {e}"))?;
    }

    let handler = PrintToPdfCompletedHandler::create(Box::new(
        move |result: windows_core::Result<()>, is_success: bool| {
            let outcome = match result {
                Err(e) => Err(format!("PrintToPdf failed: {e}")),
                Ok(()) if !is_success => Err(
                    "PrintToPdf reported failure (target file locked, or path invalid?)".into(),
                ),
                Ok(()) => Ok(()),
            };
            let _ = done.send(outcome);
            Ok(())
        },
    ));

    // UTF-16 buffer only needs to outlive the synchronous call below:
    // WebView2 copies the string before PrintToPdf returns.
    let path_w: Vec<u16> = pdf_path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { wv7.PrintToPdf(PCWSTR::from_raw(path_w.as_ptr()), &settings, &handler) }
        .map_err(|e| format!("PrintToPdf call: {e}"))
}

/// Kill only the children we spawned ourselves. An llama-server we merely
/// *reused* (external instance, already listening when we started) is not in
/// state.child and is deliberately left running. Idempotent: every kill takes
/// its child out of the state first, so calling this twice is a no-op.
fn kill_children(app: &tauri::AppHandle) {
    kill_spawned::<TranslationState>(app);
    kill_spawned::<AuxState>(app);
    kill_ask_child(app);
}

/// Why the titlebar X cannot be left to Tauri's default path.
///
/// The frontend registers `onCloseRequested` (App.tsx) to flush the reading
/// position. That one listener changes who owns the close: tauri's core
/// (manager/window.rs `on_window_event`) sees a JS listener for
/// `tauri://close-requested`, calls `api.prevent_close()`, and from then on the
/// window only ever goes away when the JS wrapper reaches its
/// `await this.destroy()`. Two independent defects were measured on that route
/// (release build, WM_CLOSE posted to the main window):
///
///  1. `core:window:allow-destroy` was not granted — it is NOT part of
///     `core:window:default`, so the ACL answered destroy() with
///     "Command plugin:window|destroy not allowed by ACL". The rejection landed
///     in the api wrapper's own promise where nothing reports it, the window
///     never got a Destroyed event and the app stayed up indefinitely: the X
///     did literally nothing. Granting the permission alone fixed that run
///     (still alive after 15s -> exits in 1.25s), which is what pins this as
///     the root cause of «крестик не работает».
///  2. Even with destroy() working, it closes only the *main* window. With a
///     PDF export in flight the hidden `pdf-print-N` window survives, so the
///     window vanishes but pdfer.exe (and the llama-server it owns) linger with
///     nothing on screen — measured at 20s+ before the run was killed.
///
/// A busy webview is a third way to strand the same route: the JS handler
/// cannot run at all while the renderer is blocked.
///
/// So the X is owned here instead. Hide at once (the close looks instant), give
/// the frontend a short grace period to persist its position, then exit the app
/// — not just the window — whatever the webview is doing. If even the event
/// loop cannot service that exit, reap our children directly and leave, so no
/// orphan pdfer.exe / llama-server.exe survives. destroy() stays permitted as
/// the fast path: when the webview is responsive it wins the race and the
/// process is gone in well under the grace period.
fn own_shutdown(window: &tauri::Window) {
    /// Long enough for the webview to deliver the event and write localStorage,
    /// short enough that the app is gone before the user looks twice.
    const FLUSH_GRACE: Duration = Duration::from_millis(400);
    /// If RunEvent::Exit has not landed by then, the event loop is wedged.
    const HARD_DEADLINE: Duration = Duration::from_millis(2000);

    static CLOSING: AtomicBool = AtomicBool::new(false);
    if CLOSING.swap(true, Ordering::SeqCst) {
        return; // impatient second click on the X — one shutdown is enough
    }

    eprintln!("[exit] close requested -> hiding window, exiting in {FLUSH_GRACE:?}");
    let _ = window.hide();
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_GRACE);
        app.exit(0);
        std::thread::sleep(HARD_DEADLINE);
        eprintln!("[exit] graceful exit did not complete -> forcing");
        kill_children(&app);
        std::process::exit(0);
    });
}

/// Drop `pdf-export-*.html` files that no export can still be using.
///
/// exportTranslationPdf (src/export.ts) writes the print source into appData
/// and removes it in a `finally`. That `finally` cannot run when the X closes
/// the app mid-export — own_shutdown exits the process, by design — so every
/// interrupted export used to strand its temp file forever. Measured on the
/// release build: one interrupted export of an 838-page book left a 137 MB
/// pdf-export-1787082279628.html behind, in *roaming* appData.
///
/// Age guard, not a blanket wipe: a second instance starting while this one is
/// mid-export must not delete the file the export is reading. A live export's
/// temp is seconds old; anything older than an hour belongs to a dead process.
fn sweep_stale_export_temps(app: &tauri::AppHandle) {
    const MAX_AGE: Duration = Duration::from_secs(60 * 60);
    let Ok(dir) = app.path().app_data_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("pdf-export-") && name.ends_with(".html")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|age| age > MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            match std::fs::remove_file(entry.path()) {
                Ok(()) => eprintln!("[export] swept stale temp {name}"),
                Err(e) => eprintln!("[export] cannot sweep {name}: {e}"),
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(TranslationState::default())
        .manage(AuxState::default())
        .manage(AskState::default())
        .manage(DownloadsState::default())
        .invoke_handler(tauri::generate_handler![
            translation_status,
            restart_translation,
            aux_model_start,
            aux_model_stop,
            aux_model_status,
            download_model,
            cancel_model_download,
            model_download_status,
            delete_model,
            ask_claude,
            ask_claude_cancel,
            print_html_to_pdf
        ])
        .setup(|app| {
            sweep_stale_export_temps(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || init_llama_server::<TranslationState>(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                own_shutdown(window);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_children(app_handle);
            }
        });
}
