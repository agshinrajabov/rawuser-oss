import { cn } from "@/lib/utils";

type Health = "green" | "yellow" | "red";

interface HealthBadgeProps {
  health: Health;
  className?: string;
}

const CONFIG: Record<Health, { dot: string; label: string; bg: string; text: string }> = {
  green: {
    dot: "bg-state-success",
    label: "Healthy",
    bg: "bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)]",
    text: "text-state-success",
  },
  yellow: {
    dot: "bg-state-warn",
    label: "Attention",
    bg: "bg-[color-mix(in_srgb,var(--state-warn)_10%,transparent)]",
    text: "text-state-warn",
  },
  red: {
    dot: "bg-state-err",
    label: "Issue",
    bg: "bg-[color-mix(in_srgb,var(--state-err)_10%,transparent)]",
    text: "text-state-err",
  },
};

export function HealthBadge({ health, className }: HealthBadgeProps) {
  const c = CONFIG[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-5 px-2 text-xs font-medium rounded-pill",
        c.bg,
        c.text,
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", c.dot)} aria-hidden />
      {c.label}
    </span>
  );
}
