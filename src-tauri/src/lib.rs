use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::Manager;

mod platform;
mod print;

const LLAMA_PORT: u16 = 11544;
const AUX_PORT: u16 = 11545;

/// Common shape of a managed llama-server instance so the spawn/poll logic is
/// shared between the main translator (11544) and the aux model (11545).
trait LlamaSrv: Send + Sync + 'static {
    const LABEL: &'static str;
    const PORT: u16;
    /// Concurrent decode slots (`--parallel N`).
    ///
    /// The spawn used to pass no `--parallel` at all, so both servers ran on
    /// llama-server's default of 4 slots while translate.ts kept 3 requests in
    /// flight — the largest throughput lever in the app, left on the floor.
    /// Decode is weight-bandwidth-bound: N sequences read the same weights
    /// once and share them, so the extra sequences are nearly free until the
    /// card runs out of arithmetic. Measured on this machine with
    /// `llama-batched-bench -m HY-MT1.5-7B-Q4_K_M.gguf -ngl 99 -fa on -c 32768
    /// -npp 512 -ntg 256 -npl 1,2,4,8,16` on the RTX 5080: 142.57 t/s at one
    /// sequence, 265.73 at 2 (1.86x), 460.06 at 4 (3.23x), 769.35 at 8
    /// (5.40x), 1298.87 at 16 (9.11x). It costs nothing in quality — the slots
    /// are independent sequences and each one's output is identical to running
    /// it alone.
    const PARALLEL: u32;
    /// Context per slot, in tokens. `-c` is PARALLEL x this and never the
    /// per-slot figure on its own, because llama-server DIVIDES `-c` by the
    /// slot count. Measured on this machine, the server's own startup line for
    /// `--parallel 8 -c 24576 -fa on`, verbatim:
    ///
    ///   srv load_model: initializing, n_slots = 8, n_ctx_slot = 3072, kv_unified = 'false'
    ///
    /// so a `-c` sized for ONE request hands every slot an Nth of it and
    /// evicts a slot mid-generation.
    ///
    /// The multiplication is unchanged; the reason given for it was wrong and
    /// is corrected here. An earlier comment justified it with «`kv_unified =
    /// true` makes `-c` one arena every slot draws from». It is not true for
    /// these spawns: this build's `--help` says unified KV is "default:
    /// enabled if number of slots is auto", and the spawn now passes an
    /// explicit `--parallel`, so the server prints `kv_unified = 'false'`.
    /// Rest the reasoning on `n_ctx_slot` instead — that is the number
    /// llama-server actually prints, and `-c / --parallel` is how it gets it.
    ///
    /// `n_ctx_slot` is the budget for a WHOLE request: the prompt AND the
    /// tokens generated for it, in the same cells. Everything in translate.ts
    /// that clips a prompt or caps n_predict is priced against this number
    /// (llama_slots exports it), and it is their SUM that has to fit — an
    /// n_predict ceiling equal to the whole slot leaves nothing for the
    /// prompt, which for the draft pass is a paragraph plus the previous
    /// source paragraph, the previous target paragraph and the glossary block.
    const CTX_PER_SLOT: u32;
    const MODEL_FILE: &'static str;
    /// Status string used once the port answers ("spawned" for the main server
    /// to keep the existing frontend contract, "up" for aux).
    const UP: &'static str;
    /// Status string for a child that STARTED and then exited on its own —
    /// almost always a refused allocation or a corrupt file, never a missing
    /// one. Defaults to "dead" so the main server keeps the exact status set
    /// the shipped model screens already handle (ModelSetup.tsx:25), and only
    /// the aux server — whose surfaces are being rewritten in this same
    /// release — gets the finer word. `llama_log` carries the detail either
    /// way, so the main screen loses nothing.
    const CRASHED: &'static str = "dead";
    /// How many 500 ms polls to wait for the port to answer. 240 (= 120 s) was
    /// measured as ample for a 4.6 GB dense model; a 14.2 GB MoE faulted in
    /// from a cold page cache is a different proposition, so AuxState raises
    /// it. A false «dead» is expensive: the frontend takes it as «no weights»
    /// and silently skips the pass.
    const BOOT_POLLS: u32 = 240;
    /// Free VRAM (MiB) below which this model must not be given the GPU at all.
    ///
    /// This is a FALLBACK floor, used only when the GGUF header could not be
    /// read and `plan_spawn` therefore cannot compute a real layer budget.
    /// It is a working set — weights + KV + the compute buffer + headroom —
    /// not the file size: a card that fits the weights and nothing else OOMs
    /// during the first allocation, which is exactly what this exists to stop.
    const MIN_VRAM_MIB: u64;
    /// Total physical RAM (MiB) below which this model must not be spawned at
    /// all. 0 = no requirement. See AuxState::MIN_RAM_MIB for why the aux
    /// server has one and the draft server does not.
    const MIN_RAM_MIB: u64 = 0;
    /// Whether this model is a mixture of experts at all.
    ///
    /// It used to read EXPERTS_ON_CPU and meant «this model's experts always
    /// live in system RAM», which was the co-residency assumption written into
    /// a constant. Where the experts actually go is now a decision, taken per
    /// spawn against the free VRAM measured with the other server stopped
    /// (moe_plan), and this flag only says whether that decision has to be
    /// taken. It survives as a const because it is also the ONLY thing left to
    /// go on when the GGUF header cannot be read: `-ncmoe N` needs a layer
    /// count the header would have supplied, so an unparseable file falls back
    /// to `--cpu-moe`, which fits whenever anything fits.
    const MOE: bool = false;
    /// The `-c` this server is spawned with: the total the server then cuts
    /// into PARALLEL slots of CTX_PER_SLOT each (`n_ctx_slot` in its own log).
    fn ctx() -> u32 {
        Self::PARALLEL.max(1) * Self::CTX_PER_SLOT
    }
    fn child(&self) -> &Mutex<Option<Child>>;
    fn status(&self) -> &Mutex<String>;
    /// Ring buffer of the child's own stderr. llama-server reports an OOM, a
    /// refused allocation and its whole load line there; before this existed
    /// all of it went to /dev/null and every resource failure was reported to
    /// the user as the single word "dead" — indistinguishable from «you never
    /// downloaded the weights». See drain_stderr and the `llama_log` command.
    fn log(&self) -> &Mutex<Vec<String>>;
    /// Called right after WE killed a child we spawned, so per-server state
    /// that only makes sense while the process lives can be dropped.
    fn after_kill(_app: &tauri::AppHandle) {}
    /// Is anything actively using this server right now?
    ///
    /// Only consulted by the GPU handover (swap_out): a server somebody is
    /// mid-generation against is not evicted to make room for the other one.
    /// Default false — the draft server has no lease concept and is
    /// restartable at any moment.
    fn in_use(_app: &tauri::AppHandle) -> bool {
        false
    }
    /// Stop the OTHER server before this one measures the card.
    ///
    /// The two passes cannot overlap — the style edit consumes the draft's
    /// output — so co-residency buys nothing and costs both of them the VRAM
    /// the other is holding. Implemented per server rather than as one generic
    /// body because «the other one» is a different type, not a different value.
    fn handover(_app: &tauri::AppHandle) {}
}

struct TranslationState {
    /// The llama-server child process, present ONLY if we spawned it ourselves.
    child: Mutex<Option<Child>>,
    /// "none" | "external" | "starting" | "spawned" | "swapping" | "crashed" |
    /// "dead". "swapping" is new with the sequential GPU handover: the aux
    /// server has the card. Either it asked for it and we stopped this one to
    /// give it up (swap_out), or a restart was asked for while an aux lease
    /// was held and could not be granted (restart_translation). It is NOT
    /// "dead" (nothing failed) and emphatically not "none" (the weights are on
    /// disk); restore_after_handover is what ends it.
    status: Mutex<String>,
    /// Last stderr lines of the child we spawned (see LlamaSrv::log).
    log: Mutex<Vec<String>>,
}

impl Default for TranslationState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new("starting".into()),
            log: Mutex::new(Vec::new()),
        }
    }
}

impl LlamaSrv for TranslationState {
    const LABEL: &'static str = "translation";
    const PORT: u16 = LLAMA_PORT;
    // 8 slots. The batching table on PARALLEL is measured on the draft
    // server's own workload — a book is thousands of independent paragraphs,
    // which is the one pass in this app that can actually keep 8 sequences
    // busy. 16 scales better still, but -c would then be 49152 and the KV
    // stops being affordable next to 6963 MiB of weights on a 16 GB card.
    const PARALLEL: u32 = 8;
    // 3072 per slot, so -c is 24576 and llama-server prints
    // `n_slots = 8, n_ctx_slot = 3072` — measured, see LlamaSrv::CTX_PER_SLOT
    // for the verbatim line. The old value was a flat -c 12288 sized for 3
    // in-flight requests, about 4096 each; a slot's share comes DOWN from that
    // because -c is the product, and 8 x 4096 = 32768 cells of KV is not
    // affordable beside 6963 MiB of weights on a 16 GB card (MIN_VRAM_MIB does
    // the same arithmetic). Eight slots at 3072 is the trade the batching
    // table on PARALLEL pays for.
    //
    // What 3072 has to hold is one WHOLE draft request: the paragraph, the
    // previous source paragraph, the previous target paragraph, the glossary
    // block AND the tokens generated for it. llama_slots exports this number
    // so translate.ts derives its prompt clips and its n_predict cap from it
    // rather than repeating it — but deriving is not enough on its own, the
    // caps have to SUM to no more than this.
    const CTX_PER_SLOT: u32 = 3072;
    const MODEL_FILE: &'static str = "translategemma-12b-it-Q4_K_M.gguf";
    const UP: &'static str = "spawned";
    // Fallback floor, consulted ONLY when the GGUF header could not be read
    // (plan_spawn); with a readable header the layer budget is computed from
    // the file's own geometry and can put PART of the model on a card too
    // small for all of it.
    //
    // Raised from 9000 with -c: that number was 6963 MiB of weights (the
    // pinned 7_300_793_664 B) + ~1090 MiB of KV at -c 12288 + ~512 MiB of
    // compute buffer (the 262k vocab x 512 ubatch x 4 B logits tensor) +
    // VRAM_HEADROOM_MIB. -c is now 24576 and, worse, an unreadable header
    // means the sliding-window geometry is unknown too — so the KV has to be
    // charged at swa_split's own worst case (half the layers global), about
    // 4800 MiB rather than 1856. 6963 + 4800 + 512 + 256 ≈ 12531, rounded up.
    //
    // This deliberately prefers a slow CPU spawn to a dead server on a file we
    // cannot parse. A file we CAN parse — which is every intact copy of the
    // pinned weights — never reaches this line.
    const MIN_VRAM_MIB: u64 = 12600;
    fn child(&self) -> &Mutex<Option<Child>> {
        &self.child
    }
    fn status(&self) -> &Mutex<String> {
        &self.status
    }
    fn log(&self) -> &Mutex<Vec<String>> {
        &self.log
    }
    fn handover(app: &tauri::AppHandle) {
        swap_out::<AuxState>(app, Self::LABEL);
    }
}

/// The aux server: ONE set of weights on ONE port serving three passes — the
/// Russian style edit, every glossary/terminology pass, and graphgen's local
/// calls. They are all the same instruct model, so a second port would only
/// mean a second 14.2 GB resident copy of the same file (and release CSP pins
/// exactly 11544 and 11545 anyway, tauri.conf.json:24).
struct AuxState {
    /// The aux llama-server child process, present ONLY if we spawned it ourselves.
    child: Mutex<Option<Child>>,
    /// "none" | "external" | "starting" | "up" | "swapping" | "nomem" |
    /// "crashed" | "dead". See TranslationState::status for "swapping".
    status: Mutex<String>,
    /// Last stderr lines of the child we spawned (see LlamaSrv::log).
    log: Mutex<Vec<String>>,
    /// Who currently needs these weights resident: "glossary", "graph",
    /// "style:<bookPath>". The server dies when the set empties and not
    /// before — see aux_model_stop for why the old unconditional kill had to
    /// go, and aux_lease_reset for how a reloaded webview drops its leases.
    owners: Mutex<HashSet<String>>,
}

impl Default for AuxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            // Not started on app launch: idle until aux_model_start is invoked.
            status: Mutex::new("none".into()),
            log: Mutex::new(Vec::new()),
            owners: Mutex::new(HashSet::new()),
        }
    }
}

