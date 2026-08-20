import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChartColumnIcon, TableIcon } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useSettled } from "@/components/ai-elements/settled";
import { getLang, t } from "@/i18n";

// ---- ```chart — the charts Claude draws inside an answer --------------------
//
// Claude Code has no tools in the «Спросить» panel (--allowedTools ""), so the
// only thing it can do is write. A chart is therefore a FENCE it writes:
//
//   ```chart
//   { "type": "line", "x": "year", "series": [{ "key": "pop", "label": "…" }],
//     "data": [{ "year": 1897, "pop": 125.6 }] }
//   ```
//
// registered as a Streamdown custom renderer (see message.tsx) so it renders in
// place, mid-stream, exactly where the model put it. The prose half of the
// contract — when to draw one at all, and the schema — lives in `ask.viz`
// (i18n.ts), which is appended to the system prompt.
//
// The spec is UNTRUSTED: it arrives as model output and may be half-written,
// malformed, or absurd. Nothing here throws — a spec that does not parse falls
// back to the raw JSON in a muted card, which is at least honest.
//
// Marks follow the house data-viz rules: five categorical slots in a fixed
// order (--chart-1..5, see App.css) that clear the colour-vision gate on both
// card surfaces, 2 px lines, ≤ 24 px bars with a 4 px data-end, area fills at
// 10 %, a solid hairline grid, a legend from two series up. Three of the light
// steps sit under 3:1 on paper, so identity may never rest on hue alone: every
// chart carries a table view, one click away, with the same numbers.

const MAX_SERIES = 5; // slots in the ramp; a sixth would have to invent a hue
const MAX_SLICES = 5; // pie: the tail folds into one neutral «прочее» slice

type ChartKind = "area" | "bar" | "line" | "pie";
type Row = Record<string, unknown>;
/// `key` names the field in the model's own data and is never used anywhere but
/// to read it. `id` is what the chart is actually built on: shadcn's ChartStyle
/// writes `--color-<id>` into a <style> tag, and a key straight out of a model
/// could carry a brace and close that rule early. `id` is ours — s0…s4.
type Series = { key: string; id: string; label: string };
const seriesId = (i: number) => `s${i}`;

type Spec = {
  kind: ChartKind;
  title: string;
  note: string;
  unit: string;
  x: string;
  /** what the x column is called in prose; falls back to the key itself */
  xLabel: string;
  series: Series[];
  data: Row[];
  stacked: boolean;
  curve: "natural" | "linear" | "step";
  /** series the ramp could not take (cartesian only) */
  dropped: number;
};

const KINDS: ChartKind[] = ["area", "bar", "line", "pie"];
const CURVES = ["natural", "linear", "step"] as const;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/// Model output types numbers loosely — "12", "12,5 %", 12 all mean a number.
/// Recharts needs a real one or the point silently vanishes, so coerce here and
/// treat anything that will not coerce as a gap.
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/\s/g, "").replace(",", ".").replace(/[^\d.eE+-]/g, "");
  const n = Number(cleaned);
  return cleaned !== "" && Number.isFinite(n) ? n : null;
}

function readSeries(raw: unknown): Series[] {
  const out: Omit<Series, "id">[] = [];
  if (!Array.isArray(raw)) return [];
  for (const s of raw) {
    if (typeof s === "string" && s.trim()) {
      out.push({ key: s.trim(), label: s.trim() });
      continue;
    }
    if (s && typeof s === "object") {
      const o = s as Row;
      const key = str(o.key);
      if (key) out.push({ key, label: str(o.label) || key });
    }
  }
  return out.map((s, i) => ({ ...s, id: seriesId(i) }));
}

