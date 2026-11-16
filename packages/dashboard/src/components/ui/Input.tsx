import { cn } from "@/lib/utils";
import * as React from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "h-input w-full px-3 text-sm bg-surface border border-border rounded-sm",
          "placeholder:text-fg-faint text-fg",
          "focus:border-border-strong focus:outline-2 focus:outline-[var(--focus-ring)] focus:outline-offset-2",
          "transition-colors duration-fast ease-smooth",
          "disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
