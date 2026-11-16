"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { VariantListItem } from "@/types/api";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { DetailPane } from "./DetailPane";

interface VariantSidePanelProps {
  item: VariantListItem | null;
  customerId: string;
  open: boolean;
  onClose: () => void;
  onRegenerated: () => void;
}

function statusBadge(status: VariantListItem["status"]) {
  if (status === "ready") return <Badge variant="success">● ready</Badge>;
  if (status === "stale") return <Badge variant="warn">● stale</Badge>;
  return <Badge variant="err">● error</Badge>;
}

export function VariantSidePanel({
  item,
  customerId,
  open,
  onClose,
  onRegenerated,
}: VariantSidePanelProps) {
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
            "flex flex-col",
            "focus:outline-none",
            "data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right",
          )}
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {item ? `${item.intent_dim} · ${item.source_dim} variant` : "Variant"}
          </DialogPrimitive.Title>

          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm font-semibold text-fg truncate">
                {item ? `${item.intent_dim} · ${item.source_dim}` : "-"}
              </span>
              {item && statusBadge(item.status)}
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

          {item && <DetailPane item={item} customerId={customerId} onRegenerated={onRegenerated} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
