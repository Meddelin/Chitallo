import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChartBlock } from "@/components/ai-elements/chart-block";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block";
import { cn } from "@/lib/utils";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import type { CustomRendererProps, PluginConfig } from "streamdown";
import { createMathPlugin } from "@streamdown/math";

// AI Elements `message` (shadcn.io/ai pattern), trimmed for Chitallo:
// Message / MessageContent (bubbles), MessageActions / MessageAction (the
// «Actions» pattern), MessageResponse (the «Response» pattern — streaming
// markdown via Streamdown, which never renders raw HTML: markdown HTML nodes
// are dropped by its hardened renderer, so model output cannot inject markup).
// Dropped from the registry item: MessageBranch*, MessageAttachment*,
// MessageToolbar and the `ai`-package types they needed.
//
// Three things an answer may contain besides prose. WHEN to reach for each —
// and the standing answer, which is «none of them, write a sentence» — is one
// rubric taught to the model in `ask.viz` (i18n.ts). Here is only the plumbing:
//   * MATHS — $inline$ and $$display$$, set by KaTeX. Single-dollar inline is
//     ON, because that is what models actually write; the prompt tells Claude
//     to escape a literal currency \$ so «$5» stays five dollars. KaTeX's own
//     stylesheet and fonts are imported once, in App.css.
//   * CHARTS — a ```chart fence holding a JSON spec, rendered by ChartBlock on
//     shadcn's chart primitives (Recharts).
//   * DIAGRAMS — a ```mermaid fence, rendered by MermaidBlock.
// Both fences are custom RENDERERS rather than Streamdown's built-in handling,
// because a custom renderer is the only path that receives `isIncomplete` — and
// a half-streamed fence must show a quiet box, not an error.

const math = createMathPlugin({ singleDollarTextMath: true });

const ChartRenderer = ({ code, isIncomplete }: CustomRendererProps) => (
  <ChartBlock code={code} isIncomplete={isIncomplete} />
);

const MermaidRenderer = ({ code, isIncomplete }: CustomRendererProps) => (
  <MermaidBlock code={code} isIncomplete={isIncomplete} />
);

const plugins: PluginConfig = {
  math,
  renderers: [
    { language: "chart", component: ChartRenderer },
    { language: "mermaid", component: MermaidRenderer },
  ],
};

// Models write a centred formula as `$$…$$` on one line; remark-math only reads
// that as DISPLAY maths when the fences sit on their own lines, and otherwise
// sets it cramped, inline-style, mid-paragraph. So a line that is nothing but
// `$$…$$` is opened out here. Nothing else is touched: the whole line must
// match, and it must already be closed — half a formula still streaming is left
// exactly as it arrived.
const LONE_DISPLAY_MATH = /^[ \t]*\$\$[ \t]*(\S[^\n]*?)[ \t]*\$\$[ \t]*$/gm;
const openOutMath = (md: string) =>
  md.includes("$$") ? md.replace(LONE_DISPLAY_MATH, (_, body: string) => `$$\n${body}\n$$`) : md;

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-1",
      from === "user" ? "is-user ml-auto max-w-[85%] items-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      // Chitallo restyle: the user bubble mirrors the old sidebar pill (xl radius,
      // clipped corner, neutral fill); assistant text runs full-width, no chrome
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-sm group-[.is-user]:bg-secondary group-[.is-user]:px-3 group-[.is-user]:py-1.5 group-[.is-user]:text-foreground group-[.is-user]:whitespace-pre-wrap",
      "group-[.is-assistant]:w-full group-[.is-assistant]:leading-relaxed group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      // Chitallo: strip Streamdown's hover chrome (English «Copy code» / «Download
      // file» / table buttons) — clashes with the pill aesthetic and RU voice
      controls={false}
      plugins={plugins}
      {...props}
    >
      {typeof children === "string" ? openOutMath(children) : children}
    </Streamdown>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