impl LlamaSrv for AuxState {
    const LABEL: &'static str = "aux";
    const PORT: u16 = AUX_PORT;
    // 4 slots, not the draft server's 8. The batching table on PARALLEL holds
    // here too, but this model's weights nearly fill the card on their own
    // (see MIN_VRAM_MIB and moe_plan): every extra slot is 4096 more cells of
    // KV bought with expert layers pushed off the GPU, and an expert layer in
    // DDR5 costs far more than a fourth concurrent sequence gains.
    const PARALLEL: u32 = 4;
    // 4096 per slot, so -c stays at the 16384 this server was already spawned
    // with — the arithmetic behind it is unchanged, only its derivation is.
    // The style prompt's invariant block alone is ~2100 tokens (guide plus the
    // whole term list) and the same server carries the book-profile pass and
    // the term proposals, so a slot's share must hold a long paragraph on top
    // of that — and the edited paragraph coming back out, since `n_ctx_slot`
    // is prompt and generation in the same cells.
    const CTX_PER_SLOT: u32 = 4096;
    const MODEL_FILE: &'static str = "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf";
    const UP: &'static str = "up";
    // The aux server is the one whose failures are ambiguous: «not installed»
    // and «installed, but the card refused 4 GiB» used to be the same word,
    // and the frontend takes the first as «skip this pass silently».
    const CRASHED: &'static str = "crashed";
    // 300 s. 120 s is not obviously enough for 13.3 GB of MoE weights faulted
    // in from a cold page cache, and the frontend reads a false «dead» as «not
    // installed». The frontend's own deadline must stay strictly GREATER than
    // BOOT_POLLS × 500 ms, or a load finishing at 299 s is a coin flip.
    const BOOT_POLLS: u32 = 600;
    // Fallback floor only (see the trait doc). An unreadable header is the one
    // case that still falls back to --cpu-moe, so the GPU would hold the
    // non-expert tensors — 1.73 GB of this file, from Google's own config —
    // plus a 16384-token KV whose size depends on geometry we cannot know
    // without the header, plus the compute buffer. 6000 is the honest floor
    // for «we cannot measure, so do not gamble a VRAM OOM», and it is above
    // that sum with room to spare on purpose. When the header IS readable —
    // the normal case — this number is never consulted.
    const MIN_VRAM_MIB: u64 = 6000;
    // The RAM gate outlives --cpu-moe as a default (moe_plan) because it is
    // not about the default: it is about the worst configuration this app can
    // still produce. Whenever the card cannot hold the experts they are parked
    // in system RAM as a working set touched on every decoded token — roughly
    // 12 GiB of it — and it cannot be paged out without thrashing. On 32 GB
    // that is comfortable (12 + ~1.5 GB of webview/PDF.js/store + Windows). On
    // 16 GB it is fatal, and because the glossary and the knowledge graph now
    // run on these same weights, a silent failure there is a REGRESSION of two
    // shipped features, not just a new one not working. So the spawn is
    // refused outright with its own status ("nomem") rather than left to look
    // merely slow.
    const MIN_RAM_MIB: u64 = 20000;
    const MOE: bool = true;
    fn child(&self) -> &Mutex<Option<Child>> {
        &self.child
    }
    fn status(&self) -> &Mutex<String> {
        &self.status
    }
    fn log(&self) -> &Mutex<Vec<String>> {
        &self.log
    }
    fn after_kill(app: &tauri::AppHandle) {
        // The leases describe a live process; a killed one is owned by nobody.
        AuxState::clear_owners(app);
    }
    /// A held lease means somebody is mid-generation against these weights.
    ///
    /// The handover is symmetric in principle — either server may demand the
    /// card — but not in practice, and this is where the asymmetry lives. The
    /// lease set exists precisely because the three passes that share this
    /// server used to kill it out from under each other (aux_model_start says
    /// so at length), and letting the draft server's spawn do the same thing
    /// from outside would reverse that decision without replacing the reason
    /// for it. So a leased aux server is not evicted.
    ///
    /// What happens to the spawn that was refused the card is NOT «it cuts its
    /// layer budget to fit», which is what this comment used to promise. There
    /// is nothing to cut it to: the aux weights are ~13.6 GB of a 16 GB card,
    /// plan_spawn measures what is left, layer_budget answers ngl 0 and the
    /// draft server lands on the CPU. So the caller must decide what to do
    /// with that answer, and restart_translation does — it declines to spawn
    /// at all and parks the draft server in "swapping", where
    /// restore_after_handover picks it up when the lease drops.
    ///
    /// The draft server has no such guard because it has no such state: it
    /// holds no lease, every one of its callers fails soft on a dead port, and
    /// restart_translation or restore_after_handover brings it back.
    fn in_use(app: &tauri::AppHandle) -> bool {
        !app.state::<AuxState>().owners.lock().unwrap().is_empty()
    }
    fn handover(app: &tauri::AppHandle) {
        swap_out::<TranslationState>(app, Self::LABEL);
    }
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// How to ask llama-server for GPU offload on this machine.
enum Offload {
    /// Put `ngl` layers on this specific device (`-ngl <ngl> --device <id>`),
    /// with the free VRAM that decision was made from, when it is known.
    ///
    /// `ngl` used to be a hardcoded 99 — every layer or nothing. That is fine
    /// while the model is 4.3 GiB, and wrong the moment it is 6.8: an 8 GB card
    /// (3060 Ti, 4060, 2070 — common) reports around 7000-7400 MiB free after
    /// the desktop, which is not enough for the whole draft model but is enough
    /// for most of it — and a partial offload is decisively faster than the
    /// all-or-nothing CPU fallback, because the layers that stay on the card
    /// read their weights at VRAM bandwidth rather than at DDR5's.
    /// See plan_spawn.
    Device { id: String, free_mib: Option<u64>, ngl: u32 },
    /// Put every layer on whatever GPU backend the build has, without naming
    /// one (`-ngl 99`). llama.cpp clamps the count to the layers that exist and
    /// falls back to the CPU when no GPU backend is compiled in.
    All,
    /// No usable GPU: omit `-ngl` entirely.
    Cpu,
}

/// Which GPU (if any) the model should be offloaded to.
///
/// macOS is a separate case on purpose. There is exactly one GPU to choose
/// from, so a selector buys nothing — and the Metal backend's id in
/// `--list-devices` is not something worth parsing for a choice that has no
/// alternatives. Asking for full offload without naming a device is both
/// simpler and correct whether or not the build has Metal in it.
///
/// Everywhere else the machine may genuinely have several devices, and the
/// wrong one (an integrated GPU next to a discrete one) is much slower than the
/// right one, so the list is parsed and a device is named.
fn pick_offload(exe: &Path, label: &str) -> Offload {
    if cfg!(target_os = "macos") {
        eprintln!("[{label}] macOS: full offload to the single GPU, no device selector");
        return Offload::All;
    }
    match pick_device(exe, label) {
        // -ngl 99 is the starting point, not the answer: plan_spawn cuts it
        // down to what the measured free VRAM can actually hold.
        Some((id, free_mib)) => Offload::Device { id, free_mib, ngl: 99 },
        None => Offload::Cpu,
    }
}

/// Run `llama-server --list-devices` and pick the best GPU:
/// prefer NVIDIA, else the first non-integrated device. None => CPU mode.
///
/// The second half of the pair is the device's FREE VRAM in MiB, which the
/// same line has always carried and this function used to throw away. It
/// matters because free is not total: the desktop, the browser the reader left
/// open and any other GPU process are already holding some of the card, and
/// there is no way to compute that, only to measure it.
///
/// It used to matter for a second reason — «the aux server is spawned while
/// the draft server is already resident, so the number nets out whatever the
/// draft took». That is no longer true and is no longer wanted: the servers
/// run one at a time and the caller stops the other one BEFORE this runs
/// (LlamaSrv::handover), so the number now describes a card with nothing of
/// ours on it. Which is exactly why the measurement has to happen after the
/// handover and not be cached from an earlier spawn. `None` for the number
/// means the line had no parenthesised tail; that is not a failure and the
/// device is still picked, the caller simply falls back to MIN_VRAM_MIB.
fn pick_device(exe: &Path, label: &str) -> Option<(String, Option<u64>)> {
    let mut cmd = Command::new(exe);
    cmd.arg("--list-devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::quiet(&mut cmd);
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
    let mut fallback: Option<(String, Option<u64>)> = None;
    for line in text.lines() {
        // e.g. "  CUDA0: NVIDIA GeForce RTX 5080 (16302 MiB, 14985 MiB free)"
        // — the whole line this machine prints today, one device and no more.
        // The id prefix is backend-dependent (it read "Vulkan0" here before
        // the engine was swapped for the CUDA build), which is why the match
        // below accepts any of the four and not a fixed one.
        let Some((id, name)) = line.trim().split_once(':') else {
            continue;
        };
        let free_mib = parse_free_mib(line);
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
            eprintln!(
                "[{label}] device pick: {id} ({}) [NVIDIA, preferred], free VRAM {}",
                name.trim(),
                free_str(free_mib)
            );
            return Some((id.to_string(), free_mib));
        }
        let integrated = name_l.contains("radeon(tm) graphics")
            || name_l.contains("iris")
            || name_l.contains("uhd")
            || name_l.contains("integrated");
        if !integrated && fallback.is_none() {
            fallback = Some((id.to_string(), free_mib));
        }
    }
    match &fallback {
        Some((id, free_mib)) => eprintln!(
            "[{label}] device pick: {id} [non-integrated fallback], free VRAM {}",
            free_str(*free_mib)
        ),
        None => eprintln!("[{label}] device pick: none (no discrete GPU) -> CPU mode"),
    }
    fallback
}

/// "15209 MiB" / "unknown", for the logs.
fn free_str(free_mib: Option<u64>) -> String {
    match free_mib {
        Some(n) => format!("{n} MiB"),
        None => "unknown".into(),
    }
}

/// Free VRAM in MiB out of one `--list-devices` line, or None when the line
/// carries no parenthesised tail (older builds, other backends).
///
/// The tail on this machine is verbatim `(16302 MiB, 14985 MiB free)`: total
/// first, free second. (It read `(15977 MiB, 15209 MiB free)` under the Vulkan
/// build — same shape, different numbers, which is the point: neither figure
/// is a constant anywhere in this file, every one of them is measured at spawn
/// time.) Anchored on the LAST parentheses because a device name
/// may contain its own — "NVIDIA GeForce RTX 5080 (Laptop)" is a real string —
/// and matched on the field that ends in "free" rather than on its position,
/// so a build that prints only one of the two numbers still parses or still
/// answers None instead of confidently answering with the total.
fn parse_free_mib(line: &str) -> Option<u64> {
    let open = line.rfind('(')?;
    let close = line.rfind(')')?;
    if close <= open {
        return None;
    }
    line[open + 1..close]
        .split(',')
        .map(str::trim)
        .find(|f| f.ends_with("free"))
        .and_then(|f| f.trim_end_matches("free").trim().trim_end_matches("MiB").trim().parse().ok())
}

// ---------------------------------------------------------------------------
// What the model file says about itself, and the memory arithmetic that
// follows from it.
//
// Everything below exists to answer one question honestly: will this model,
// at this -c, fit in the VRAM this machine has free right now. The previous
// answer was «assume yes, pass -ngl 99» — correct for a 4.3 GiB model on a
// 16 GB card and wrong for a 6.8 GiB one, and catastrophic for a 14.2 GiB MoE.
//
// The numbers are read from the GGUF header rather than guessed, and rather
// than parsed out of llama-server's own load line: the header is there before
// the server starts, so the decision can be made BEFORE committing to a spawn
// that would OOM. (It is also read at spawn time rather than cached at
// download time, so weights placed by hand or downloaded by an older build
// are covered by exactly the same code path.)
// ---------------------------------------------------------------------------

const MIB: u64 = 1024 * 1024;

/// Slack left on the card beyond weights + KV + compute: driver allocations,
/// the desktop growing a window, and the plain fact that every estimate here
/// is an estimate.
const VRAM_HEADROOM_MIB: u64 = 256;

/// The geometry of a GGUF file, as the file itself states it.
#[derive(Default)]
struct GgufMeta {
    arch: String,
    file_bytes: u64,
    /// `<arch>.block_count` — the number of repeating transformer layers.
    n_layer: u32,
    n_head: u32,
    n_head_kv: u32,
    n_embd: u32,
    key_length: u32,
    value_length: u32,
    /// Length of the tokenizer's token array. Drives the compute buffer, which
    /// on a 262k-vocabulary Gemma is half a gigabyte on its own.
    n_vocab: u32,
    /// `<arch>.attention.sliding_window`, 0 when the arch has none.
    sliding_window: u32,
    /// `<arch>.attention.sliding_window_pattern` — one global layer every N.
    /// 0 when unknown, which is treated as «no discount» on purpose.
    sliding_window_pattern: u32,
    /// `<arch>.expert_count`, 0 for a dense model.
    n_expert: u32,
    /// Bytes occupied by the expert (`*_exps`) tensors, summed from the
    /// tensor table's own offsets — exact, and free of a ggml type-size table.
    expert_bytes: u64,
    /// How many layers actually carry expert tensors (an MoE may have dense
    /// first layers), which is the N that `-ncmoe` counts.
    expert_layers: u32,
}

impl GgufMeta {
    fn weights_mib(&self) -> u64 {
        self.file_bytes / MIB
    }

