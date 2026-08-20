import { useSyncExternalStore } from "react";

// ---- «is the app dark right now», readable from anywhere ---------------------
//
// The theme itself lives where it always has: `dark` state in App.tsx, persisted
// in pdfer:dark, applied as a `dark` class on the app's root element. Everything
// that only needs to LOOK different reads that class through Tailwind's `dark:`
// variant and never asks a question.
//
// Mermaid is the exception. It renders a diagram to an SVG string with the
// colours baked in — its palette is computed in JavaScript, from a theme object,
// not from CSS — so the renderer has to be TOLD which half of the palette to
// use, and told again when the reader hits D. This module is that channel: a
// subscription to the class itself, so nothing has to be threaded down through
// the sidebar, and a component deep inside re-renders on a theme switch exactly
// like the CSS does.

const isDark = () => document.documentElement.querySelector(".dark") !== null;

let current = isDark();

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!observer) {
    // The class sits on a div inside #root, not on <html>, so the observer has
    // to watch the subtree. `class` only — attributeFilter keeps this off the
    // hot path of every other attribute write in the app.
    observer = new MutationObserver(() => {
      const next = isDark();
      if (next === current) return;
      current = next;
      for (const l of listeners) l();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

const snapshot = () => current;

/** True while the app is in its dark theme; re-renders the caller when it flips. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
