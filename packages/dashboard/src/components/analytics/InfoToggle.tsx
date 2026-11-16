"use client";

import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * A small "i" that shows one caveat on click or tap, and closes on Escape
 * or a click elsewhere. The Results page keeps its caveats here so each
 * element reads as one short line (founder, 2026-10-04).
 */
export function InfoToggle({
  label,
  children,
  align = "left",
}: {
  /** Read by screen readers: what the note is about. */
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full text-fg-faint transition-colors duration-fast ease-smooth hover:text-fg",
          open && "text-fg",
        )}
      >
        <Info size={13} aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={cn(
            "absolute top-[calc(100%+6px)] z-30 w-[260px] max-w-[calc(100vw-48px)] whitespace-normal rounded-md border border-border bg-surface px-3 py-2.5 text-left font-sans text-xs font-normal leading-normal text-fg-muted",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
