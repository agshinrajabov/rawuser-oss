import { cn } from "@/lib/utils";
import * as React from "react";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "w-full min-h-[72px] px-3 py-2 text-sm bg-surface border border-border rounded-sm",
          "placeholder:text-fg-faint text-fg",
          "focus:border-border-strong focus:outline-2 focus:outline-[var(--focus-ring)] focus:outline-offset-2",
          "transition-colors duration-fast ease-smooth",
          "resize-none disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
