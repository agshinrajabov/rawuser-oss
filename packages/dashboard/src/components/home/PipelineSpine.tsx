"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { CustomerListItem } from "@/types/api";
import { Check } from "lucide-react";
import Link from "next/link";
import { nextAction, pipelineState } from "./pipeline";

/**
 * Horizontal 5-step setup spine for a single customer (ADR 0024). Turns the
 * flat menu into "you are here → do this next", driven by pipelineState().
 */
export function PipelineSpine({ customer }: { customer: CustomerListItem }) {
  const { steps, currentIndex, live } = pipelineState(customer);
  const action = nextAction(customer);

  return (
    <div className="bg-surface border border-border rounded-md p-5">
      <div className="flex items-start gap-0 mb-5">
        {steps.map((step, i) => {
          // Monotonic display: everything before the current step is done, the
          // current step is highlighted, later steps are upcoming — even if a
          // later step's own flag happens to be set. A linear pipeline should
          // never show "Install ✓ · Measure ✓" while "Page versions" is current.
          const done = live || i < currentIndex;
          const current = !live && i === currentIndex;
          return (
            <div key={`${step.key}-${i}`} className="flex-1 text-center">
              <div
                className={cn(
                  "w-7 h-7 rounded-full mx-auto mb-1.5 flex items-center justify-center text-xs font-medium",
                  done && "text-white",
                  current && "bg-cta-bg text-cta-fg",
                  !done && !current && "border border-border-strong text-fg-faint",
                )}
                style={done ? { background: "var(--state-success)" } : undefined}
              >
                {done ? <Check size={15} strokeWidth={2.5} /> : i + 1}
              </div>
              <div
                className={cn(
                  "text-[11px] leading-tight",
                  current ? "text-fg font-medium" : "text-fg-muted",
                )}
              >
                {step.label}
              </div>
              {current && <div className="text-[10px] text-fg-faint mt-0.5">you are here</div>}
            </div>
          );
        })}
      </div>

      {action && (
        <div className="flex items-center justify-between gap-3 bg-surface-muted rounded-sm px-3 py-2.5">
          <div className="text-sm text-fg">
            {live ? "This customer is live." : "Next:"}{" "}
            <span className={cn(!live && "text-fg-muted")}>{live ? "" : action.label}</span>
          </div>
          <Button asChild size="sm">
            <Link href={action.href}>{live ? "View results" : action.label}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
