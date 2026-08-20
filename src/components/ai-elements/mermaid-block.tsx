import { useEffect, useRef, useState } from "react";
import { Frame } from "@/components/ai-elements/chart-block";
import { useSettled } from "@/components/ai-elements/settled";
import { MERMAID_BASE, MM_DARK, MM_LIGHT } from "@/mermaid-theme";
import { t } from "@/i18n";
import { useDark } from "@/theme";

// ---- ```mermaid — the diagrams Claude draws inside an answer ----------------
//
// The other half of the same contract as chart-block.tsx: a fence the model
// writes, rendered in place as the answer streams. When to draw one at all, and
// which of the three allowed shapes, is taught in `ask.viz` (i18n.ts).
//
// Streamdown ships its own mermaid path (plugins.mermaid + a `mermaid` prop) and
// this deliberately does not use it. That path never receives `isIncomplete`, so
// it calls mermaid.render() on every token of the stream and flashes a red,
// hardcoded-English error box until the fence closes; its card also paints
// itself `bg-sidebar`, a token this app does not define. A custom renderer for
// the `mermaid` language takes precedence over it and gets `isIncomplete` — the
// same escape hatch the chart block already uses.
//
// Mermaid itself is loaded DYNAMICALLY, and only from here. A static import
// drags d3, dagre and the layout engines into the main chunk; a reader who
// never opens a diagram should not pay for one. Mermaid then splits itself
// further, one chunk per diagram type, so no manualChunks entry — it would glue
// them back into a single blob.

type Mermaid = (typeof import("mermaid"))["default"];

let lib: Promise<Mermaid> | null = null;

function load(): Promise<Mermaid> {
  lib ??= import("mermaid")
    .then((m) => m.default)
    .catch((e) => {
      lib = null; // a failed chunk load must not poison every later diagram
      throw e;
    });
  return lib;
}

// mermaid.initialize is process-global, so the theme is applied once per flip
// rather than once per diagram. The block below it is synchronous, so two
// diagrams resuming in the same tick cannot both initialise.
let appliedDark: boolean | null = null;

// The id is glued in front of every CSS rule mermaid writes for the diagram, so
// it has to be a valid selector — React's useId() yields ":r1:" and would take
// the whole stylesheet down with it.
let seq = 0;

export type MermaidBlockProps = { code: string; isIncomplete?: boolean };

export function MermaidBlock({ code, isIncomplete }: MermaidBlockProps) {
  const dark = useDark();
  const settled = useSettled(code);
  const [svg, setSvg] = useState("");
  const [broken, setBroken] = useState(false);
  const live = useRef(0);

  useEffect(() => {
    const source = code.trim();
    // Unlike a chart spec, a diagram is NOT attempted on every token. Half a
    // flowchart is often valid mermaid — `flowchart TD` on its own is an empty
    // one — so a token-by-token attempt would lay out and paint a diagram that
    // is merely the first two nodes, three times over, jumping as it goes. It
    // waits for quiet instead. Nothing is lost: the first diagram of a session
    // is behind a dynamic import that takes longer than the wait.
    if (isIncomplete || !settled || !source) return;

    const token = ++live.current;
    void (async () => {
      try {
        const mermaid = await load();
        if (appliedDark !== dark) {
          mermaid.initialize({ ...MERMAID_BASE, themeVariables: dark ? MM_DARK : MM_LIGHT });
          appliedDark = dark;
        }
        const out = await mermaid.render(`mmd${(seq += 1)}`, source);
        if (token !== live.current) return; // the theme flipped, or the text moved on
        setSvg(out.svg);
        setBroken(false);
      } catch {
        if (token !== live.current) return;
        // The last good diagram is deliberately kept. A stream can settle for a
        // moment on text that does not parse — remend leaves a stray backtick in
        // the body right before the closing fence arrives — and blinking the
        // drawing out and back for that is worse than showing it a beat stale.
        setBroken(true);
      }
    })();

    return () => {
      live.current += 1;
    };
  }, [code, dark, isIncomplete, settled]);

  // The honest failure, same as a broken chart spec: show what the model wrote.
  // Only once the text has settled, though — before that a failure means «not
  // all of it is here yet» — and this comes before the drawing, so a diagram
  // whose source ends up broken does not keep showing a stale earlier version.
  if (broken && settled)
    return (
      <Frame note={t("diagram.broken")}>
        <pre className="max-h-40 overflow-auto rounded-lg bg-neutral-100 p-2 text-[11px] leading-snug whitespace-pre-wrap text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {code.trim()}
        </pre>
      </Frame>
    );

  // A diagram already drawn stays on screen while the next one is being
  // prepared — the frame never collapses back to a skeleton under the reader.
  if (svg)
    return (
      <Frame>
        {/* The SVG has already been through mermaid's own DOMPurify pass — that
            is what securityLevel "strict" buys — and htmlLabels:false keeps every
            label a plain SVG <text> node, so no foreignObject carries markup in. */}
        <div
          data-chitallo="mermaid"
          className="w-full min-w-0 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </Frame>
    );

  return (
    <Frame>
      <div
        className="h-32 w-full animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-800"
        aria-label={t("diagram.drawing")}
      />
    </Frame>
  );
}
