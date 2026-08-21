import { useCallback, useEffect, useState } from "react";

// ---- «Спросить» panel width -------------------------------------------------
// Its own module, not part of AskSidebar.tsx: a file that exports both a
// component and plain values loses Fast Refresh, and every edit to the sidebar
// would then blow away the open book in dev.
//
// The width is a workspace preference, not a per-book one — one key for the
// whole app, like pdfer:cols / pdfer:dark / pdfer:trfont. The reading area is a
// flex sibling of the panel, so the panel can never cover the book — but it CAN
// squeeze it, hence READ_MIN.

// (WP-N) Direction B fixes the panel: 380 by default, dragged between 320 and
// 560. The old ceiling was a share of the window (60%), which on a wide monitor
// let the panel grow past the point where it reads as a panel at all.
export const ASK_W_DEFAULT = 380;
export const ASK_W_MIN = 320;
export const ASK_W_MAX = 560;
const READ_MIN = 360; // the book keeps at least this much, at any window size
const ASK_W_KEY = "pdfer:askw";

export const askWMax = () => Math.max(ASK_W_MIN, Math.min(ASK_W_MAX, window.innerWidth - READ_MIN));
export const clampAskW = (w: number) => Math.max(ASK_W_MIN, Math.min(Math.round(w), askWMax()));

const stored = () => {
  const v = Number(localStorage.getItem(ASK_W_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** Live sidebar width + a setter that clamps, persists and survives a window resize. */
export function useAskWidth(): [number, (w: number) => void] {
  const [w, setW] = useState(() => clampAskW(stored() ?? ASK_W_DEFAULT));
  const set = useCallback((n: number) => {
    const c = clampAskW(n);
    localStorage.setItem(ASK_W_KEY, String(c));
    setW(c);
  }, []);
  // A narrowed window must not leave the book below READ_MIN. Re-clamp the
  // STORED preference, not the live value, so widening the window again gives
  // back the width the user actually chose; storage is never overwritten here.
  useEffect(() => {
    const onResize = () => setW((v) => clampAskW(stored() ?? v));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return [w, set];
}