    /// Everything that is not an expert tensor: what stays on the GPU when the
    /// experts are routed to the CPU backend.
    fn dense_mib(&self) -> u64 {
        self.file_bytes.saturating_sub(self.expert_bytes) / MIB
    }

    /// Average VRAM cost of keeping ONE layer's experts on the GPU.
    fn expert_layer_mib(&self) -> Option<u64> {
        (self.expert_layers > 0 && self.expert_bytes > 0)
            .then(|| (self.expert_bytes / MIB / self.expert_layers as u64).max(1))
    }

    /// K and V head dimensions. Modern GGUFs state them; older ones leave them
    /// implied by embedding_length / head_count.
    fn head_dims(&self) -> (u64, u64) {
        let implied = if self.n_head > 0 { (self.n_embd / self.n_head) as u64 } else { 128 };
        let k = if self.key_length > 0 { self.key_length as u64 } else { implied };
        let v = if self.value_length > 0 { self.value_length as u64 } else { implied };
        (k, v)
    }

    /// (global layers, local layers, window) under sliding-window attention.
    ///
    /// A window with no stated pattern used to fall through to «charge every
    /// layer the full context». That is a model of `--swa-full`, a flag this
    /// app never passes (init_llama_server says why), so it over-charged by
    /// exactly the factor the window exists to save — and it was harmless only
    /// while -c was small. At the -c the slot counts now require it is not:
    /// on a 48-layer draft model at -c 24576 the difference is several GiB of
    /// imaginary KV, enough to cut -ngl on a model that fits comfortably.
    ///
    /// The pattern key is genuinely often absent — llama.cpp sets the pattern
    /// per architecture in its own loader rather than reading it — so the
    /// answer cannot be «demand it». What the header DOES state is that a
    /// window exists, and that bounds the pattern: p = 1 would mean no local
    /// layers at all, i.e. no sliding window, which contradicts the window the
    /// file just stated. So p >= 2, and p = 2 — half the layers global — is
    /// the worst case the header still allows. Every shipped pattern is
    /// larger, so this remains an over-estimate of the KV and never an
    /// under-estimate, which is the direction that matters: over-estimating
    /// costs a few offloaded layers, under-estimating costs an OOM.
    fn swa_split(&self) -> (u64, u64, u64) {
        let n = self.n_layer.max(1) as u64;
        if self.sliding_window == 0 {
            return (n, 0, 0);
        }
        let p = match self.sliding_window_pattern as u64 {
            // A file that states BOTH a window and a pattern of 1 is telling
            // us two contradictory things; charge the full context and move on.
            1 => return (n, 0, 0),
            0 => 2,
            p => p,
        };
        let global = (n + p - 1) / p;
        (global, n - global, self.sliding_window as u64)
    }

    /// KV cache at this -c, in MiB, at llama.cpp's default f16 K and V.
    ///
    /// Charged for every layer even when only some are offloaded: the layers
    /// that stay on the CPU take their KV from system RAM, which makes this an
    /// over-estimate on the GPU side and never an under-estimate.
    fn kv_mib(&self, ctx: u32) -> u64 {
        let (kl, vl) = self.head_dims();
        let per_token_layer = self.n_head_kv.max(1) as u64 * (kl + vl) * 2;
        let ctx = ctx.max(1) as u64;
        let (global, local, window) = self.swa_split();
        let cells = global * ctx + local * window.min(ctx);
        cells * per_token_layer / MIB
    }

    /// Compute buffer, dominated by the output logits tensor: the graph is
    /// allocated for a full ubatch, so a 262k vocabulary at the default
    /// ubatch of 512 is 512 MiB of f32 before anything else is counted.
    fn compute_mib(&self) -> u64 {
        const UBATCH: u64 = 512;
        let vocab = if self.n_vocab > 0 { self.n_vocab as u64 } else { 256_000 };
        (vocab * UBATCH * 4 / MIB).clamp(256, 1536)
    }

    /// Read the header of a GGUF file. `None` for anything that is not a GGUF
    /// we understand — every caller then falls back to a fixed floor, so an
    /// unreadable header is a lost optimisation and never a failure.
    fn read(path: &Path) -> Option<GgufMeta> {
        let file = File::open(path).ok()?;
        let file_bytes = file.metadata().ok()?.len();
        let mut r = GgufReader { r: BufReader::with_capacity(1 << 20, file), pos: 0 };
        if r.take(4)?[..] != *b"GGUF" {
            return None;
        }
        let version = r.u32()?;
        if !(2..=3).contains(&version) {
            return None;
        }
        let tensor_count = r.u64()?;
        let kv_count = r.u64()?;
        if tensor_count > 100_000 || kv_count > 10_000 {
            return None; // not a header we wrote or a file we should walk
        }

        let mut m = GgufMeta { file_bytes, ..Default::default() };
        let mut alignment: u64 = 32;
        for _ in 0..kv_count {
            let key = r.string()?;
            let ty = r.u32()?;
            let val = r.value(ty)?;
            // Matched on the suffix: every geometry key is prefixed with the
            // architecture name, which is itself only known from a key that
            // happens to come first in practice and is not guaranteed to.
            let num = match &val {
                GVal::Num(n) => Some(*n),
                GVal::Arr { max: Some(n), .. } => Some(*n),
                _ => None,
            };
            match key.as_str() {
                "general.architecture" => {
                    if let GVal::Str(s) = &val {
                        m.arch = s.clone();
                    }
                }
                "general.alignment" => alignment = num.unwrap_or(32).max(1),
                "tokenizer.ggml.tokens" => {
                    if let GVal::Arr { len, .. } = &val {
                        m.n_vocab = *len as u32;
                    }
                }
                k if k.ends_with(".block_count") => m.n_layer = num.unwrap_or(0) as u32,
                k if k.ends_with(".embedding_length") => m.n_embd = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.head_count") => m.n_head = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.head_count_kv") => m.n_head_kv = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.key_length") => m.key_length = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.value_length") => m.value_length = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.sliding_window") => m.sliding_window = num.unwrap_or(0) as u32,
                k if k.ends_with(".attention.sliding_window_pattern") => {
                    m.sliding_window_pattern = num.unwrap_or(0) as u32
                }
                k if k.ends_with(".expert_count") => m.n_expert = num.unwrap_or(0) as u32,
                _ => {}
            }
        }
        if m.n_layer == 0 {
            return None; // no layer count, no budget: let the caller use its floor
        }

        // Tensor table. Sizes come from the DIFFERENCE between consecutive data
        // offsets rather than from dims × type size — exact for every quant,
        // present and future, without carrying a copy of ggml's type table.
        let mut tensors: Vec<(u64, bool, u32)> = Vec::with_capacity(tensor_count as usize);
        for _ in 0..tensor_count {
            let name = r.string()?;
            let n_dims = r.u32()?;
            if n_dims > 8 {
                return None;
            }
            r.skip(n_dims as u64 * 8)?; // dims
            let _ty = r.u32()?;
            let offset = r.u64()?;
            // "blk.31.ffn_down_exps.weight" — the router (ffn_gate_inp) is
            // dense and deliberately not matched.
            let is_expert = name.contains("_exps");
            let layer = name
                .strip_prefix("blk.")
                .and_then(|rest| rest.split('.').next())
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(u32::MAX);
            tensors.push((offset, is_expert, layer));
        }
        let data_start = (r.pos + alignment - 1) / alignment * alignment;
        if data_start >= file_bytes {
            return None;
        }
        let data_len = file_bytes - data_start;
        tensors.sort_by_key(|t| t.0);
        let mut expert_layers: HashSet<u32> = HashSet::new();
        for i in 0..tensors.len() {
            let (offset, is_expert, layer) = tensors[i];
            if !is_expert {
                continue;
            }
            let end = tensors.get(i + 1).map(|t| t.0).unwrap_or(data_len);
            m.expert_bytes += end.saturating_sub(offset);
            if layer != u32::MAX {
                expert_layers.insert(layer);
            }
        }
        m.expert_layers = expert_layers.len() as u32;
        eprintln!(
            "[gguf] {}: arch {}, {} layers, {} kv-heads, vocab {}, swa {}/{}, experts {} ({} MiB / {} layers)",
            path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            m.arch,
            m.n_layer,
            m.n_head_kv,
            m.n_vocab,
            m.sliding_window,
            m.sliding_window_pattern,
            m.n_expert,
            m.expert_bytes / MIB,
            m.expert_layers
        );
        Some(m)
    }
}

/// One metadata value, reduced to what the budget actually needs.
enum GVal {
    Num(u64),
    Str(String),
    /// Arrays answer with their length (that is how the vocabulary size is
    /// recovered without materialising 262k strings) and, for short numeric
    /// arrays, their maximum — some architectures state head_count_kv per
    /// layer, and the largest layer is the one the cache must fit.
    Arr { len: u64, max: Option<u64> },
    Other,
}

struct GgufReader {
    r: BufReader<File>,
    pos: u64,
}

impl GgufReader {
    fn take(&mut self, n: usize) -> Option<Vec<u8>> {
        if n > 16 * 1024 * 1024 {
            return None;
        }
        let mut v = vec![0u8; n];
        self.r.read_exact(&mut v).ok()?;
        self.pos += n as u64;
        Some(v)
    }
    fn skip(&mut self, n: u64) -> Option<()> {
        let copied = std::io::copy(&mut (&mut self.r).take(n), &mut std::io::sink()).ok()?;
        if copied != n {
            return None;
        }
        self.pos += n;
        Some(())
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn string(&mut self) -> Option<String> {
        let n = self.u64()?;
        Some(String::from_utf8_lossy(&self.take(n as usize)?).into_owned())
    }
    /// Byte width of a fixed-size value type, so a long array can be skipped
    /// in one seek instead of element by element.
    fn fixed_size(ty: u32) -> Option<u64> {
        match ty {
            0 | 1 | 7 => Some(1),
            2 | 3 => Some(2),
            4 | 5 | 6 => Some(4),
            10 | 11 | 12 => Some(8),
            _ => None,
        }
    }
    fn value(&mut self, ty: u32) -> Option<GVal> {
        Some(match ty {
            // i8 lands here too: every value this reads is a count, so the
            // sign would only matter for a file that is already nonsense.
            0 | 1 | 7 => GVal::Num(self.take(1)?[0] as u64),
            2 | 3 => GVal::Num(u16::from_le_bytes(self.take(2)?.try_into().ok()?) as u64),
            4 | 5 => GVal::Num(self.u32()? as u64),
            10 | 11 => GVal::Num(self.u64()?),
            6 | 12 => {
                self.skip(if ty == 6 { 4 } else { 8 })?;
                GVal::Other
            }
            8 => GVal::Str(self.string()?),
            9 => {
                let ety = self.u32()?;
                let len = self.u64()?;
                let mut max: Option<u64> = None;
                match Self::fixed_size(ety) {
                    // Short numeric arrays are read (per-layer head counts);
                    // long ones are skipped whole.
                    Some(sz) if len > 4096 => self.skip(len.checked_mul(sz)?)?,
                    _ => {
                        for _ in 0..len {
                            if let GVal::Num(n) = self.value(ety)? {
                                max = Some(max.unwrap_or(0).max(n));
                            }
                        }
                    }
                }
                GVal::Arr { len, max }
            }
            _ => return None,
        })
    }
}

/// Total physical RAM in MiB, or None when the platform will not say.
///
/// Written by hand rather than through a crate because the alternative is a
/// new dependency (sysinfo) or a new windows-sys feature for one call, and
/// this app's rule is one prescribed source per dependency, not one per
/// convenience.
#[cfg(windows)]
fn total_ram_mib() -> Option<u64> {
    // Every field is part of the OS contract even though only total_phys is
    // read back; the struct must match the API layout exactly.
    #[allow(dead_code)]
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    // SAFETY: the struct is ours, zeroed, and its dwLength field is set as the
    // API requires; the call only writes inside it and reports whether it did.
    let mut st: MemoryStatusEx = unsafe { std::mem::zeroed() };
    st.length = std::mem::size_of::<MemoryStatusEx>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut st) } != 0).then(|| st.total_phys / MIB)
}

