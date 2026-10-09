//! PDF export: render a local HTML file to a paginated PDF, silently.
//!
//! Shared flow: a hidden WebviewWindow loads the export HTML; once the page
//! (including its data-URI images) fires the load event, the platform's own
//! print pipeline paginates it into <pdf_path> — no print dialog, no visible
//! window. The command resolves when that pipeline reports its outcome.
//!
//! Windows uses WebView2's `PrintToPdf`; macOS uses `NSPrintOperation` over
//! WKWebView with the job disposition set to "save to file". Both are the
//! native engine's own paginator, so the page breaks match what the user would
//! get from the system print dialog.
//!
//! The two platforms differ in how the HTML gets *in*. WebView2 navigates to a
//! `file://` URL directly. WKWebView refuses `file://` through a plain
//! `loadRequest` — it only accepts one through
//! `loadFileURL:allowingReadAccessToURL:`, which wry does not call — so on
//! macOS the window opens on `about:blank` and we drive that load ourselves
//! from the UI thread. Both then wait for the same signal: a page-load
//! "Finished" event whose URL is our file.
//!
//! Threading is the subtle part and is identical on both: the platform call
//! must happen on the UI thread (`with_webview` posts it there), and the UI
//! thread must stay free to pump its event loop, because that is what delivers
//! both the closure and the completion callback. So the command runs async,
//! and every wait happens on the blocking pool — never on the main thread.
//!
//! Teardown: the hidden window is destroyed on every exit path (success, setup
//! error, platform error, timeout). `drive_print` is the only thing between
//! window creation and the unconditional `destroy()` below it. If a timeout
//! fires while printing is still running, destroying the window tears down the
//! webview, which cancels the job; a completion callback that races the
//! teardown sends into a dropped Receiver and is ignored.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Is silent HTML→PDF printing implemented for this platform at all?
pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos"));

/// JS contract: invoke("print_html_to_pdf", { htmlPath, pdfPath,
///   pageWidthMm?, pageHeightMm?, marginMm? })
/// Defaults: A4 portrait (210×297 mm), 12 mm margins on all sides, scale 1.0,
/// backgrounds printed, no browser headers/footers. Both paths must be
/// absolute; the output directory is created if missing.
#[tauri::command]
pub async fn print_html_to_pdf(
    app: tauri::AppHandle,
    html_path: String,
    pdf_path: String,
    page_width_mm: Option<f64>,
    page_height_mm: Option<f64>,
    margin_mm: Option<f64>,
) -> Result<(), String> {
    if !SUPPORTED {
        return Err("pdf_unsupported".into());
    }
    let html = Path::new(&html_path);
    if !html.is_file() {
        return Err(format!("html file not found: {html_path}"));
    }
    // The load-finished signal is matched on this: the temp name carries a
    // timestamp, so it identifies exactly our navigation and survives whatever
    // percent-encoding the engine applies to the rest of the path.
    let html_name = html
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("html path has no file name")?;
    if !Path::new(&pdf_path).is_absolute() {
        return Err("pdf_path must be absolute".into());
    }
    if let Some(parent) = Path::new(&pdf_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output dir: {e}"))?;
        }
    }

    let page = Page {
        width_mm: page_width_mm.unwrap_or(210.0),
        height_mm: page_height_mm.unwrap_or(297.0),
        margin_mm: margin_mm.unwrap_or(12.0),
    };

    // Unique label per call: a lagging teardown of a previous export can never
    // collide with (and thus fail) the next one.
    static PRINT_SEQ: AtomicU64 = AtomicU64::new(0);
    let label = format!("pdf-print-{}", PRINT_SEQ.fetch_add(1, Ordering::Relaxed));

    let (load_tx, load_rx) = std::sync::mpsc::channel::<String>();
    let window = tauri::WebviewWindowBuilder::new(&app, &label, start_url(html)?)
        .title("Chitallo — PDF export")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(900.0, 1200.0)
        .on_page_load(move |_win, payload| {
            // Finished == the document's load event, which waits for <img>
            // decoding incl. data: URIs. The URL tells our navigation apart
            // from the placeholder one macOS starts on.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = load_tx.send(payload.url().to_string());
            }
        })
        .build()
        .map_err(|e| format!("failed to create hidden print window: {e}"))?;

    // From here the hidden window exists: whatever happens, destroy it.
    let result = drive_print(&window, &html_path, &html_name, &pdf_path, page, load_rx).await;
    let _ = window.destroy();
    result
}

/// Paper geometry in millimetres, as the frontend states it.
#[derive(Clone, Copy)]
struct Page {
    width_mm: f64,
    height_mm: f64,
    margin_mm: f64,
}

