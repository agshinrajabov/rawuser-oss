"use client";

/**
 * The line after a sign-in with a recovery code (two-step mock §07): how
 * many are left and a link to New recovery codes. Shown on the page the
 * person lands on, once per tab, dismissable (call 11); amber from 2 left
 * (call 7). Read once (role="status"), never focused on arrival.
 */

import { WARN_TEXT } from "@/components/account/TwoStepParts";
import { recoveryNotice, takeRecoveryNotice } from "@/lib/mfa";
import { cn } from "@/lib/utils";
import { KeyRound, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

export const NEW_CODES_HREF = "/account?codes=new";

export function RecoveryLineView({ left, onDismiss }: { left: number; onDismiss: () => void }) {
  const n = recoveryNotice(left);
  const warn = n.tone === "warn";
  return (
    <output
      className={cn(
        "mb-5 flex items-start gap-2.5 rounded-md border py-2.5 pl-3.5 pr-3 text-[13px] text-fg sm:items-center",
        warn
          ? "border-[color-mix(in_srgb,var(--state-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_9%,var(--surface))]"
          : "border-border bg-surface",
      )}
    >
      <KeyRound
        size={16}
        aria-hidden
        className={cn("mt-px shrink-0 sm:mt-0", warn ? WARN_TEXT : "text-fg-muted")}
      />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <span className="basis-full sm:basis-auto sm:flex-1">{n.text}</span>
        <Link
          href={NEW_CODES_HREF}
          className="whitespace-nowrap text-[12.5px] text-fg underline decoration-dotted underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {n.link}
        </Link>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex shrink-0 rounded-sm p-1 text-fg-faint hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
      >
        <X size={14} />
      </button>
    </output>
  );
}

export function RecoveryLine() {
  const [left, setLeft] = React.useState<number | null>(null);

  React.useEffect(() => {
    const n = takeRecoveryNotice();
    if (n !== null) setLeft(n);
  }, []);

  if (left === null) return null;
  return (
    <RecoveryLineView
      left={left}
      onDismiss={() => {
        setLeft(null);
        // Dismiss moves focus to the page heading (mock §08).
        const h = document.querySelector<HTMLElement>("main h1");
        if (h) {
          if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
          h.focus();
        }
      }}
    />
  );
}