#[cfg(target_os = "macos")]
fn total_ram_mib() -> Option<u64> {
    let name = std::ffi::CString::new("hw.memsize").ok()?;
    let mut bytes: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: a NUL-terminated name we own, an output buffer we own, and a
    // length that matches it; the return code says whether it was filled.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut bytes as *mut u64 as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0 && bytes > 0).then(|| bytes / MIB)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn total_ram_mib() -> Option<u64> {
    // SAFETY: sysconf takes an int and returns a long; no pointers involved.
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    (pages > 0 && page > 0).then(|| (pages as u64).saturating_mul(page as u64) / MIB)
}

#[cfg(not(any(windows, unix)))]
fn total_ram_mib() -> Option<u64> {
    None
}

/// What to do with an MoE's expert tensors.
enum MoePlan {
    /// Every expert layer on the CPU backend (`--cpu-moe`). Reachable only
    /// when the header could not be read at all, because `-ncmoe N` needs the
    /// layer count the header would have carried.
    AllCpu,
    /// The first N expert layers on the CPU, the rest on the GPU (`-ncmoe N`).
    Partial(u32),
    /// Everything fits on the GPU: pass nothing. The answer whenever the card
    /// has room for the whole file beside its KV — which, with the other
    /// server stopped, is a question worth asking rather than assuming away.
    NoneNeeded,
}

/// How much of the expert set has to leave the GPU, if any.
///
/// **`--cpu-moe` is no longer the default, and that reverses the decision this
/// function was written to make.** The old body defaulted to AllCpu and
/// treated `-ncmoe N` as an optimisation on top, on the reasoning that after
/// the draft server's own allocation there was around 6 GiB left and the aux
/// model needed more than that. Both halves of that reasoning are gone:
///
///  - The premise was co-residency, and the two servers no longer co-reside.
///    They cannot overlap in the first place — the style edit consumes the
///    draft's output — so the draft server is stopped before this is measured
///    (swap_out), and «free VRAM» now means the whole card.
///  - The cost was measured rather than assumed. Google's own config for this
///    model gives 30 layers, 128 experts, top-8, and 1.43 B active parameters:
///    782 MB of expert traffic per generated token. Alone on this card every
///    expert layer is resident and that traffic is VRAM bandwidth; pushed to
///    system RAM it is DDR5 at an effective 35-60 GB/s, i.e. 33-57 t/s against
///    a bandwidth-implied ~175. `--cpu-moe` was costing 3-5x on the slowest
///    pass in the app, and llama.cpp's own maintainer guidance agrees that
///    raising it on a model that already fits degrades throughput steadily.
///
/// So: measure, and move to the CPU only what will not fit. AllCpu survives
/// for exactly one case — a header we could not parse, where `-ncmoe`'s N is
/// unknowable and «all of them» is the only expressible answer that fits
/// whenever anything fits.
fn moe_plan(free: u64, m: &GgufMeta, ctx: u32) -> MoePlan {
    let Some(per_layer) = m.expert_layer_mib() else {
        return MoePlan::NoneNeeded; // dense model: --cpu-moe would mean nothing
    };
    let avail = free.saturating_sub(m.kv_mib(ctx) + m.compute_mib() + VRAM_HEADROOM_MIB);
    let dense = m.dense_mib();
    if avail <= dense {
        // Not even the non-expert tensors fit beside the KV. Every expert
        // layer goes, and layer_budget then decides how much of what is left
        // the card can still take. Expressed as -ncmoe <all> rather than
        // --cpu-moe so there is one flag and one code path; they mean the same
        // thing to llama-server.
        eprintln!(
            "[moe] {free} MiB free leaves {avail} for {dense} MiB of dense weights -> all {} expert layers to the CPU",
            m.expert_layers
        );
        return MoePlan::Partial(m.expert_layers);
    }
    // Only four fifths of the spare room is spent. The per-layer figure is an
    // average over layers that need not be identical, and the last thing this
    // should do is turn a spawn that works into an OOM for 15% more speed.
    let spare = (avail - dense) * 4 / 5;
    let keep = (spare / per_layer).min(m.expert_layers as u64) as u32;
    eprintln!(
        "[moe] {free} MiB free, dense {dense}, {per_layer} MiB/expert layer -> {keep} of {} expert layers on the GPU",
        m.expert_layers
    );
    match keep {
        k if k >= m.expert_layers => MoePlan::NoneNeeded,
        k => MoePlan::Partial(m.expert_layers - k),
    }
}

impl MoePlan {
    /// The argv this plan turns into. Empty for NoneNeeded — passing nothing
    /// is what «all the experts stay on the GPU» looks like.
    fn args(&self) -> Vec<String> {
        match self {
            MoePlan::AllCpu => vec!["--cpu-moe".into()],
            MoePlan::Partial(n) => vec!["-ncmoe".into(), n.to_string()],
            MoePlan::NoneNeeded => Vec::new(),
        }
    }

    /// MiB of expert tensors this plan keeps OFF the GPU, for the layer
    /// budget. The two have to be computed from one decision: budgeting as if
    /// the experts were in system RAM while spawning without the flag (or the
    /// reverse) is how a card that fits ends up refusing an allocation.
    fn cpu_expert_mib(&self, m: &GgufMeta) -> u64 {
        match self {
            MoePlan::AllCpu => m.expert_bytes / MIB,
            MoePlan::Partial(n) => m.expert_layer_mib().unwrap_or(0) * (*n as u64),
            MoePlan::NoneNeeded => 0,
        }
    }
}

/// Turn the raw device pick into a layer budget the card can actually hold,
/// together with the expert routing that budget assumes.
///
/// The two answers come out of one function because they are one decision:
/// how many layers fit depends on how much of the expert set is resident, and
/// how much of the expert set can be resident depends on the same free-VRAM
/// number. They used to be computed in two places — here for `-ngl`, and again
/// inside the server's `extra_args` for the MoE flag — off a constant that
/// asserted the experts were always in system RAM. With that constant gone
/// (LlamaSrv::MOE) the only way to keep them consistent is to compute them
/// together and hand both to the spawn.
///
/// The layer budget itself is unchanged in spirit: the old policy was binary —
/// every layer on the GPU, or none — which was invisible while the model was
/// small enough that «every layer» always fit. With a 6.8 GiB draft model a
/// very common 8 GB card fits most of the layers and not all of them, and
/// dropping it to the CPU entirely costs more than half the speed. So:
/// subtract the KV and the compute buffer from the free VRAM, divide what is
/// left by the average layer, and pass that.
///
/// The caller must have handed the card over first (LlamaSrv::handover): every
/// number below is measured, so it is only as true as the state of the machine
/// when it was measured.
fn plan_spawn<S: LlamaSrv>(exe: &Path, meta: Option<&GgufMeta>, ctx: u32) -> (Offload, MoePlan) {
    let label = S::LABEL;
    let picked = pick_offload(exe, label);
    let Offload::Device { id, free_mib: Some(free), .. } = picked else {
        // Nothing measured, so nothing to divide up. This is also the macOS
        // path (pick_offload returns Offload::All without ever listing a
        // device), and macOS is precisely where an MoE flag must not be
        // passed: the GPU and the CPU share one memory pool, so forcing the
        // experts «to the CPU» buys no memory and costs most of the model's
        // speed. Offload::Cpu is excluded for a different reason — --cpu-moe
        // is a tensor override away from the GPU buffer type, and with nothing
        // offloaded there is no GPU buffer to override away from.
        return (picked, MoePlan::NoneNeeded);
    };
    let moe = match meta {
        Some(m) if m.n_expert > 0 => moe_plan(free, m, ctx),
        // Header unreadable and we know this model is an MoE: -ncmoe's N is
        // unknowable, so the whole set goes. See LlamaSrv::MOE.
        None if S::MOE => MoePlan::AllCpu,
        _ => MoePlan::NoneNeeded,
    };
    let ngl = match meta {
        Some(m) => layer_budget::<S>(free, m, ctx, &moe),
        // No geometry to budget with: the single floor is all we have.
        None if free < S::MIN_VRAM_MIB => 0,
        None => 99,
    };
    if ngl == 0 {
        eprintln!("[{label}] {free} MiB of free VRAM is not enough for a single layer.");
        eprintln!("[{label}] -> spawning on the CPU. Slow, but a VRAM OOM is a dead server.");
        return (Offload::Cpu, MoePlan::NoneNeeded);
    }
    (Offload::Device { id, free_mib: Some(free), ngl }, moe)
}

/// How many layers fit in `free` MiB, given what the file says about itself
/// and what `moe` has decided to keep off the card.
fn layer_budget<S: LlamaSrv>(free: u64, m: &GgufMeta, ctx: u32, moe: &MoePlan) -> u32 {
    let label = S::LABEL;
    let kv = m.kv_mib(ctx);
    let compute = m.compute_mib();
    // Only the expert tensors the plan actually routes away are subtracted.
    // This used to be «all of them, always» via a per-server constant, which
    // silently under-counted the resident weights the moment the experts were
    // allowed to stay — the case that is now normal.
    let resident = m.weights_mib().saturating_sub(moe.cpu_expert_mib(m));
    // Divided by one MORE than the block count: the token embeddings and the
    // output tensor belong to no block and sit on the card all the same.
    let per_layer = (resident / (m.n_layer as u64 + 1)).max(1);
    let avail = free.saturating_sub(kv + compute + VRAM_HEADROOM_MIB);
    let ngl = (avail / per_layer).min(99) as u32;
    eprintln!("[{label}] VRAM: {free} free - {kv} KV (-c {ctx}) - {compute} compute - {VRAM_HEADROOM_MIB} slack");
    eprintln!("[{label}] -> {avail} MiB for {resident} MiB of weights, {per_layer}/layer, -ngl {ngl}");
    ngl
}

/// Serialises measure → spawn → first answer across BOTH servers.
///
/// The free-VRAM number is measured by running `llama-server --list-devices`
/// as a separate process at the top of each spawn, and there is no shared
/// accounting between the two servers. A webview reload firing
/// restart_translation while a style run calls aux_model_start would otherwise
/// have both measure ~15 GiB free and both commit against it. The moment a
/// VRAM budget exists, that race is a race in the direction that lets both
/// through. Held until the port answers, so the second spawn measures the card
/// AFTER the first has allocated — which also stops two 7-14 GB model loads
/// from fighting over the same disk.
///
/// It now serialises the GPU handover too (swap_out runs inside it), which is
/// the only way «stop the other one, then measure» can mean anything: without
/// the lock the other server could start reloading between the two steps.
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// How long to wait after reaping a llama-server before measuring the card.
///
/// `wait()` returning means the process is gone as far as the OS is concerned;
/// it does not mean the driver has finished reclaiming its allocations. The
/// whole point of the handover is that the next spawn budgets against a card
/// that is actually free, and a stale `--list-devices` reading would hand it a
/// budget for VRAM that is about to exist — or, worse, a budget it then fails
/// to allocate. This is a settling pause, not a measurement: it is deliberately
/// short next to a model load and next to passes measured in tens of minutes.
const GPU_SETTLE: Duration = Duration::from_millis(1500);

/// Hand the GPU over: stop the OTHER server so the one about to spawn can have
/// the card to itself.
///
/// The design this replaces assumed both servers stay resident, and every
/// memory decision in this file followed from that assumption — a permanent
/// `--cpu-moe`, a layer budget measured against whatever the other server had
/// already taken. The assumption was never load-bearing: the style edit
/// consumes the draft's output, so the two passes cannot overlap, and one
/// model load of under a minute is nothing against passes that run for tens of
/// minutes. Sequential is simply what they already were, minus the cost.
///
/// Three things this must not do, all of them rules that already existed here:
/// it never touches an "external" server the user started themselves; it never
/// evicts a server something is actively using (LlamaSrv::in_use); and it
/// leaves behind a status that says what happened rather than one that reads
/// as failure. "swapping" is that status — the frontend can say «освобождаю
/// видеопамять» instead of «сервер умер», and aux_model_start spawns straight
/// out of it. restart_translation spawns out of it too, but only while no aux
/// lease is held: with one held there is no card to spawn onto, and it parks
/// the draft server back in "swapping" instead of starting it on the CPU. See
/// the `AuxState::in_use` arm there.
fn swap_out<O: LlamaSrv>(app: &tauri::AppHandle, taker: &str) {
    if O::in_use(app) {
        eprintln!(
            "[{taker}] handover: {} is still in use -> not evicting it, this spawn shares the card",
            O::LABEL
        );
        return;
    }
    let state = app.state::<O>();
    let taken = state.child().lock().unwrap().take();
    let killed = {
        let mut status = state.status().lock().unwrap();
        if status.as_str() == "external" {
            // Never ours to stop. Nothing was taken from state.child either —
            // an external server was never stored there.
            eprintln!("[{taker}] handover: {} is external -> left alone", O::LABEL);
            return;
        }
        match taken {
            Some(mut child) => {
                eprintln!(
                    "[{taker}] handover -> stopping {} llama-server pid {}",
                    O::LABEL,
                    child.id()
                );
                let _ = child.kill();
                let _ = child.wait();
                *status = "swapping".into();
                true
            }
            None => {
                // No child, but a spawn of theirs may be queued behind
                // SPAWN_LOCK with nothing stored yet. Marking it here is what
                // stops the two servers from taking the card back off each
                // other in turn: init_llama_server checks this status again
                // after it finally gets the lock and stands down.
                if status.as_str() == "starting" {
                    eprintln!("[{taker}] handover: {}'s queued spawn stands down", O::LABEL);
                    *status = "swapping".into();
                }
                false
            }
        }
    };
    if killed {
        O::after_kill(app);
        std::thread::sleep(GPU_SETTLE);
    }
}

