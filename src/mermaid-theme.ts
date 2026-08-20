import type { MermaidConfig } from "mermaid";

// ---- how a mermaid diagram is allowed to look, and what it may not do -------
//
// Mermaid computes its palette in JavaScript and bakes the result into the SVG
// string, so a diagram cannot follow the theme the way CSS does: `var(--card)`
// in themeVariables makes mermaid's colour maths throw ("Unsupported color
// format"), and so does `currentColor`. Hence two literal sets, taken straight
// from the tokens in App.css, and a re-render on the theme flip (see
// mermaid-block.tsx, which subscribes through useDark()).
//
// The values here are structural, not data colours: paper and ink, hairline
// borders, one blue accent. A diagram in this app says how things connect — it
// never encodes a quantity in a hue, and it never reaches for the --chart-*
// ramp, which belongs to charts alone.

export const UI_FONT = '"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

/// Base config. Two lines carry the security of the whole feature:
///
///   securityLevel: "strict" — the diagram source is model output. Strict keeps
///   mermaid's own DOMPurify pass on the emitted SVG and refuses `click`
///   directives. "loose" drops the sanitiser and lets a diagram call into
///   window; "sandbox" answers with an iframe on a data: URL, which the app's
///   CSP has no reason to allow. Neither is ever right here.
///
///   secure — the list of keys a `%%{init: ...}%%` header inside the source may
///   NOT override. Mermaid's default list leaves `theme` open, so an answer
///   could hand itself a dark diagram on a light page; every key this app cares
///   about is nailed down instead.
///
/// The geometry is squeezed for a 320–400 px panel: useMaxWidth lets a diagram
/// shrink to the column, and a diagram that has to shrink shrinks its TEXT with
/// it, so the layout is kept narrow enough that it rarely has to.
export const MERMAID_BASE: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "base",
  fontFamily: UI_FONT,
  // Top level, not per diagram: the sequence renderer's setConf overwrites
  // actorFontSize / messageFontSize / noteFontSize with the top-level fontSize
  // whenever one is set, so a per-key size there would be dead config. 13 px is
  // the same size themeVariables gives the flowchart, so both read alike.
  fontSize: 13,
  // No foreignObject: every label becomes a plain SVG <text>. Belt to the
  // braces of securityLevel "strict" — with HTML labels the text goes through
  // an HTML parse first, and there is no reason to open that door for a label
  // that is two words long. Has to be top level; flowchart.htmlLabels alone is
  // not enough (verified: foreignObject survives it).
  htmlLabels: false,
  maxTextSize: 20000,
  maxEdges: 40,
  secure: [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "suppressErrorRendering",
    "theme",
    "themeVariables",
    "themeCSS",
    "fontFamily",
    "look",
    "htmlLabels",
    "layout",
  ],
  flowchart: {
    useMaxWidth: true,
    htmlLabels: false, // no foreignObject: the label is SVG text, sanitised and printable
    wrappingWidth: 150,
    nodeSpacing: 26,
    rankSpacing: 34,
    diagramPadding: 4,
    padding: 8,
    curve: "basis",
  },
  state: { useMaxWidth: true, padding: 6, titleTopMargin: 8 },
  sequence: {
    useMaxWidth: true,
    width: 104,
    actorMargin: 20,
    diagramMarginX: 8,
    diagramMarginY: 6,
    boxMargin: 6,
    messageMargin: 24,
    wrap: true,
    wrapPadding: 6,
    // fontSize and fontFamily come from the top level (see above); only the
    // weight is per-key, because no top-level fontWeight is set to clobber it
    actorFontWeight: 500,
  },
};

// Every value is spelled out rather than left to mermaid's derivation: it runs
// darken()/lighten() over whatever it is given, twice, and a half-filled set
// comes back with colours nobody chose.
const SHARED = { fontFamily: UI_FONT, fontSize: "13px", strokeWidth: 1 } as const;

