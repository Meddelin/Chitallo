"use client";

import { Button } from "@/components/ui/button";
import {
  ScrollArea,
  ScrollBar,
} from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export type SuggestionsProps = ComponentProps<typeof ScrollArea> & {
  /** Wrap onto extra rows instead of scrolling sideways. Required in a narrow
   *  container: the scroll variant below hides its scrollbar (Radix
   *  `scrollbar-width:none` + `<ScrollBar className="hidden">`), so anything
   *  past the right edge is silently unreachable with a mouse. */
  wrap?: boolean;
};

export const Suggestions = ({
  className,
  children,
  wrap,
  ...props
}: SuggestionsProps) => {
  if (wrap) {
    return (
      <div
        className={cn("flex flex-wrap items-center gap-1.5", className)}
        {...(props as unknown as ComponentProps<"div">)}
      >
        {children}
      </div>
    );
  }
  return (
    <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
      <div className={cn("flex w-max flex-nowrap items-center gap-2", className)}>
        {children}
      </div>
      <ScrollBar className="hidden" orientation="horizontal" />
    </ScrollArea>
  );
};

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    onClick?.(suggestion);
  };

  return (
    <Button
      className={cn("cursor-pointer rounded-full px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