/// Give the card back to the draft server once the borrower is done with it.
///
/// The handover is only half a mechanism without this. The style pass takes
/// the aux lease, which stops the draft server; when the last lease goes the
/// aux server dies and — before this existed — the machine sat with no
/// translator at all until the reader pressed «Перезапустить» on a model that
/// had done nothing wrong. Restoring is not «starting a server on its own»:
/// the draft server is spawned unconditionally at app launch (run()), so it is
/// the one this app is always supposed to be running, and "swapping" is the
/// state that records we took it away rather than that it stopped.
///
/// Gated on that status precisely. A draft server that is "none" (no weights),
/// "noengine", "dead" or "external" was not evicted by us and is not ours to
/// bring back.
///
/// swap_out is no longer the only writer of "swapping": restart_translation
/// writes it too, when the reader asks for the draft server back while an aux
/// lease is held and there is therefore no card to give it. That is the same
/// fact — «this server is off because the other model has the GPU» — and it
/// wants the same restore, so the gate needs no widening for it, only the note
/// that a "swapping" here may be a deferred press rather than an eviction.
fn restore_after_handover(app: &tauri::AppHandle) {
    if AuxState::in_use(app) {
        // A new lease was taken between the set emptying and this line — the
        // aux server is wanted again, so the card is not free after all.
        // Restoring here would spawn the draft server only for the aux spawn
        // behind it to evict it again, and the handover's own stand-down
        // (init_llama_server) would then leave nothing running at all.
        return;
    }
    {
        let state = app.state::<TranslationState>();
        let mut status = state.status.lock().unwrap();
        if status.as_str() != "swapping" {
            return;
        }
        *status = "starting".into();
    }
    eprintln!("[translation] handover done -> restoring the draft server");
    let handle = app.clone();
    std::thread::spawn(move || {
        // Settle before measuring — the same pause swap_out's killed branch
        // takes (lib.rs:1210), which until now was the ONLY place that took
        // it. This half of the handover frees the card just as thoroughly and
        // skipped it.
        //
        // The caller has just reaped the aux child: aux_model_stop and
        // aux_lease_reset both go through AuxState::kill_spawned_child
        // (lib.rs:1787), and `wait()` returning says only that the OS has
        // reaped the process. It does not say the driver has handed the
        // allocation back, which is the whole reason GPU_SETTLE exists
        // (lib.rs:1141). Without the pause the spawn below measures the card
        // through `llama-server --list-devices` (pick_device, lib.rs:421)
        // while as much as 13.6 GB of expert tensors may still be charged to
        // it; layer_budget (lib.rs:1096) then divides what little is left and
        // answers a small -ngl, or 0. The draft server comes up on the CPU
        // under the status "spawned" — which reads as success everywhere in
        // the frontend and, not being "swapping", is a state
        // restore_after_handover can never pick up again, so it stays on the
        // CPU until the app is restarted. restart_translation refuses to
        // spawn at all rather than produce that outcome while the card is
        // held (lib.rs:1737); a card that is only just being released
        // deserves the same care, and here it costs a second and a half.
        //
        // Inside the thread rather than before it because this function is
        // called straight from the two aux commands, and a sleep on that
        // thread would block the IPC call that dropped the lease. Here it is
        // free: the next thing this thread does is a 7.3 GB model load.
        std::thread::sleep(GPU_SETTLE);
        init_llama_server::<TranslationState>(handle)
    });
}

fn set_status<S: LlamaSrv>(app: &tauri::AppHandle, s: &str) {
    let state = app.state::<S>();
    *state.status().lock().unwrap() = s.into();
}

/// Where this app looks for a manually placed llama.cpp build. Anything
/// dropped here wins over a package-manager install, and its runtime libraries
/// are found next to it, exactly as llama.cpp ships them.
fn app_llama_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("llama")
}

/// Resolve `llama-server`. Chitallo ships no engine of its own (see README
/// «Dependencies»): the user installs llama.cpp with one command, and we find
/// it. `None` means "not installed" and the UI says which command installs it.
fn llama_server_exe(data_dir: &Path) -> Option<PathBuf> {
    platform::llama_server(&app_llama_dir(data_dir))
}

/// What the engine screens (onboarding, settings) need to know: is the
/// llama.cpp binary installed, and where did we find it.
#[derive(serde::Serialize)]
struct EngineStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
async fn engine_status(app: tauri::AppHandle) -> Result<EngineStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(match llama_server_exe(&data_dir) {
            Some(exe) => EngineStatus {
                installed: true,
                version: platform::probe_version(&exe),
                path: Some(exe.display().to_string()),
            },
            None => EngineStatus { installed: false, path: None, version: None },
        })
    })
    .await
    .map_err(|e| format!("engine_status task failed: {e}"))?
}

