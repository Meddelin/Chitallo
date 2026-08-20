import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";

// AI Elements `message` (shadcn.io/ai pattern), trimmed for Chitallo:
// Message / MessageContent (bubbles), MessageActions / MessageAction (the
// «Actions» pattern), MessageResponse (the «Response» pattern — streaming
// markdown via Streamdown, which never renders raw HTML: markdown HTML nodes
// are dropped by its hardened renderer, so model output cannot inject markup).
// Dropped from the registry item: MessageBranch*, MessageAttachment*,
// MessageToolbar and the `ai`-package types they needed.

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
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      // Chitallo: strip Streamdown's hover chrome (English «Copy code» / «Download
      // file» / table buttons) — clashes with the pill aesthetic and RU voice
      controls={false}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