/// Where the hidden window opens. Windows goes straight to the file; macOS
/// starts blank because its webview will only take the file from a call we
/// make ourselves (see the module docs).
fn start_url(html: &Path) -> Result<tauri::WebviewUrl, String> {
    if cfg!(target_os = "macos") {
        return Ok(tauri::WebviewUrl::External(
            tauri::Url::parse("about:blank").expect("about:blank is a valid url"),
        ));
    }
    let url = tauri::Url::from_file_path(html).map_err(|_| {
        format!("cannot build a file:// url from {} (must be absolute)", html.display())
    })?;
    Ok(tauri::WebviewUrl::External(url))
}

// Everything below this point exists only where a print pipeline does.
#[cfg(any(windows, target_os = "macos"))]
mod imp {
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::{Duration, Instant};

    /// Big books arrive as one HTML file with many MB of data-URI images;
    /// parsing + decoding can be slow, hence the generous load budget.
    pub const LOAD_BUDGET: Duration = Duration::from_secs(120);
    pub const PRINT_BUDGET: Duration = Duration::from_secs(600);

    /// Wait for a channel message on the blocking pool so neither the async
    /// runtime nor the main thread stalls — the main thread must keep pumping
    /// its event loop, because that is what delivers the webview's callbacks.
    pub async fn recv_off_thread<T: Send + 'static>(
        rx: Receiver<T>,
        budget: Duration,
        what: &'static str,
    ) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(budget).map_err(|e| describe(e, budget, what))
        })
        .await
        .map_err(|e| format!("blocking task join: {e}"))?
    }

    /// Wait for the page-load event that belongs to *our* document, ignoring
    /// any earlier navigation (the `about:blank` the macOS window opens on).
    pub async fn await_page_load(
        rx: Receiver<String>,
        html_name: String,
        what: &'static str,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let deadline = Instant::now() + LOAD_BUDGET;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(describe(RecvTimeoutError::Timeout, LOAD_BUDGET, what));
                }
                match rx.recv_timeout(left) {
                    Ok(url) if url.contains(&html_name) => return Ok(()),
                    Ok(_) => continue, // a placeholder navigation — keep waiting
                    Err(e) => return Err(describe(e, LOAD_BUDGET, what)),
                }
            }
        })
        .await
        .map_err(|e| format!("blocking task join: {e}"))?
    }

    fn describe(e: RecvTimeoutError, budget: Duration, what: &str) -> String {
        match e {
            RecvTimeoutError::Timeout => {
                format!("timeout ({}s) waiting for {what}", budget.as_secs())
            }
            RecvTimeoutError::Disconnected => {
                format!("hidden print window died while waiting for {what}")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: WebView2 PrintToPdf
// ---------------------------------------------------------------------------

/// Everything between window creation and teardown, so the caller can
/// unconditionally destroy() no matter where this errors out.
#[cfg(windows)]
async fn drive_print(
    window: &tauri::WebviewWindow,
    _html_path: &str,
    html_name: &str,
    pdf_path: &str,
    page: Page,
    load_rx: std::sync::mpsc::Receiver<String>,
) -> Result<(), String> {
    const MM_PER_INCH: f64 = 25.4;
    let (page_w_in, page_h_in, margin_in) = (
        page.width_mm / MM_PER_INCH,
        page.height_mm / MM_PER_INCH,
        page.margin_mm / MM_PER_INCH,
    );

    imp::await_page_load(
        load_rx,
        html_name.to_string(),
        "page load in the hidden print window",
    )
    .await?;

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

    imp::recv_off_thread(done_rx, imp::PRINT_BUDGET, "PrintToPdf completion").await??;

    if !Path::new(pdf_path).is_file() {
        return Err("PrintToPdf reported success but no file appeared".into());
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// macOS: NSPrintOperation over WKWebView, job disposition = save to file
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
async fn drive_print(
    window: &tauri::WebviewWindow,
    html_path: &str,
    html_name: &str,
    pdf_path: &str,
    page: Page,
    load_rx: std::sync::mpsc::Receiver<String>,
) -> Result<(), String> {
    // The window opened on about:blank; hand WKWebView the file the only way
    // it accepts one, granting read access to the directory it sits in.
    let (html, dir) = {
        let p = Path::new(html_path);
        let dir = p
            .parent()
            .ok_or("html path has no parent directory")?
            .to_string_lossy()
            .into_owned();
        (html_path.to_string(), dir)
    };
    let (nav_tx, nav_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let _ = nav_tx.send(load_file_url(&wv, &html, &dir));
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    imp::recv_off_thread(nav_rx, imp::LOAD_BUDGET, "loadFileURL to be issued").await??;

    imp::await_page_load(
        load_rx,
        html_name.to_string(),
        "page load in the hidden print window",
    )
    .await?;

    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let pdf = pdf_path.to_string();
    window
        .with_webview(move |wv| {
            // Runs on the UI (main) thread — the only thread AppKit's print
            // machinery may be touched from. runOperation is synchronous once
            // both panels are suppressed, so the outcome is known right here.
            let _ = done_tx.send(run_print_operation(&wv, &pdf, page));
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    imp::recv_off_thread(done_rx, imp::PRINT_BUDGET, "NSPrintOperation completion").await??;

    if !Path::new(pdf_path).is_file() {
        return Err("NSPrintOperation reported success but no file appeared".into());
    }
    Ok(())
}

/// UI-thread half of the load: `loadFileURL:allowingReadAccessToURL:` is the
/// only entry point WKWebView offers for a local file.
#[cfg(target_os = "macos")]
fn load_file_url(
    wv: &tauri::webview::PlatformWebview,
    html_path: &str,
    dir_path: &str,
) -> Result<(), String> {
    use objc2_foundation::{NSString, NSURL};

    let web = webview(wv)?;
    let file = NSURL::fileURLWithPath(&NSString::from_str(html_path));
    let dir = NSURL::fileURLWithPath(&NSString::from_str(dir_path));
    // SAFETY: both URLs are live objects; the navigation handle is not needed.
    let _ = unsafe { web.loadFileURL_allowingReadAccessToURL(&file, &dir) };
    Ok(())
}

/// Retain the window's WKWebView. The pointer comes from tauri and is live for
/// as long as the window is.
#[cfg(target_os = "macos")]
fn webview(
    wv: &tauri::webview::PlatformWebview,
) -> Result<objc2::rc::Retained<objc2_web_kit::WKWebView>, String> {
    let ptr: *mut objc2_web_kit::WKWebView = wv.inner().cast();
    // SAFETY: tauri hands us the live WKWebView backing this window; retain
    // gives us an owned reference for the duration of the call.
    unsafe { objc2::rc::Retained::retain(ptr) }.ok_or_else(|| "WKWebView handle is null".into())
}

/// UI-thread half of the print. Builds an NSPrintInfo whose job disposition is
/// `NSPrintSaveJob` with `NSPrintJobSavingURL` pointing at our output file,
/// hands it to WKWebView's own print operation, and runs it with both the
/// print panel and the progress panel suppressed.
#[cfg(target_os = "macos")]
fn run_print_operation(
    wv: &tauri::webview::PlatformWebview,
    pdf_path: &str,
    page: Page,
) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintSaveJob,
        NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};

    /// AppKit measures paper and margins in typographic points.
    const PT_PER_MM: f64 = 72.0 / 25.4;

    let web = webview(wv)?;
    let paper = NSSize::new(page.width_mm * PT_PER_MM, page.height_mm * PT_PER_MM);
    let margin = page.margin_mm * PT_PER_MM;

    let info = NSPrintInfo::new();
    info.setPaperSize(paper);
    info.setOrientation(NSPaperOrientation::Portrait);
    info.setTopMargin(margin);
    info.setBottomMargin(margin);
    info.setLeftMargin(margin);
    info.setRightMargin(margin);
    // Automatic in both axes: let WebKit reflow to the printable width and
    // break into as many pages as the document needs.
    info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);

    // "Save to this file" instead of "spool to a printer". These two keys have
    // no typed setters — they live only in the print info's attribute
    // dictionary — so they go in by selector.
    let url = NSURL::fileURLWithPath(&NSString::from_str(pdf_path));
    // SAFETY: `dictionary` returns the info's own mutable attribute
    // dictionary; setObject:forKey: returns void and both operands are live
    // objc objects that outlive the call.
    unsafe {
        let dict: *mut AnyObject = msg_send![&*info, dictionary];
        if dict.is_null() {
            return Err("NSPrintInfo has no attribute dictionary".into());
        }
        let _: () = msg_send![dict, setObject: NSPrintSaveJob, forKey: NSPrintJobDisposition];
        let _: () = msg_send![dict, setObject: &*url, forKey: NSPrintJobSavingURL];
    }

    // SAFETY: WKWebView's own print operation for the currently loaded page.
    let op = unsafe { web.printOperationWithPrintInfo(&info) };
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    op.setJobTitle(Some(&NSString::from_str("Chitallo")));
    // WebKit lays the document out at the print view's width; without this the
    // view keeps the on-screen frame and the right margin ends up clipped.
    if let Some(view) = op.view() {
        let printable = NSSize::new(paper.width - 2.0 * margin, paper.height - 2.0 * margin);
        view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), printable));
    }

    if op.runOperation() {
        Ok(())
    } else {
        Err("NSPrintOperation failed (output path not writable?)".into())
    }
}

// ---------------------------------------------------------------------------
// Everywhere else: no silent print pipeline, and no pretending otherwise.
// ---------------------------------------------------------------------------

#[cfg(not(any(windows, target_os = "macos")))]
async fn drive_print(
    _window: &tauri::WebviewWindow,
    _html_path: &str,
    _html_name: &str,
    _pdf_path: &str,
    _page: Page,
    _load_rx: std::sync::mpsc::Receiver<String>,
) -> Result<(), String> {
    Err("pdf_unsupported".into())
}