/// Spawn (or attach to) a llama-server instance for S. Blocking: run on a
/// background thread. Status transitions:
///   port already answering      -> "external" (reused, never killed)
///   llama.cpp not installed     -> "noengine"
///   weights not downloaded      -> "none"
///   too little system RAM       -> "nomem"
///   spawn failed / no answer within BOOT_POLLS -> "dead"
///   the child exited on its own -> S::CRASHED ("dead" for the main server,
///                                  "crashed" for aux)
///   port answers                -> S::UP
///
/// One transition is written from OUTSIDE this function: the other server's
/// spawn stops ours and leaves "swapping" behind (swap_out). That is why the
/// status is re-read after the spawn lock is taken — a spawn that queued
/// behind the very handover that evicted it must not undo it.
///
/// S::CRASHED is split out from "dead" deliberately. A process that started
/// and then exited is almost always a resource failure — a VRAM allocation the
/// card refused, a corrupt file — and reporting that as the same word we use
/// for «never answered» made an OOM indistinguishable from «you never
/// downloaded the weights», on a machine where the weights were downloaded.
/// The child's own stderr is kept (see drain_stderr) so the reason can be read
/// rather than guessed.
///
/// The port is probed first on purpose: a llama-server the user started
/// themselves makes both local prerequisites irrelevant, so we must not report
/// a missing engine or missing weights while a perfectly good server answers.
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

    if port_open(S::PORT) {
        eprintln!(
            "[{label}] port {} already answering -> reusing external llama-server (no spawn, will never kill it)",
            S::PORT
        );
        set_status::<S>(&app, "external");
        return;
    }
    let Some(exe) = llama_server_exe(&data_dir) else {
        eprintln!("[{label}] llama-server not found on PATH or in the app dir -> status noengine");
        set_status::<S>(&app, "noengine");
        return;
    };
    if !model.exists() {
        eprintln!("[{label}] model not found at {} -> status none", model.display());
        set_status::<S>(&app, "none");
        return;
    }

    set_status::<S>(&app, "starting");

    // One spawn at a time, from the VRAM measurement to the first answer.
    // Poisoning is recovered from rather than propagated: a panic in some other
    // spawn must not make every later spawn panic too.
    let _spawn_lock = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match app.state::<S>().status().lock().unwrap().as_str() {
        "none" => {
            // aux_model_stop ran while we were queued behind another spawn. Its
            // kill found no child because we had not spawned one yet, so honour
            // the stop here rather than leaving a server nobody asked for.
            eprintln!("[{label}] stopped while waiting for the spawn lock -> not spawning");
            return;
        }
        "swapping" => {
            // The other server took the card while we were queued (swap_out).
            // Spawning now would take it straight back off a model that has
            // only just finished loading, and the two would trade it for as
            // long as both had a spawn pending. The last writer wins instead.
            eprintln!("[{label}] handed the GPU over while queued -> not spawning");
            return;
        }
        _ => {}
    }

    let ctx = S::ctx();
    let meta = GgufMeta::read(&model);
    if meta.is_none() {
        eprintln!(
            "[{label}] GGUF header at {} could not be read -> falling back to the {} MiB VRAM floor",
            model.display(),
            S::MIN_VRAM_MIB
        );
    }

    // System RAM gate, applied before anything is measured because it is not
    // about this machine's card at all.
    //
    // The old wording justified it with «in every configuration this app
    // produces, the aux model's experts live in system RAM». That stopped
    // being true when --cpu-moe stopped being the default (moe_plan): on this
    // hardware, with the other server stopped, the experts stay on the GPU.
    // The gate survives unchanged anyway, because it guards the machines where
    // that is NOT true — a card too small to hold the expert set pushes it
    // into system RAM as a working set touched on every decoded token, and a
    // 16 GB machine thrashes rather than fails. Apple Silicon reaches the same
    // requirement from the other end: one shared pool, so the weights are in
    // system RAM by definition.
    if S::MIN_RAM_MIB > 0 {
        match total_ram_mib() {
            Some(total) if total < S::MIN_RAM_MIB => {
                eprintln!(
                    "[{label}] system RAM {total} MiB < the {} MiB this model's expert tensors need",
                    S::MIN_RAM_MIB
                );
                eprintln!("[{label}] -> status nomem: it would thrash rather than fail, so it is refused");
                set_status::<S>(&app, "nomem");
                return;
            }
            Some(total) => {
                eprintln!("[{label}] system RAM {total} MiB (>= {} MiB required)", S::MIN_RAM_MIB)
            }
            None => eprintln!("[{label}] system RAM unknown -> proceeding without the RAM gate"),
        }
    }

    // Stop the other server, then measure. Every number plan_spawn works from
    // is read off the live machine, so the card has to be in the state this
    // spawn will actually run in — that is what makes the layer budget and the
    // MoE plan a budget for the WHOLE card rather than for whatever the other
    // model left over.
    //
    // Placed here rather than at the top of the spawn on purpose: everything
    // above can still refuse (no engine, no weights, too little RAM, a stop
    // that arrived while we queued), and a refusal that has already taken the
    // other server down leaves the machine with nothing running at all.
    S::handover(&app);

    let (offload, moe) = plan_spawn::<S>(&exe, meta.as_ref(), ctx);

    let mut cmd = Command::new(&exe);
    cmd.arg("-m")
        .arg(&model)
        .arg("--port")
        .arg(S::PORT.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        // -c is the TOTAL and llama-server divides it by --parallel: it
        // answers this pair with `n_slots = 8, n_ctx_slot = 3072` for -c 24576
        // --parallel 8. (Measured; and it prints `kv_unified = 'false'` there,
        // which does not change the arithmetic — see LlamaSrv::CTX_PER_SLOT
        // for the verbatim line and for the comment it corrects.) Sizing -c
        // per slot and passing that number is the mistake this pair of flags
        // exists to make impossible.
        .arg("-c")
        .arg(ctx.to_string())
        .arg("--parallel")
        .arg(S::PARALLEL.to_string())
        // Flash attention. Mathematically exact — it reorders the softmax, it
        // does not approximate it — so nothing about the output changes, and
        // it keeps the attention scratch out of the compute buffer, which is
        // what makes a KV cache this size affordable at these slot counts.
        .arg("-fa")
        .arg("on")
        // NOT --swa-full, and that is a decision rather than an omission.
        // Both models attend through a 1024-token sliding window, and
        // llama.cpp's default already exploits it: local layers get a cache
        // sized by the window instead of by -c. --swa-full would throw that
        // away and charge every layer the full 24576/16384 cells, which is
        // several GiB of KV bought for nothing. GgufMeta::swa_split budgets
        // the same way for the same reason.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Not null any more: this pipe is the only place llama.cpp says WHY it
        // failed. It must be drained (see below) or the child blocks once the
        // pipe buffer fills.
        .stderr(Stdio::piped());
    match &offload {
        Offload::Device { id, ngl, .. } => {
            cmd.arg("-ngl").arg(ngl.to_string()).arg("--device").arg(id);
        }
        Offload::All => {
            cmd.arg("-ngl").arg("99");
        }
        Offload::Cpu => {} // omit -ngl entirely
    }
    for a in moe.args() {
        cmd.arg(a);
    }
    platform::quiet(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[{label}] failed to spawn llama-server: {e} -> status dead");
            set_status::<S>(&app, "dead");
            return;
        }
    };
    let pid = child.id();
    eprintln!(
        "[{label}] spawned llama-server pid {pid} on port {} -c {ctx} --parallel {} (offload: {})",
        S::PORT,
        S::PARALLEL,
        match &offload {
            Offload::Device { id, free_mib, ngl } =>
                format!("{id}, -ngl {ngl}, {} free", free_str(*free_mib)),
            Offload::All => "all layers, default device".into(),
            Offload::Cpu => "CPU".into(),
        }
    );
    let stderr = child.stderr.take();
    {
        let state = app.state::<S>();
        state.log().lock().unwrap().clear();
        *state.child().lock().unwrap() = Some(child);
    }
    if let Some(pipe) = stderr {
        let handle = app.clone();
        std::thread::spawn(move || drain_stderr::<S>(handle, pipe, pid));
    }

    // Poll until the HTTP port answers (model load can take a while).
    for _ in 0..S::BOOT_POLLS {
        std::thread::sleep(Duration::from_millis(500));
        {
            let state = app.state::<S>();
            let mut guard = state.child().lock().unwrap();
            if let Some(c) = guard.as_mut() {
                if let Ok(Some(code)) = c.try_wait() {
                    eprintln!(
                        "[{label}] llama-server pid {pid} exited early ({code}) -> status {}",
                        S::CRASHED
                    );
                    drop(guard);
                    set_status::<S>(&app, S::CRASHED);
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
    eprintln!(
        "[{label}] llama-server pid {pid} did not answer within {}s -> status dead",
        S::BOOT_POLLS / 2
    );
    set_status::<S>(&app, "dead");
}

/// Drain a spawned llama-server's stderr into the ring buffer and a log file.
///
/// Two reasons this thread exists. The pipe must be read or the child blocks
/// once its buffer fills — that alone forces the loop. And the content is the
/// only diagnosis available for a resource failure: a VRAM allocation the
/// driver refused prints there, then the process exits, and without this the
/// user saw one word ("dead") and no way to tell an OOM from a missing file.
/// The file is truncated per spawn, so it is always the CURRENT attempt and
/// never grows.
fn drain_stderr<S: LlamaSrv>(app: tauri::AppHandle, pipe: std::process::ChildStderr, pid: u32) {
    /// Enough to hold llama.cpp's whole load banner plus the failure at the end.
    const KEEP: usize = 200;
    let mut file = app.path().app_data_dir().ok().and_then(|d| {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(d.join(format!("llama-{}.log", S::LABEL)))
            .ok()
    });
    for line in BufReader::new(pipe).lines().map_while(Result::ok) {
        if let Some(f) = file.as_mut() {
            let _ = writeln!(f, "{line}");
        }
        let state = app.state::<S>();
        let mut ring = state.log().lock().unwrap();
        if ring.len() >= KEEP {
            ring.remove(0);
        }
        ring.push(line);
    }
    eprintln!("[{}] stderr of pid {pid} closed", S::LABEL);
}

/// The tail of a spawned llama-server's stderr ("main" | "aux"), for the model
/// surfaces to show when a status is "crashed" or "dead". Empty for an
/// external server we merely reused — we never owned its output.
#[tauri::command]
fn llama_log(app: tauri::AppHandle, model: String) -> Result<Vec<String>, String> {
    const TAIL: usize = 40;
    fn tail<S: LlamaSrv>(app: &tauri::AppHandle) -> Vec<String> {
        let state = app.state::<S>();
        let ring = state.log().lock().unwrap();
        ring[ring.len().saturating_sub(TAIL)..].to_vec()
    }
    match model.as_str() {
        "main" => Ok(tail::<TranslationState>(&app)),
        "aux" => Ok(tail::<AuxState>(&app)),
        _ => Err(format!("unknown model: {model}")),
    }
}

/// Re-derive the aux status: a spawned child that exited => AuxState::CRASHED;
/// an external instance whose port stopped answering => "dead".
fn refresh_aux_status(state: &AuxState) -> String {
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                // Same distinction init_llama_server draws: a process of ours
                // that died is not the same event as a port that never
                // answered, and only one of the two means «no weights».
                *state.status.lock().unwrap() = AuxState::CRASHED.into();
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
///
/// It also refuses while the aux model is leased — see the `AuxState::in_use`
/// arm below, which is the third case of «nothing is spawned and the current
/// status returns» and the only one that is about the card rather than about
/// this server.
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
        // A held aux lease means this respawn cannot have the GPU, so it must
        // not happen at all. This REVERSES the previous decision here, which
        // let "swapping" fall through to the respawn on the reasoning that the
        // spawn's own handover would take the card back «unless something is
        // mid-generation against it». That last clause is exactly the case
        // this arm exists for, and what the fall-through actually did in it:
        // swap_out declines to evict a leased aux server (AuxState::in_use
        // says at length why, and that rule stays), plan_spawn then measures
        // the card with ~13.6 GB of aux weights resident, layer_budget answers
        // ngl 0, and the draft server is spawned ON THE CPU — under the status
        // "spawned", which reads as success everywhere in the frontend. Worse,
        // "spawned" is not "swapping", so restore_after_handover can never
        // find it again: the translator stayed on the CPU until the app was
        // restarted, with nothing on screen saying so.
        //
        // Refusing instead is not a refusal of the reader's intent, because
        // the status left behind IS the intent. "swapping" says «the other
        // model has the card», which is true whatever this server's previous
        // status was, and it is the one status restore_after_handover acts on:
        // the last lease going (aux_model_stop, aux_lease_reset) brings the
        // draft server back with the whole card to itself, without a second
        // press. That is why the status is overwritten here rather than simply
        // returned — returning "dead" would drop the press on the floor and
        // nothing would ever restore the server.
        //
        // The one cost is a transient wrong word: a press made while the
        // weights are missing or llama.cpp is not installed also lands on
        // "swapping" and shows «освобождаю видеопамять» instead of «модель не
        // скачана» — until the lease drops, when init_llama_server re-derives
        // "none"/"noengine" from the machine and the right word comes back. A
        // word that corrects itself is worth more than a press that is lost.
        _ if AuxState::in_use(&app) => {
            // A stored child here is a dead one — a live child means
            // "starting"/"spawned", both handled above — so reap it rather
            // than leaving a zombie behind for the restore to trip over.
            if let Some(mut old) = state.child.lock().unwrap().take() {
                let _ = old.kill();
                let _ = old.wait();
            }
            eprintln!(
                "[translation] restart refused: the aux model is leased and cannot be evicted"
            );
            eprintln!("[translation] -> status swapping; restore_after_handover respawns us when the lease drops");
            *state.status.lock().unwrap() = "swapping".into();
            "swapping".into()
        }
        // Everything else respawns, "swapping" included: with no lease held,
        // the spawn's handover really does take the card back, and that is the
        // reader asking for the draft server. restore_after_handover does the
        // same thing automatically when the borrower is finished.
        _ => {
            // Reap a dead child if one is still stored, then respawn.
            //
            // "a dead child" is the usual case and not the only one: the poll
            // loop stamps "dead" after BOOT_POLLS WITHOUT killing the process,
            // so a server that is merely slow to answer is still holding its
            // allocation when we reap it here. That is the same hazard
            // restore_after_handover pays GPU_SETTLE for — kill() and wait()
            // say the OS reaped the process, never that the driver gave the
            // VRAM back — and the cost of skipping it is identical: the spawn
            // measures the card too early, layer_budget cuts -ngl to fit VRAM
            // that is about to be free, and the model lands on the CPU with
            // status "spawned", which nothing later restores.
            let reaped = if let Some(mut old) = state.child.lock().unwrap().take() {
                let _ = old.kill();
                let _ = old.wait();
                true
            } else {
                false
            };
            *state.status.lock().unwrap() = "starting".into();
            let handle = app.clone();
            std::thread::spawn(move || {
                // On the load thread, so the IPC call returns at once and the
                // pause disappears into a model load measured in seconds.
                if reaped {
                    std::thread::sleep(GPU_SETTLE);
                }
                init_llama_server::<TranslationState>(handle)
            });
            "starting".into()
        }
    }
}

impl AuxState {
    /// Drop every lease. Called when the child is gone (the leases describe a
    /// live process) and by aux_lease_reset when the page that took them is.
    fn drop_owners(&self) {
        let mut owners = self.owners.lock().unwrap();
        if !owners.is_empty() {
            let mut names: Vec<&str> = owners.iter().map(String::as_str).collect();
            names.sort_unstable();
            eprintln!("[aux] dropping {} lease(s): {}", names.len(), names.join(", "));
            owners.clear();
        }
    }
    fn clear_owners(app: &tauri::AppHandle) {
        app.state::<AuxState>().drop_owners();
    }
    /// Kill the child WE spawned, if any. An external instance (user-run, on
    /// the same port) is left alone — we never started it and must not stop it.
    fn kill_spawned_child(&self) {
        let taken = self.child.lock().unwrap().take();
        if let Some(mut child) = taken {
            eprintln!("[aux] stop -> killing spawned llama-server pid {}", child.id());
            let _ = child.kill();
            let _ = child.wait();
            *self.status.lock().unwrap() = "none".into();
        } else {
            let mut status = self.status.lock().unwrap();
            if status.as_str() != "external" {
                *status = "none".into();
            }
        }
    }
}

/// Start the aux llama-server on port 11545 and take a lease on it for
/// `owner`. Returns immediately; poll aux_model_status for progress.
/// Idempotent: if already starting/up/external, no second spawn happens and
/// the current status is returned.
///
/// `owner` is one of "glossary", "graph", "style:<bookPath>". Three
/// independent passes now share these weights, and each one used to end with
/// an unconditional stop (GlossaryPanel.tsx:699, :777, graphgen.ts:2449) that
/// killed the server out from under whoever else was mid-generation. That was
/// a rare race while every pass took seconds; with a style pass holding the
/// server for hours it is a certainty the first time the reader opens the
/// Terms tab. A set of names rather than a counter, so a repeated start from
/// the same owner replaces its entry instead of leaking a count for ever.
///
/// **A lease is meant to be held across a whole batch of work, not taken and
/// released around each item.** That is now a cost, not a preference: with the
/// GPU handover in place every take stops the draft server and every release
/// respawns it, so a knowledge-graph scan that leased "graph" per book paid
/// 2N model loads — N of 13.6 GB and N of 7.3 GB — for N books it could have
/// run under one lease. This command is built for that shape and needs no
/// change to support it:
///
///  - calling it repeatedly with the same owner is cheap and idempotent. The
///    name is re-inserted into a set, the status is re-derived, and while the
///    server is "starting"/"up"/"external" nothing is spawned. So a background
///    queue may still call it before every item — which is what recovers it if
///    the server crashed midway — without paying for a reload.
///  - it is aux_model_stop that costs a model load, because the last lease
///    going is what kills the server. A queue therefore calls stop ONCE, when
///    the whole queue is finished, and never between items.
///
/// The alternative considered and rejected was a second kind of lease that
/// declines to evict the draft server, so background work would run at reduced
/// offload beside it. It is strictly worse here: it still reloads the aux
/// weights once per item (N loads instead of 2N), and «reduced offload» for a
/// 13.6 GB model on a 16 GB card that is already holding the draft model means
/// the expert set in DDR5 — the configuration moe_plan exists to avoid.
#[tauri::command]
fn aux_model_start(app: tauri::AppHandle, state: tauri::State<'_, AuxState>, owner: String) -> String {
    {
        // Taken FIRST: between the refresh below and the spawn there is a
        // window in which another owner's stop must already see us.
        let mut owners = state.owners.lock().unwrap();
        owners.insert(owner.clone());
        eprintln!("[aux] lease taken by {owner}, {} held", owners.len());
    }
    let current = refresh_aux_status(&state);
    match current.as_str() {
        "starting" | "up" | "external" => current,
        // "swapping" lands in the respawn arm: it means the draft server's own
        // spawn evicted these weights while nobody held a lease, and somebody
        // now wants them back. The spawn hands the card over in the other
        // direction (AuxState::handover) before it measures anything.
        _ => {
            // Reap a dead child if one is still stored, then respawn. The
            // settle is here for the same reason as in restart_translation's
            // arm above: a "dead" status can mean «did not answer in time»
            // rather than «exited», so the process we reap may still be holding
            // the card when the respawn measures it.
            let reaped = if let Some(mut old) = state.child.lock().unwrap().take() {
                let _ = old.kill();
                let _ = old.wait();
                true
            } else {
                false
            };
            *state.status.lock().unwrap() = "starting".into();
            let handle = app.clone();
            std::thread::spawn(move || {
                if reaped {
                    std::thread::sleep(GPU_SETTLE);
                }
                init_llama_server::<AuxState>(handle)
            });
            "starting".into()
        }
    }
}

/// Release `owner`'s lease and, if it was the last one, stop the aux
/// llama-server if WE spawned it (an external instance is left untouched).
/// Safe to call when nothing is running and with a name that never took a
/// lease — removing something that is not there is a no-op, which is what the
/// three unconditional `finally` stops in the frontend need.
///
/// The last lease going is also the moment the GPU comes back: if the draft
/// server is sitting in "swapping" it was stopped to make room for these
/// weights, and there is now nothing in the way of restoring it.
///
/// Which is why this is the expensive half of the pair and aux_model_start is
/// the cheap one. Dropping the last lease costs 13.6 GB unloaded here plus
/// 7.3 GB loaded there, and taking it again costs the reverse. A caller that
/// works through a queue of items calls this ONCE, after the last item — see
/// aux_model_start for the whole contract.
#[tauri::command]
fn aux_model_stop(app: tauri::AppHandle, state: tauri::State<'_, AuxState>, owner: String) {
    {
        let mut owners = state.owners.lock().unwrap();
        owners.remove(&owner);
        if !owners.is_empty() {
            eprintln!(
                "[aux] lease released by {owner}, {} still held -> server stays up",
                owners.len()
            );
            return;
        }
    }
    state.kill_spawned_child();
    restore_after_handover(&app);
}

/// Drop every lease and stop the aux server. The frontend calls this ONCE on
/// load, beside its other bootstrap probes.
///
/// Without it the lease leaks across a webview reload. Every owner is in-page
/// JavaScript — a run manager that starts empty on a fresh page — so if the
/// webview reloads or crashes while a style pass holds "style:<bookPath>",
/// nothing in the new page ever removes that name. The set never empties
/// again, every later stop is a no-op, and 14.2 GB of weights stay resident
/// until the app exits. The unconditional kill this replaced was wrong but at
/// least self-healing; a lease has to be given the same property explicitly.
///
/// Killing (rather than only clearing) is deliberate for the same reason: a
/// fresh page means no in-page run can still be using the server, so anything
/// still alive is an orphan of the page that went away.
#[tauri::command]
fn aux_lease_reset(app: tauri::AppHandle, state: tauri::State<'_, AuxState>) {
    state.drop_owners();
    state.kill_spawned_child();
    // Same reasoning as aux_model_stop: whatever borrowed the card is gone
    // with the page that borrowed it, so a draft server left in "swapping"
    // should come back. On a normal load this is a no-op — the draft server is
    // "starting" or "spawned" and was never swapped out.
    restore_after_handover(&app);
}

/// "none" | "external" | "starting" | "up" | "swapping" | "nomem" | "crashed"
/// | "dead".
///
/// "nomem", "crashed" and "dead" are terminal and none of them means «the
/// weights are missing» — that is "none" and only "none". A caller that polls
/// this must treat "nomem" and "crashed" as ends of the wait, or it will spin
/// to its own deadline against a server that is never coming up.
///
/// "swapping" is NOT terminal and is not a failure: the draft server took the
/// card back while nothing held a lease here (swap_out). A caller that wants
/// these weights calls aux_model_start, which spawns from that state and takes
/// the card back in the other direction.
#[tauri::command]
fn aux_model_status(state: tauri::State<'_, AuxState>) -> String {
    refresh_aux_status(&state)
}

/// The slot geometry of both servers, so the frontend's request pools are
/// derived from the spawn instead of repeating its numbers.
///
/// translate.ts sizes one limiter per server and every prompt clip in the file
/// is priced against one slot's context — `n_ctx_slot`, which is `-c` divided
/// by `--parallel` and is what CTX_PER_SLOT states. Both used to be bare
/// literals with a comment naming llama-server's default of 4 — which was
/// true only for as long as this file passed no `--parallel` at all. Now that
/// it does, two numbers in two languages have to agree, and the only way they
/// agree for certain is if one of them is read from the other.
///
/// Serialised as snake_case, the way host_info already is (src/host.ts maps
/// the wire shape to camelCase at the boundary).
#[derive(serde::Serialize)]
struct LlamaSlots {
    /// `--parallel` on 11544, and each slot's share of that server's `-c`.
    main_parallel: u32,
    main_ctx_per_slot: u32,
    /// The same pair for 11545.
    aux_parallel: u32,
    aux_ctx_per_slot: u32,
}

#[tauri::command]
fn llama_slots() -> LlamaSlots {
    LlamaSlots {
        main_parallel: TranslationState::PARALLEL,
        main_ctx_per_slot: TranslationState::CTX_PER_SLOT,
        aux_parallel: AuxState::PARALLEL,
        aux_ctx_per_slot: AuxState::CTX_PER_SLOT,
    }
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

/// Resolve the Claude Code CLI. The native installer puts it in
/// `~/.local/bin` on every platform; Homebrew and WinGet put it on the PATH.
/// If none of those has it, fall back to the bare name so the spawn error is
/// the familiar "not found" rather than a path we invented.
fn claude_exe_path() -> PathBuf {
    platform::claude_cli()
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "claude.exe" } else { "claude" }))
}

