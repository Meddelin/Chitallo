// One way to put text on the clipboard, for every surface that offers a copy.
//
// `navigator.clipboard` needs a secure context. On Windows the webview serves
// the app from `http://tauri.localhost`, which counts as one; on macOS it comes
// from the `tauri://` custom scheme, which WebKit does not register as secure —
// so the API can simply be absent there. Two of the four call sites used to
// reach straight through it and would have thrown a TypeError when it was.
//
// The fallback is the pre-Clipboard-API move: a hidden textarea and
// `document.execCommand("copy")`. Deprecated, universally implemented, and
// synchronous — it only works inside the user gesture that triggered it, which
// is exactly the situation every caller here is in.

/// Returns whether the text made it onto the clipboard, so a caller can say so
/// honestly instead of flashing «Copied» over a no-op.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied, or a non-secure context that still exposed the API
    }
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but focusable and selectable: display:none or visibility:hidden
  // would make the selection — and therefore the copy — impossible.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);

  // Copying steals the selection; put the reader's own back afterwards, or a
  // «Copy» on a translated paragraph would silently clear what they highlighted.
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    if (prev && sel) {
      sel.removeAllRanges();
      sel.addRange(prev);
    }
  }
}
