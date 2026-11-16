"use client";

import { Badge } from "@/components/ui/Badge";
import { Separator } from "@/components/ui/Separator";
import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, X } from "lucide-react";
import type { DimDef } from "./DimTable";

interface DimDrawerProps {
  dim: DimDef | null;
  open: boolean;
  onClose: () => void;
  variantCount: number;
}

export function DimDrawer({ dim, open, onClose, variantCount }: DimDrawerProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-scrim",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-0 right-0 z-50 h-dvh w-[480px]",
            "bg-surface border-l border-border",
            "flex flex-col overflow-hidden",
            "focus:outline-none",
            "data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right",
          )}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {dim ? `${dim.name} dimension` : "Dimension"}
          </DialogPrimitive.Title>

          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg font-semibold text-fg truncate">
                {dim?.name.replace(/_/g, " ")}
              </span>
              {dim && <Badge variant="default">{dim.axis}</Badge>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex-shrink-0 p-1.5 rounded-sm text-fg-faint hover:text-fg transition-colors duration-fast focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2"
            >
              <X size={14} />
            </button>
          </div>

          {dim && (
            <div className="flex-1 overflow-y-auto p-4 space-y-gap-section">
              <div className="space-y-gap-block">
                <p className="text-base text-fg leading-relaxed">{dim.description}</p>
              </div>

              <Separator />

              <div className="space-y-gap-block">
                <p className="text-md font-semibold text-fg">Triggers</p>
                <ul className="space-y-1.5">
                  {dim.signals.map((signal) => (
                    <li key={signal} className="flex gap-2">
                      <span className="text-fg-faint text-sm mt-px flex-shrink-0">·</span>
                      <span className="font-mono text-xs text-fg-muted break-words">{signal}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Separator />

              <div className="space-y-gap-block">
                <p className="text-md font-semibold text-fg">Example variants</p>
                {variantCount > 0 ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-fg-muted">
                        <span className="font-mono text-xs tabular-nums text-fg">
                          {variantCount}
                        </span>{" "}
                        variant{variantCount !== 1 ? "s" : ""} reference this dim
                      </span>
                      <a
                        href={`/variants?${dim.axis === "intent" ? "intent" : "source"}=${dim.name}`}
                        className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors duration-fast"
                      >
                        View all
                        <ArrowRight size={12} />
                      </a>
                    </div>
                    {dim.exampleVariant && (
                      <p className="text-sm text-fg-muted border border-border rounded-sm px-3 py-2 bg-surface-muted leading-relaxed">
                        "{dim.exampleVariant}"
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">No variants reference this dim yet.</p>
                )}
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