/// What the «Ask» onboarding step needs: is the Claude Code CLI installed,
/// where, and which version. Probing costs a process spawn, so this is a
/// command the UI calls on demand rather than a poll.
#[derive(serde::Serialize)]
struct ClaudeStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
async fn claude_status() -> Result<ClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(|| match platform::claude_cli() {
        Some(exe) => ClaudeStatus {
            installed: true,
            version: platform::probe_version(&exe),
            path: Some(exe.display().to_string()),
        },
        None => ClaudeStatus { installed: false, path: None, version: None },
    })
    .await
    .map_err(|e| format!("claude_status task failed: {e}"))
}

/// Host facts the frontend cannot get on its own and that decide what it
/// shows: which install command to print, whether the shortcut hints say Cmd
/// or Ctrl, and whether PDF export exists on this platform at all.
#[derive(serde::Serialize)]
struct HostInfo {
    /// "windows" | "macos" | "linux"
    os: String,
    pdf_export: bool,
    version: String,
}

#[tauri::command]
fn host_info() -> HostInfo {
    HostInfo {
        os: if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
        .into(),
        pdf_export: print::SUPPORTED,
        version: env!("CARGO_PKG_VERSION").into(),
    }
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
    tools: Option<String>,
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
        // The empty string is the default and stays the default: «Спросить»
        // answers out of the book, so the CLI is given no tool to reach the
        // machine with. Anything else in here got there because the reader
        // typed it into Settings and can read it back — a deliberate,
        // visible choice. The flag itself is never dropped: an absent
        // --allowedTools means "whatever Claude Code decides", which is not
        // the same promise as an empty allow-list.
        let allowed = tools.as_deref().unwrap_or("");
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages")
            .arg("--allowedTools")
            .arg(allowed);
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
        platform::quiet(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("claude_not_found: {}", exe.display())
            } else {
                format!("spawn_failed: {e}")
            }
        })?;
        eprintln!("[ask] spawned claude pid {}", child.id());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        inner.generation += 1;
        let my_gen = inner.generation;
        inner.child = Some(child);
        (my_gen, stdin, stdout, stderr)
    };

    // Write the prompt on its own thread (avoids pipe deadlock on large
    // prompts), then close stdin so the CLI starts the turn.
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
            ("cancelled".to_string(), String::new())
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
                exit_desc.clone()
            } else {
                format!("{exit_desc}: {tail}")
            };
            ("error_process".to_string(), msg)
        };
        // `result` carries only the raw process detail (possibly empty): the
        // sentence the user reads is composed in the frontend, in the
        // interface language. Nothing user-facing is worded here.
        let synth = serde_json::json!({
            "type": "result",
            "subtype": subtype,
            "is_error": true,
            "result": msg,
            "synthetic": true,
        });
        let _ = on_event.send(synth.to_string());
    } else if !exit_desc.is_empty() && !cancelled {
        eprintln!("[ask] claude non-zero exit after result line: {exit_desc}");
    }
    Ok(())
}

/// Ask Claude (headless CLI) with streaming NDJSON forwarded over `on_event`.
/// Resolves when the process exits (every stream already got a terminal
/// result line by then). Errors: "busy: ...", "claude_not_found: <path>",
/// "spawn_failed: <err>". `tools` is the value for --allowedTools and defaults
/// to the empty string when absent.
#[tauri::command]
async fn ask_claude(
    app: tauri::AppHandle,
    prompt: String,
    session_id: Option<String>,
    system_prompt: Option<String>,
    on_event: tauri::ipc::Channel<String>,
    tools: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_ask(app, prompt, session_id, system_prompt, tools, on_event)
    })
    .await
    .map_err(|e| format!("ask task failed: {e}"))?
}

/// Kill the in-flight claude process, if any. The streaming ask_claude call then
/// finishes with a synthetic {"type":"result","subtype":"cancelled"} line.
#[tauri::command]
fn ask_claude_cancel(state: tauri::State<'_, AskState>) {
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[ask] cancel -> killing claude pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn kill_ask_child(app: &tauri::AppHandle) {
    let state = app.state::<AskState>();
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[ask] app exit -> killing claude pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---------------------------------------------------------------------------
// One-shot Claude calls for the knowledge graph.
//
// This is the same machinery as the ask path with its own child slot, and the
// separate slot is the entire point. A graph build walks the whole library:
// forty articles is forty prompts, each of them minutes long. If those calls
// shared AskState, the reader's own question would be answered "busy" by a
// background job they never asked to wait for — so nothing below ever reads or
// locks AskState, and the two can run at the same time.
//
// No session and no --resume either. Each shard is built from one prompt about
// one book, so remembering the previous conversation would buy nothing and risk
// the worst possible failure here: the last book's concepts leaking into this
// book's shard. Streaming is dropped for the same reason — the caller wants a
// finished answer to parse, and a graph build has nobody watching it type.
// ---------------------------------------------------------------------------

/// How long one graph call may run before the queue behind it matters more
/// than its answer. A single-book prompt lands in well under a minute; three
/// minutes means the child is wedged rather than slow (a stalled network read,
/// a CLI waiting on something that will never arrive). Because the queue is
/// serial, one wedged child would hold up every book behind it, so the number
/// is deliberately generous for a real answer and still short enough that a
/// library of forty cannot be stopped by one of them.
const GRAPH_TIMEOUT: Duration = Duration::from_secs(180);

/// How often the wait loop looks at the child. Polling instead of a blocking
/// `wait()` is what makes the deadline enforceable at all — and it is also what
/// keeps `graph_claude_cancel` able to take the child, since the loop lets go
/// of the lock between looks.
const GRAPH_POLL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct GraphAskInner {
    /// The running claude child of a graph call, if one is in flight.
    child: Option<Child>,
    /// Generation counter, mirroring AskInner for the same reason: a call whose
    /// child was cancelled must never reap the child of the call that replaced
    /// it in the slot.
    generation: u64,
}

#[derive(Default)]
struct GraphAskState {
    inner: Mutex<GraphAskInner>,
}

/// How the wait loop below ended. Named rather than a tuple of flags because
/// three of the four outcomes are failures that read differently to the caller.
enum GraphEnd {
    Exited(ExitStatus),
    /// The slot stopped being ours: cancelled by hand, or by app teardown.
    Cancelled,
    TimedOut,
    WaitFailed(String),
}

/// Blocking body of graph_claude: spawn claude.exe, pipe the prompt via stdin,
/// collect stdout whole, and enforce GRAPH_TIMEOUT on the way.
fn run_graph_claude(
    app: tauri::AppHandle,
    prompt: String,
    system_prompt: Option<String>,
) -> Result<String, String> {
    let state = app.state::<GraphAskState>();

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
                _ => return Err("busy".into()),
            }
        }

        let exe = claude_exe_path();
        let mut cmd = Command::new(&exe);
        // Plain text, empty allow-list: the answer is parsed by graphgen.ts and
        // written to a shard by the frontend, so the CLI has no business
        // touching the disk on its own.
        cmd.arg("-p")
            .arg("--output-format")
            .arg("text")
            .arg("--allowedTools")
            .arg("");
        if let Some(sp) = system_prompt.as_deref() {
            if !sp.is_empty() {
                cmd.arg("--append-system-prompt").arg(sp);
            }
        }
        // The same cwd as every other claude call: a graph run must not scatter
        // CLI state into a directory the ask path does not know about.
        if let Some(dir) = ask_cwd(&app) {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        platform::quiet(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("claude_not_found: {}", exe.display())
            } else {
                format!("spawn_failed: {e}")
            }
        })?;
        eprintln!("[graph] spawned claude pid {}", child.id());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        inner.generation += 1;
        let my_gen = inner.generation;
        inner.child = Some(child);
        (my_gen, stdin, stdout, stderr)
    };

    // Write the prompt on its own thread (a page of book text is far larger
    // than a pipe buffer, and writing it inline would deadlock against a child
    // that has not started reading), then close stdin to start the turn.
    if let Some(mut si) = stdin {
        std::thread::spawn(move || {
            let _ = si.write_all(prompt.as_bytes());
            // drop closes the pipe
        });
    }

    // Both pipes are drained on their own threads: either one filling up would
    // block the child forever, and a blocked child cannot be told apart from a
    // wedged one.
    let stdout_thread = stdout.map(|mut so| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = so.read_to_string(&mut buf);
            buf
        })
    });
    let stderr_thread = stderr.map(|mut se| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = se.read_to_string(&mut buf);
            buf
        })
    });

    let deadline = Instant::now() + GRAPH_TIMEOUT;
    let end = loop {
        {
            let mut inner = state.inner.lock().unwrap();
            // Only reap what is still OURS (same generation): if the slot was
            // emptied or refilled meanwhile, that child belongs to someone else.
            if inner.generation != my_gen || inner.child.is_none() {
                break GraphEnd::Cancelled;
            }
            match inner.child.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(st))) => {
                    if let Some(mut done) = inner.child.take() {
                        let _ = done.wait();
                    }
                    break GraphEnd::Exited(st);
                }
                Some(Err(e)) => {
                    let _ = inner.child.take();
                    break GraphEnd::WaitFailed(e.to_string());
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                if let Some(mut wedged) = inner.child.take() {
                    eprintln!("[graph] timeout -> killing claude pid {}", wedged.id());
                    let _ = wedged.kill();
                    let _ = wedged.wait();
                }
                break GraphEnd::TimedOut;
            }
        }
        std::thread::sleep(GRAPH_POLL);
    };

    // Killing the child closes both pipes, so these joins cannot outlive it.
    let out = stdout_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    let err = stderr_thread.and_then(|t| t.join().ok()).unwrap_or_default();

    match end {
        GraphEnd::Exited(st) if st.success() => Ok(out.trim().to_string()),
        GraphEnd::Exited(st) => {
            // Raw machine detail only, exactly as the ask path does it: the
            // sentence the reader sees is worded in the frontend, in the
            // interface language. The stderr tail is what makes a broken
            // install debuggable, so it is carried, bounded.
            let tail: String = {
                let t = err.trim();
                let chars: Vec<char> = t.chars().collect();
                if chars.len() > 600 {
                    chars[chars.len() - 600..].iter().collect()
                } else {
                    t.to_string()
                }
            };
            if tail.is_empty() {
                Err(format!("claude_failed: {st}"))
            } else {
                Err(format!("claude_failed: {st}: {tail}"))
            }
        }
        GraphEnd::TimedOut => Err("timeout".into()),
        GraphEnd::Cancelled => Err("cancelled".into()),
        GraphEnd::WaitFailed(e) => Err(format!("wait_failed: {e}")),
    }
}

