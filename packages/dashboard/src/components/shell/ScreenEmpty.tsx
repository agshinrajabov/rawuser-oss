"use client";

import { Button } from "@/components/ui/Button";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";

/**
 * A teaching empty state (ADR 0024). Used when a screen has nothing to show yet
 * — no customer selected, no data — instead of a cold form/table or a terse
 * one-liner. Names the space, explains it in one line, and offers the next
 * action. Follows the centered-card pattern from customers/page.tsx.
 */
export function ScreenEmpty({
  icon: Icon,
  title,
  body,
  cta,
}: {
  icon?: LucideIcon;
  title: string;
  body: string;
  cta?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 border border-border rounded-md bg-surface">
      {Icon && (
        <div className="mb-3 text-fg-faint">
          <Icon size={22} strokeWidth={1.75} />
        </div>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="text-xs text-fg-muted mt-1 max-w-sm leading-relaxed">{body}</p>
      {cta && (
        <Button asChild size="sm" className="mt-4">
          <Link href={cta.href}>{cta.label}</Link>
        </Button>
      )}
    </div>
  );
}
