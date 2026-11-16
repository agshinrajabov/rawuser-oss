import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface JourneyChecklistItemProps {
  done: boolean;
  icon: LucideIcon;
  label: string;
  detail: string;
}

export function JourneyChecklistItem({
  done,
  icon: Icon,
  label,
  detail,
}: JourneyChecklistItemProps) {
  return (
    <div className="flex items-start gap-2">
      <div className="relative mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center">
        {done ? (
          <Check size={14} className="text-state-success" strokeWidth={2.5} />
        ) : (
          <Icon size={14} className="text-fg-faint" strokeWidth={1.75} />
        )}
      </div>
      <div className="flex flex-col min-w-0">
        <span
          className={cn("text-sm font-medium leading-snug", done ? "text-fg" : "text-fg-muted")}
        >
          {label}
        </span>
        <span className="text-xs text-fg-faint leading-snug">{detail}</span>
      </div>
      <div className="ml-auto mt-0.5 shrink-0">
        {done ? (
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[color-mix(in_srgb,var(--state-success)_14%,transparent)]">
            <Check size={8} className="text-state-success" strokeWidth={3} />
          </span>
        ) : (
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-surface-muted">
            <X size={8} className="text-fg-faint" strokeWidth={2.5} />
          </span>
        )}
      </div>
    </div>
  );
}