/// Paper. Node borders are the app's hairline (#e7e5e4 / #d6d3d1) — but the
/// LINES are a step darker (#a8a29e): an arrow in border-grey on white sits at
/// about 1.2:1 and is simply not there.
export const MM_LIGHT = {
  ...SHARED,
  darkMode: false,
  background: "#ffffff",
  primaryColor: "#ffffff",
  primaryTextColor: "#292524",
  primaryBorderColor: "#e7e5e4",
  secondaryColor: "#fafaf9",
  tertiaryColor: "#fafaf9",
  mainBkg: "#ffffff",
  nodeBkg: "#ffffff",
  nodeBorder: "#d6d3d1",
  nodeTextColor: "#292524",
  clusterBkg: "#fafaf9",
  clusterBorder: "#e7e5e4",
  lineColor: "#a8a29e",
  arrowheadColor: "#a8a29e",
  defaultLinkColor: "#a8a29e",
  textColor: "#292524",
  titleColor: "#292524",
  border2: "#e7e5e4",
  edgeLabelBackground: "#ffffff",
  labelBackgroundColor: "#ffffff",
  noteBkgColor: "#fafaf9",
  noteTextColor: "#57534e",
  noteBorderColor: "#e7e5e4",
  actorBkg: "#ffffff",
  actorBorder: "#d6d3d1",
  actorTextColor: "#292524",
  actorLineColor: "#d6d3d1",
  signalColor: "#57534e",
  signalTextColor: "#292524",
  labelBoxBkgColor: "#fafaf9",
  labelBoxBorderColor: "#e7e5e4",
  labelTextColor: "#292524",
  loopTextColor: "#57534e",
  activationBkgColor: "#f5f5f4",
  activationBorderColor: "#d6d3d1",
  sequenceNumberColor: "#ffffff",
  stateBkg: "#ffffff",
  stateLabelColor: "#292524",
  transitionColor: "#a8a29e",
  transitionLabelColor: "#57534e",
  altBackground: "#fafaf9",
  compositeBackground: "#ffffff",
  compositeTitleBackground: "#fafaf9",
  compositeBorder: "#e7e5e4",
  innerEndBackground: "#292524",
  specialStateColor: "#292524",
  errorBkgColor: "#fef2f2",
  errorTextColor: "#dc2626",
} as const;

/// Ink. The same roles, re-stepped for the dark card — not an inversion.
export const MM_DARK = {
  ...SHARED,
  darkMode: true,
  background: "#1c1917",
  primaryColor: "#1c1917",
  primaryTextColor: "#f5f5f4",
  primaryBorderColor: "#44403c",
  secondaryColor: "#292524",
  tertiaryColor: "#292524",
  mainBkg: "#1c1917",
  nodeBkg: "#1c1917",
  nodeBorder: "#57534e",
  nodeTextColor: "#f5f5f4",
  clusterBkg: "#292524",
  clusterBorder: "#44403c",
  lineColor: "#78716c",
  arrowheadColor: "#78716c",
  defaultLinkColor: "#78716c",
  textColor: "#f5f5f4",
  titleColor: "#f5f5f4",
  border2: "#44403c",
  edgeLabelBackground: "#1c1917",
  labelBackgroundColor: "#1c1917",
  noteBkgColor: "#292524",
  noteTextColor: "#d6d3d1",
  noteBorderColor: "#44403c",
  actorBkg: "#1c1917",
  actorBorder: "#57534e",
  actorTextColor: "#f5f5f4",
  actorLineColor: "#57534e",
  signalColor: "#d6d3d1",
  signalTextColor: "#f5f5f4",
  labelBoxBkgColor: "#292524",
  labelBoxBorderColor: "#44403c",
  labelTextColor: "#f5f5f4",
  loopTextColor: "#d6d3d1",
  activationBkgColor: "#44403c",
  activationBorderColor: "#57534e",
  sequenceNumberColor: "#1c1917",
  stateBkg: "#1c1917",
  stateLabelColor: "#f5f5f4",
  transitionColor: "#78716c",
  transitionLabelColor: "#d6d3d1",
  altBackground: "#292524",
  compositeBackground: "#1c1917",
  compositeTitleBackground: "#292524",
  compositeBorder: "#44403c",
  innerEndBackground: "#f5f5f4",
  specialStateColor: "#f5f5f4",
  errorBkgColor: "#3b1d1d",
  errorTextColor: "#f87171",
} as const;
