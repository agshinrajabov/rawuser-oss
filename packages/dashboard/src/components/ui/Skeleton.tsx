import { cn } from "@/lib/utils";
import type * as React from "react";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-surface-muted animate-pulse rounded-sm", className)} {...props} />;
}

export { Skeleton };