/// Parse one fence body into a spec, or null. Never throws.
function parseSpec(code: string): Spec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Row;

  const kind = str(o.type).toLowerCase() as ChartKind;
  if (!KINDS.includes(kind)) return null;

  const x = str(o.x);
  if (!x) return null;

  const rows = Array.isArray(o.data) ? o.data : [];
  const data = rows.filter((r): r is Row => !!r && typeof r === "object" && !Array.isArray(r));
  if (!data.length) return null;

  const all = readSeries(o.series);
  if (!all.length) return null;

  const curveRaw = str(o.curve).toLowerCase() as (typeof CURVES)[number];
  const curve = CURVES.includes(curveRaw) ? curveRaw : "natural";

  return {
    kind,
    title: str(o.title),
    note: str(o.note),
    unit: str(o.unit),
    x,
    xLabel: str(o.xLabel) || x,
    series: kind === "pie" ? all.slice(0, 1) : all.slice(0, MAX_SERIES),
    data,
    stacked: o.stacked === true,
    curve,
    dropped: kind === "pie" ? 0 : Math.max(0, all.length - MAX_SERIES),
  };
}

// ---- shaping ----------------------------------------------------------------

const slot = (i: number) => `var(--chart-${(i % MAX_SERIES) + 1})`;

const X_ID = "x"; // the row field the axis reads; ours, for the same reason as `id`

/// Cartesian rows, rebuilt on our own field names: the x value as a string
/// (categories and years alike), every series value coerced to a number or left
/// out so Recharts draws a gap.
function cartesianRows(spec: Spec): Row[] {
  return spec.data.map((r) => {
    const out: Row = { [X_ID]: r[spec.x] == null ? "" : String(r[spec.x]) };
    for (const s of spec.series) {
      const v = num(r[s.key]);
      if (v !== null) out[s.id] = v;
    }
    return out;
  });
}

type Slice = { name: string; value: number; fill: string };

/// Pie rows: name + value, biggest first, with the tail past MAX_SLICES summed
/// into one neutral «прочее» — the house rule for a categorical tail.
function pieSlices(spec: Spec): Slice[] {
  const key = spec.series[0].key;
  const all = spec.data
    .map((r) => ({ name: r[spec.x] == null ? "" : String(r[spec.x]), value: num(r[key]) }))
    .filter((s): s is { name: string; value: number } => s.value !== null && s.value > 0)
    .sort((a, b) => b.value - a.value);

  if (all.length <= MAX_SLICES) return all.map((s, i) => ({ ...s, fill: slot(i) }));

  const head: Slice[] = all.slice(0, MAX_SLICES - 1).map((s, i) => ({ ...s, fill: slot(i) }));
  const tail = all.slice(MAX_SLICES - 1);
  head.push({
    name: t("chart.other"),
    value: tail.reduce((a, s) => a + s.value, 0),
    fill: "var(--muted-foreground)",
  });
  return head;
}

// ---- numbers ----------------------------------------------------------------

const fmt = (n: number, compact = false) =>
  new Intl.NumberFormat(getLang(), {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
  }).format(n);

const withUnit = (n: number, unit: string) => (unit ? `${fmt(n)} ${unit}` : fmt(n));