/// One-shot Claude call for the graph builder: no session, no streaming, and no
/// state shared with «Спросить», so a background build over a whole library can
/// never make the reader's own question answer "busy". Resolves with the
/// trimmed stdout. Errors are raw machine detail — "busy", "timeout",
/// "cancelled", "claude_not_found: <path>", "spawn_failed: <err>",
/// "claude_failed: <status>: <stderr tail>" — worded by the frontend.
#[tauri::command]
async fn graph_claude(
    app: tauri::AppHandle,
    state: tauri::State<'_, GraphAskState>,
    prompt: String,
    system_prompt: Option<String>,
) -> Result<String, String> {
    // Cheap refusal before the thread hop. The check that actually decides is
    // the one inside run_graph_claude, taken under the same lock as the spawn;
    // this one only spares the queue a pointless blocking task when it already
    // has a call in flight.
    {
        let mut inner = state.inner.lock().unwrap();
        if let Some(c) = inner.child.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Err("busy".into());
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || run_graph_claude(app, prompt, system_prompt))
        .await
        .map_err(|e| format!("graph task failed: {e}"))?
}

/// Kill the in-flight graph call, if any. The pending graph_claude then
/// resolves with Err("cancelled").
#[tauri::command]
fn graph_claude_cancel(state: tauri::State<'_, GraphAskState>) {
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[graph] cancel -> killing claude pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn kill_graph_child(app: &tauri::AppHandle) {
    let state = app.state::<GraphAskState>();
    let taken = state.inner.lock().unwrap().child.take();
    if let Some(mut child) = taken {
        eprintln!("[graph] app exit -> killing claude pid {}", child.id());
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
    S::after_kill(app);
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

/// size + sha256 pinned from the HF metadata (lfs.oid) of the MIRROR repos
/// named below, not of the upstream ones.
///
/// The draft model's own repo, `google/translategemma-12b-it`, is gated behind
/// manual approval, and this downloader deliberately sends no token (there is
/// nowhere to put one and nothing to store it in), so the upstream path is not
/// reachable from here at all. A community mirror can re-upload under the same
/// path at any time, which would change the oid under a pin taken today — so
/// RELEASING re-verifies both numbers against the live metadata before a
/// release goes out. A mismatch surfaces as `checksum` and the poisoned .part
/// is deleted rather than resumed (do_download), which is the honest failure:
/// we refuse bytes we cannot vouch for instead of running them.
fn model_spec(key: &str) -> Option<ModelSpec> {
    match key {
        "main" => Some(ModelSpec {
            file: TranslationState::MODEL_FILE,
            url: "https://huggingface.co/bullerwins/translategemma-12b-it-GGUF/resolve/main/translategemma-12b-it-Q4_K_M.gguf",
            size: 7_300_793_664,
            sha256: "9196d728812afbf5efc10b539298585725edc3a4ecc092c22fdde5bbaf41879e",
        }),
        "aux" => Some(ModelSpec {
            file: AuxState::MODEL_FILE,
            url: "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF/resolve/main/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf",
            size: 14_249_047_104,
            sha256: "a7c5bc715f5ff8e99a3e8901ce7d2b42b402c669bf24f7c5250747633d0f5891",
        }),
        _ => None,
    }
}

/// The weights the pre-Gemma pipeline used. After the swap no code path names
/// either file: `model_spec` points elsewhere, `MODEL_FILE` points elsewhere,
/// and 7,2 GB of unreachable bytes sit in roaming AppData while the reader is
/// asked to download 21,5 GB more against a free-space check whose whole
/// margin is 300 MiB (DL_MARGIN).
///
/// They are OFFERED for deletion and never deleted for the reader. Those bytes
/// cost hours of bandwidth, a downgraded build would need them back, and this
/// app does not throw away a user's files to tidy its own directory. The sizes
/// are the pinned ones the old specs carried, kept so the UI can quote a total
/// before the files are stat'ed.
const LEGACY_MODELS: [(&str, u64); 2] = [
    ("HY-MT1.5-7B-Q4_K_M.gguf", 4_624_649_312),
    ("Qwen3.5-4B-Q4_K_M.gguf", 2_740_937_888),
];

/// One obsolete weights file. `present` is about the final file; an
/// interrupted download's `.part` is reported as its own row with its real
/// length, because that is what the disk is actually holding.
#[derive(serde::Serialize)]
struct LegacyModel {
    file: String,
    size: u64,
    present: bool,
}

/// Is this name pinned by a live spec right now? Nothing here may ever offer
/// to delete a model the app still uses, whatever the table says.
fn is_pinned(name: &str) -> bool {
    ["main", "aux"]
        .iter()
        .filter_map(|k| model_spec(k))
        .any(|s| name == s.file || name == format!("{}.part", s.file))
}

/// What obsolete weights are on disk (Settings → Модели, and the no-space
/// branch of the weights download, which is exactly when 7,2 GB of dead files
/// matter most).
#[tauri::command]
fn legacy_models_scan(app: tauri::AppHandle) -> Result<Vec<LegacyModel>, String> {
    let dir = resolve_models_dir(&app, None)?;
    let mut out = Vec::new();
    for (file, pinned_size) in LEGACY_MODELS {
        if is_pinned(file) {
            continue;
        }
        let path = dir.join(file);
        let meta = std::fs::metadata(&path).ok();
        out.push(LegacyModel {
            file: file.into(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(pinned_size),
            present: meta.is_some(),
        });
        let part = format!("{file}.part");
        if let Ok(m) = std::fs::metadata(dir.join(&part)) {
            out.push(LegacyModel { file: part, size: m.len(), present: true });
        }
    }
    Ok(out)
}

/// Delete obsolete weights the user asked to remove. Only names that are in
/// LEGACY_MODELS (or the `.part` of one) are touched; anything else is skipped
/// with a log line rather than an error, so a stale frontend list can never
/// turn this into a general file-removal command.
#[tauri::command]
fn legacy_models_delete(app: tauri::AppHandle, files: Vec<String>) -> Result<(), String> {
    let dir = resolve_models_dir(&app, None)?;
    for name in files {
        let known = LEGACY_MODELS
            .iter()
            .any(|(f, _)| name == *f || name == format!("{f}.part"));
        if !known || is_pinned(&name) {
            eprintln!("[models] refusing to delete {name}: not an obsolete weights file");
            continue;
        }
        let path = dir.join(&name);
        if !path.exists() {
            continue;
        }
        std::fs::remove_file(&path).map_err(|e| format!("io:{e}"))?;
        eprintln!("[models] deleted obsolete {}", path.display());
    }
    Ok(())
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
        if let Some(free) = platform::free_disk_space(dir) {
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
        {
            let mut status = state.status().lock().unwrap();
            if status.as_str() != "external" {
                *status = "none".into();
            }
        }
        S::after_kill(app);
    }
    // Exhaustive rather than a wildcard onto AuxState: model_spec already
    // rejected every other key above, so the wildcard was only ever reachable
    // for "aux" — but a third key added to model_spec later would silently
    // kill the aux server and delete someone else's file.
    match model.as_str() {
        "main" => stop_spawned::<TranslationState>(&app),
        "aux" => stop_spawned::<AuxState>(&app),
        _ => return Err(format!("unknown model: {model}")),
    }

    let _ = std::fs::remove_file(dir.join(format!("{}.part", spec.file)));
    let final_path = dir.join(spec.file);
    if final_path.exists() {
        std::fs::remove_file(&final_path).map_err(|e| format!("io:{e}"))?;
        eprintln!("[dl:{model}] deleted {}", final_path.display());
    }
    Ok(())
}


/// Kill only the children we spawned ourselves. An llama-server we merely
/// *reused* (external instance, already listening when we started) is not in
/// state.child and is deliberately left running. Idempotent: every kill takes
/// its child out of the state first, so calling this twice is a no-op.
fn kill_children(app: &tauri::AppHandle) {
    kill_spawned::<TranslationState>(app);
    kill_spawned::<AuxState>(app);
    kill_ask_child(app);
    kill_graph_child(app);
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
///     window vanishes but Chitallo.exe (and the llama-server it owns) linger with
///     nothing on screen — measured at 20s+ before the run was killed.
///
/// A busy webview is a third way to strand the same route: the JS handler
/// cannot run at all while the renderer is blocked.
///
/// So the X is owned here instead. Hide at once (the close looks instant), give
/// the frontend a short grace period to persist its position, then exit the app
/// — not just the window — whatever the webview is doing. If even the event
/// loop cannot service that exit, reap our children directly and leave, so no
/// orphan Chitallo.exe / llama-server.exe survives. destroy() stays permitted as
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
        .manage(GraphAskState::default())
        .manage(DownloadsState::default())
        .invoke_handler(tauri::generate_handler![
            host_info,
            engine_status,
            claude_status,
            translation_status,
            restart_translation,
            aux_model_start,
            aux_model_stop,
            aux_model_status,
            aux_lease_reset,
            llama_slots,
            llama_log,
            download_model,
            cancel_model_download,
            model_download_status,
            delete_model,
            legacy_models_scan,
            legacy_models_delete,
            ask_claude,
            ask_claude_cancel,
            graph_claude,
            graph_claude_cancel,
            print::print_html_to_pdf
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


