"use client";

interface DimBarProps {
  label: string;
  value: number;
  isDominant?: boolean;
}

export function DimBar({ label, value, isDominant }: DimBarProps) {
  const pct = Math.round(value * 100);

  const fillClass = isDominant ? "bg-fg" : value < 0.08 ? "bg-fg-faint" : "bg-fg-muted";

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 flex-shrink-0 text-sm text-fg-muted lowercase truncate">
        {label.replace(/_/g, " ")}
      </span>
      <div className="flex-1 h-1.5 rounded-sm bg-surface-muted overflow-hidden">
        <div
          className={`h-full rounded-sm transition-all duration-300 ease-out ${fillClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-7 text-right font-mono text-xs tabular-nums text-fg-muted flex-shrink-0">
        {value.toFixed(2)}
      </span>
    </div>
  );
}
