import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";

const badgeVariants = cva(
  "inline-flex items-center h-5 px-2 text-xs font-medium rounded-pill border",
  {
    variants: {
      variant: {
        default: "bg-surface-muted text-fg border-border",
        success:
          "bg-[color-mix(in_srgb,var(--state-success)_12%,transparent)] text-state-success border-transparent",
        warn: "bg-[color-mix(in_srgb,var(--state-warn)_12%,transparent)] text-state-warn border-transparent",
        err: "bg-[color-mix(in_srgb,var(--state-err)_12%,transparent)] text-state-err border-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
