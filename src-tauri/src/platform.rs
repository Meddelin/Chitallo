//! Cross-platform bits: where the external binaries live, how much room is
//! left on the disk, and how to keep a child process from flashing a console.
//!
//! Chitallo bundles nothing (see README «Dependencies»): the inference engine and
//! the Claude Code CLI are installed by the user with one prescribed command
//! per platform. Everything here is therefore *discovery*, never installation
//! — the app locates a binary, or it reports honestly that the binary is
//! missing and shows the one command that installs it.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows: don't flash a console window for a child we spawn silently.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply the platform's "run this quietly" flags to a command.
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// The user's home directory, without pulling in a crate for it.
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Executable file name for `stem` on this platform.
fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn is_exe(p: &Path) -> bool {
    p.is_file()
}

/// `which`, without the crate: first hit for `name` across PATH.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| is_exe(p))
}

/// Directories that hold user-installed CLI tools but are not always on the
/// PATH *this process* inherited. A GUI app launched from Finder or the
/// Windows shell gets the login-time environment, which on macOS routinely
/// misses `/opt/homebrew/bin` (Homebrew puts it on the PATH from a shell
/// profile that a .app never sources).
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        #[cfg(windows)]
        dirs.push(home.join("AppData").join("Local").join("Microsoft").join("WinGet").join("Links"));
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin")); // Apple silicon
        dirs.push(PathBuf::from("/usr/local/bin")); // Intel
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

/// Resolve a user-installed CLI: an explicit override wins, then any extra
/// directory this process may not have on its PATH, then the PATH itself.
/// `None` means "not installed" — callers surface the install command.
fn resolve(stem: &str, env_override: &str, extra_first: &[PathBuf]) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(env_override) {
        let p = PathBuf::from(p);
        if is_exe(&p) {
            return Some(p);
        }
    }
    let name = exe_name(stem);
    for dir in extra_first {
        let p = dir.join(&name);
        if is_exe(&p) {
            return Some(p);
        }
    }
    for dir in extra_bin_dirs() {
        let p = dir.join(&name);
        if is_exe(&p) {
            return Some(p);
        }
    }
    which(&name)
}

/// `llama-server` from llama.cpp — the translation engine.
///
/// `app_llama_dir` is `<appData>/llama`, where a manual/dev install may drop
/// the binary next to its runtime libraries; it is searched first so a
/// hand-placed build always wins over whatever the package manager put on the
/// PATH.
pub fn llama_server(app_llama_dir: &Path) -> Option<PathBuf> {
    resolve("llama-server", "CHITALLO_LLAMA_SERVER", &[app_llama_dir.to_path_buf()])
}

/// The Claude Code CLI, used by the optional «Ask» sidebar.
pub fn claude_cli() -> Option<PathBuf> {
    resolve("claude", "CHITALLO_CLAUDE_BIN", &[])
}

/// `<binary> --version`, trimmed to its first line. `None` if the binary is
/// missing or answers nothing usable.
pub fn probe_version(exe: &Path) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    quiet(&mut cmd);
    let out = cmd.output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// Free bytes available to this user on the volume holding `dir` (which must
/// exist). `None` = unknown, and the caller skips its space check rather than
/// guessing.
#[cfg(windows)]
pub fn free_disk_space(dir: &Path) -> Option<u64> {
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

#[cfg(unix)]
pub fn free_disk_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs only reads through the NUL-terminated path we own, and
    // writes into a struct we allocated; the return code says whether it did.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut st) } != 0 {
        return None;
    }
    // f_bavail is what an unprivileged process may actually use (f_bfree
    // includes the root reserve). f_frsize is the fragment size the counts
    // are expressed in.
    let frag = if st.f_frsize > 0 { st.f_frsize as u64 } else { st.f_bsize as u64 };
    Some((st.f_bavail as u64).saturating_mul(frag))
}

#[cfg(not(any(windows, unix)))]
pub fn free_disk_space(_dir: &Path) -> Option<u64> {
    None
}
