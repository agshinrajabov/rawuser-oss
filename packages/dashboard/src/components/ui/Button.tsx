"use client";

import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 font-medium transition-[color,background-color,border-color,transform] duration-fast ease-smooth active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-40 rounded-sm",
  {
    variants: {
      variant: {
        default: "bg-cta-bg text-cta-fg hover:opacity-90",
        secondary: "bg-surface text-fg border border-border-strong hover:bg-surface-muted",
        ghost: "text-fg hover:bg-surface-muted",
        destructive: "bg-state-err text-white hover:opacity-90",
      },
      size: {
        default: "h-input px-3 text-sm",
        sm: "h-input-sm px-2 text-xs",
        lg: "h-9 px-4 text-sm",
        icon: "h-input w-input",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