// x labels have to survive a 320 px panel — the tooltip and the table carry the
// full string, so the axis is allowed to clip its own
const shortX = (v: unknown) => {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 11)}…` : s;
};

// ---- the block --------------------------------------------------------------

/// The card every figure in an answer sits in — shared with the mermaid block,
/// so a chart and a diagram are visibly the same kind of thing.
export function Frame({
  title,
  note,
  aside,
  children,
}: {
  title?: string;
  note?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="bg-card my-3 w-full min-w-0 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
      {(title || aside) && (
        <div className="mb-2 flex items-start justify-between gap-2">
          <figcaption className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{title}</figcaption>
          {aside}
        </div>
      )}
      {children}
      {note && <p className="mt-2 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">{note}</p>}
    </figure>
  );
}

/// The honest failure: the model wrote something this renderer cannot read, so
/// show what it wrote rather than an empty box.
function Broken({ code }: { code: string }) {
  return (
    <Frame note={t("chart.broken")}>
      <pre className="max-h-40 overflow-auto rounded-lg bg-neutral-100 p-2 text-[11px] leading-snug whitespace-pre-wrap text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {code.trim()}
      </pre>
    </Frame>
  );
}

function Skeleton() {
  return (
    <Frame>
      <div
        className="h-40 w-full animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-800"
        aria-label={t("chart.drawing")}
      />
    </Frame>
  );
}

/// The table twin. Not a fallback — the WCAG-clean way to read the same numbers,
/// which is what lets the light ramp keep its paler hues.
function DataTable({ spec, rows }: { spec: Spec; rows: Row[] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-left text-[11px] tabular-nums">
        <thead className="bg-card sticky top-0 text-neutral-500 dark:text-neutral-400">
          <tr>
            <th className="py-1 pr-2 font-medium">{spec.xLabel}</th>
            {spec.series.map((s) => (
              <th key={s.id} className="py-1 pl-2 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-neutral-700 dark:text-neutral-200">
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-100 dark:border-neutral-800">
              <td className="py-1 pr-2">{String(r[spec.x] ?? "")}</td>
              {spec.series.map((s) => {
                const v = num(r[s.key]);
                return (
                  <td key={s.id} className="py-1 pl-2 text-right">
                    {v === null ? "—" : withUnit(v, spec.unit)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BOX = "aspect-[16/10] max-h-64 min-h-40 w-full";
// The surface itself does the separating — a 2 px stroke in the CARD colour IS
// the gap, never a border drawn to outline the mark. It has to be the card and
// not the panel behind it, or the seam shows.
//
// `var(--card)`, not Tailwind's `--color-card`: the latter is declared once on
// :root as `var(--card)`, so it computes there, in the LIGHT theme, and every
// descendant inherits that one value. The utilities (`bg-card`) are unaffected
// because `@theme inline` substitutes them, but a raw var() reference is not.
const GAP = { stroke: "var(--card)", strokeWidth: 2 };
const AXIS = { tickLine: false, axisLine: false, tickMargin: 6 } as const;
const DOT = { r: 4, strokeWidth: 2, stroke: "var(--card)" };
// Recharts' grow-in is off everywhere here. The chart appears under a paragraph
// that is still being typed, so a 1.9 s animation is noise beside live text —
// and the pie's version renders NOTHING until it runs, which in this panel it
// sometimes never does. A chart that is simply there when the fence closes.
const STILL = { isAnimationActive: false } as const;

function Plot({ spec, slices }: { spec: Spec; slices: Slice[] }) {
  const cartesian = spec.kind !== "pie";
  const rows = useMemo(() => (cartesian ? cartesianRows(spec) : []), [spec, cartesian]);

  const config: ChartConfig = useMemo(() => {
    const c: ChartConfig = {};
    if (cartesian) {
      spec.series.forEach((s, i) => {
        c[s.id] = { label: s.label, color: slot(i) };
      });
    } else {
      // pie: labels only — each slice paints itself through its own `fill`, so
      // no `--color-<name>` is emitted for names that are not CSS idents
      slices.forEach((s) => {
        c[s.name] = { label: s.name };
      });
    }
    return c;
  }, [spec, cartesian, slices]);

  const legend = (cartesian ? spec.series.length : slices.length) > 1;

  if (!cartesian)
    return (
      <ChartContainer className={BOX} config={config}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" />} />
          <Pie data={slices} dataKey="value" nameKey="name" outerRadius="80%" {...STILL} {...GAP}>
            {slices.map((s) => (
              <Cell key={s.name} fill={s.fill} />
            ))}
          </Pie>
          {legend && (
            <ChartLegend content={<ChartLegendContent nameKey="name" className="flex-wrap gap-x-3 gap-y-1" />} />
          )}
        </PieChart>
      </ChartContainer>
    );

  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: 0 } };
  const grid = <CartesianGrid vertical={false} strokeDasharray="0" />;
  const xAxis = (
    <XAxis dataKey={X_ID} {...AXIS} minTickGap={16} interval="preserveStartEnd" tickFormatter={shortX} />
  );
  const yAxis = <YAxis {...AXIS} width={38} tickFormatter={(v: number) => fmt(v, true)} />;
  const tip = <ChartTooltip content={<ChartTooltipContent indicator={spec.kind === "line" ? "line" : "dot"} />} />;
  const key = legend ? <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-3 gap-y-1" />} /> : null;

  if (spec.kind === "bar")
    return (
      <ChartContainer className={BOX} config={config}>
        <BarChart {...common}>
          {grid}
          {xAxis}
          {yAxis}
          {tip}
          {key}
          {spec.series.map((s) => (
            <Bar
              key={s.id}
              dataKey={s.id}
              fill={`var(--color-${s.id})`}
              maxBarSize={24}
              radius={spec.stacked ? 2 : [4, 4, 0, 0]}
              stackId={spec.stacked ? "a" : undefined}
              {...STILL}
              {...(spec.stacked ? GAP : {})}
            />
          ))}
        </BarChart>
      </ChartContainer>
    );

  if (spec.kind === "area")
    return (
      <ChartContainer className={BOX} config={config}>
        <AreaChart {...common}>
          {grid}
          {xAxis}
          {yAxis}
          {tip}
          {key}
          {spec.series.map((s) => (
            <Area
              key={s.id}
              dataKey={s.id}
              type={spec.curve}
              stroke={`var(--color-${s.id})`}
              strokeWidth={2}
              fill={`var(--color-${s.id})`}
              fillOpacity={0.1}
              stackId={spec.stacked ? "a" : undefined}
              dot={false}
              activeDot={DOT}
              {...STILL}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    );

  return (
    <ChartContainer className={BOX} config={config}>
      <LineChart {...common}>
        {grid}
        {xAxis}
        {yAxis}
        {tip}
        {key}
        {spec.series.map((s) => (
          <Line
            key={s.id}
            dataKey={s.id}
            type={spec.curve}
            stroke={`var(--color-${s.id})`}
            strokeWidth={2}
            dot={false}
            activeDot={DOT}
            {...STILL}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

export type ChartBlockProps = { code: string; isIncomplete?: boolean };

export function ChartBlock({ code, isIncomplete }: ChartBlockProps) {
  const [table, setTable] = useState(false);
  const settled = useSettled(code);
  // Parsing costs nothing, so it is attempted on every token: the frame a spec
  // first closes its brace is the frame the chart appears, and a chart replayed
  // from a saved conversation draws on its very first render.
  const spec = useMemo(() => parseSpec(code), [code]);
  const slices = useMemo(() => (spec && spec.kind === "pie" ? pieSlices(spec) : []), [spec]);

  // Failing to parse is only a MISTAKE once the text has stopped arriving.
  // Until then it just means «not all of it is here yet», and the honest thing
  // on screen is a quiet box, not an error. (`isIncomplete` is Streamdown's own
  // answer to this and is always false — see useSettled — but it costs nothing
  // to honour it if that ever changes.)
  if (!spec) return isIncomplete || !settled ? <Skeleton /> : <Broken code={code} />;

  const rows: Row[] =
    spec.kind === "pie"
      ? slices.map((s) => ({ [spec.x]: s.name, [spec.series[0].key]: s.value }))
      : spec.data;
  const note = [spec.note, spec.dropped ? t("chart.dropped", { n: spec.dropped }) : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <Frame
      title={spec.title}
      note={note}
      aside={
        <button
          type="button"
          onClick={() => setTable((v) => !v)}
          aria-pressed={table}
          title={table ? t("chart.showChart") : t("chart.showTable")}
          className="-mt-0.5 -mr-1 shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-900/5 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-100/10 dark:hover:text-neutral-200"
        >
          {table ? <ChartColumnIcon className="size-3.5" /> : <TableIcon className="size-3.5" />}
          <span className="sr-only">{table ? t("chart.showChart") : t("chart.showTable")}</span>
        </button>
      }
    >
      {table ? <DataTable spec={spec} rows={rows} /> : <Plot spec={spec} slices={slices} />}
    </Frame>
  );
}
