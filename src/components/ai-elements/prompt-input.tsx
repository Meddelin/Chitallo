import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ArrowUpIcon, Loader2Icon, SquareIcon, XIcon } from "lucide-react";
import type {
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
} from "react";
import { useState } from "react";

// AI Elements `prompt-input` (shadcn.io/ai pattern), trimmed for Chitallo:
// PromptInput (the form shell), PromptInputTextarea (Enter submits,
// Shift+Enter breaks, IME-safe), PromptInputToolbar / PromptInputTools and
// PromptInputSubmit with the status icon cycle (ready → submitted → streaming
// → error). Dropped from the registry item: attachments, speech input, model
// select, action menus — and with them the `ai`, `nanoid`, command/dropdown/
// hover-card/select dependencies.

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export const PromptInput = ({ className, onSubmit, ...props }: PromptInputProps) => {
  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    onSubmit(event);
  };

  return (
    <form
      className={cn(
        // Chitallo restyle: one quiet pill instead of the stock bordered card —
        // the same neutral fill the old sidebar textarea had
        "w-full overflow-hidden rounded-xl bg-neutral-200/60 dark:bg-neutral-700/50",
        className,
      )}
      onSubmit={handleSubmit}
      {...props}
    />
  );
};

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>;

export const PromptInputTextarea = ({
  onChange,
  className,
  placeholder,
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter") {
      if (isComposing || e.nativeEvent.isComposing) return;
      if (e.shiftKey) return;
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <Textarea
      className={cn(
        "w-full resize-none rounded-none border-none bg-transparent p-3 text-sm leading-relaxed shadow-none outline-none ring-0 dark:bg-transparent",
        "field-sizing-content max-h-[140px] min-h-0",
        className,
      )}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onChange={onChange}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputToolbar = ({ className, ...props }: PromptInputToolbarProps) => (
  <div className={cn("flex items-center justify-between p-1.5 pt-0", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  let Icon = <ArrowUpIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-3 fill-current" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  return (
    <Button
      aria-label={t("ask.send")}
      className={cn("rounded-full", className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </Button>
  );
};
