"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { Brand } from "@/components/shell/Brand";
import { CurrentUserProvider, useCurrentUser } from "@/components/shell/CurrentUserContext";
import { CustomerListProvider } from "@/components/shell/CustomerListContext";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import Link from "next/link";
import type { FirstRunStep } from "./steps";
import { TINT } from "./tones";

/**
 * The shell a customer sees until their site is live (docs/specs/first-run.md):
 * no sidebar, no customer switcher, a three-step strip in the top bar. The
 * full dashboard opens after go-live. A superadmin walking a customer
 * through it keeps a way back.
 */

const STEPS: { key: FirstRunStep; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "look", label: "Look" },
  { key: "live", label: "Go live" },
];

function Stepper({ current }: { current: FirstRunStep }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-3.5 sm:gap-7 list-none m-0 p-0" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const done = i < currentIndex;
        const on = i === currentIndex;
        return (
          <li
            key={s.key}
            className={cn(
              "flex items-center gap-2 text-[13px]",
              on ? "text-fg font-medium" : done ? "text-fg-muted" : "text-fg-faint",
            )}
            aria-current={on ? "step" : undefined}
          >
            <span
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-mono",
                on && "bg-cta-bg text-cta-fg border-cta-bg",
                done && cn(TINT.ok, "border-transparent"),
                !on && !done && "border-border-strong",
              )}
            >
              {done ? <Check size={11} /> : i + 1}
            </span>
            {/* On a phone only the current step keeps its label, so the bar fits. */}
            <span className={cn(!on && "sr-only sm:not-sr-only")}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Bar({ domain, current }: { domain: string; current: FirstRunStep | null }) {
  const { user } = useCurrentUser();
  return (
    <header className="h-topbar-h border-b border-border bg-surface flex items-center justify-between gap-3 px-4 sm:px-content-px">
      <div className="flex items-center gap-2 min-w-0">
        <Brand className="text-sm font-semibold text-fg tracking-tight" />
        {domain && (
          <span className="text-sm text-fg-faint truncate hidden sm:inline">{domain}</span>
        )}
      </div>
      {current && <Stepper current={current} />}
      <div className="text-xs text-fg-faint hidden sm:block">
        {user?.role === "superadmin" ? (
          <Link href="/" className="underline decoration-dotted underline-offset-2 hover:text-fg">
            Back to dashboard
          </Link>
        ) : (
          (user?.email ?? "")
        )}
      </div>
    </header>
  );
}

interface FirstRunShellProps {
  domain: string;
  /** Null: the bar without the steps (an ended audit, mock section 11). */
  current: FirstRunStep | null;
  /** A line under the bar on every screen (the free audit's strip). */
  strip?: React.ReactNode;
  children: React.ReactNode;
}

/** The frame: top bar with the stepper, one column of content. Needs the providers above it. */
export function FirstRunShell({ domain, current, strip, children }: FirstRunShellProps) {
  return (
    <div className="min-h-dvh bg-bg">
      <Bar domain={domain} current={current} />
      {strip}
      <main className="max-w-[760px] px-4 py-5 sm:px-content-px sm:py-8">{children}</main>
    </div>
  );
}

/**
 * Auth and data providers for the first run, mounted once above the flow so
 * the flow's own hooks read real context (a hook above its provider gets the
 * default value and never leaves "loading"; seen live on 2026-09-12).
 */
export function FirstRunProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <CurrentUserProvider>
        <CustomerListProvider>{children}</CustomerListProvider>
      </CurrentUserProvider>
    </AuthGuard>
  );
}
