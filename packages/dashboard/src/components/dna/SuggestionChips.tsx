"use client";

import { cn } from "@/lib/utils";
import type { DnaSuggestion } from "@rawuser/shared";

interface SuggestionChipsProps {
  items: DnaSuggestion[];
  /** Entries already in the list; matching chips are hidden. */
  existing: string[];
  disabled?: boolean;
  onPick: (text: string) => void;
}

/**
 * Candidates read from the customer's own site, one row per brief list.
 * Dashed border says "not yet yours"; click makes it a list item. The
 * evidence quote sits in the tooltip so the operator can see the words on
 * their page that back it. No label: the source line at the top of the tab
 * names the site once.
 */
export function SuggestionChips({ items, existing, disabled, onPick }: SuggestionChipsProps) {
  const taken = new Set(existing.map((e) => e.trim().toLowerCase()));
  const visible = items.filter((i) => !taken.has(i.text.trim().toLowerCase()));
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((item) => (
        <button
          key={item.text}
          type="button"
          disabled={disabled}
          title={`On your page: “${item.evidence}”`}
          onClick={() => onPick(item.text)}
          className={cn(
            "rounded-sm border border-dashed border-border-strong px-2 py-1 text-xs text-fg-muted",
            "transition-colors duration-fast ease-smooth",
            "hover:border-solid hover:border-fg hover:text-fg",
            "disabled:opacity-40 disabled:pointer-events-none",
          )}
        >
          {item.text}
        </button>
      ))}
    </div>
  );
}

interface UseSuggestionProps {
  text: string | null;
  current: string;
  onUse: (text: string) => void;
  /** "input" centres the button vertically; "textarea" pins it to the top. */
  variant?: "input" | "textarea";
}

/**
 * The single-field pattern: the suggestion is the field's placeholder, and
 * this small "Use" sits inside the box until the operator types. One line,
 * no extra row under the field.
 */
export function UseSuggestion({ text, current, onUse, variant = "input" }: UseSuggestionProps) {
  if (!text || current.trim()) return null;
  return (
    <button
      type="button"
      onClick={() => onUse(text)}
      className={cn(
        "absolute right-2 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-fg-muted",
        "border border-transparent hover:border-border-strong hover:text-fg bg-surface",
        variant === "input" ? "top-1/2 -translate-y-1/2" : "top-2",
      )}
    >
      Use
    </button>
  );
}
