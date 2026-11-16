"use client";

/**
 * The shared parts of dashboard v2 (design/mock/dashboard-v2/app.html):
 * page header, segmented control, card, the "What these numbers mean"
 * disclosure, pills, the big sentence. Tokens from globals.css (ADR 0014)
 * only: hairlines, 4 and 6px radii, no shadows, no new colour.
 */

import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { siteHost } from "@/components/shell/Sidebar";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CustomerListItem } from "@/types/api";
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface Scope {
  /** The customer the screen reads: a customer's own, or the one picked in the top bar. */
  customerId: string;
  superadmin: boolean;
  customer: CustomerListItem | undefined;
  /** "acme.com". */
  host: string;
}

export function useScope(): Scope {
  const params = useSearchParams();
  const { user } = useCurrentUser();
  const { customers } = useCustomerList();
  const superadmin = user?.role === "superadmin";
  const customerId =
    user?.role === "customer" && user.customer_id
      ? user.customer_id
      : (params.get("customer_id") ?? "");
  const customer = customers.find((c) => c.id === customerId);
  return { customerId, superadmin, customer, host: siteHost(customer?.domain) || customerId };
}

/** GET a path; `{ empty: true }` reads as null. `path` null waits. */
export function useJson<T>(path: string | null): {
  data: T | null;
  loading: boolean;
  failed: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    apiFetch<T | { empty: true }>(path)
      .then((d) => {
        if (!cancelled) setData(d && typeof d === "object" && "empty" in d ? null : (d as T));
      })
      .catch(() => {
        if (!cancelled) {
          setData(null);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { data, loading, failed };
}

/** "updated 9 min ago". */
export function updatedAgo(at: number | null | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const min = Math.round((now - at) / 60_000);
  if (min < 2) return "updated just now";
  if (min < 60) return `updated ${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `updated ${h} h ago` : `updated ${Math.round(h / 24)} days ago`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHead({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-lg font-semibold tracking-[-0.005em] focus:outline-none">
          {title}
        </h1>
        {sub && <p className="mt-0.5 text-[12.5px] text-fg-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-md border border-border bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHead({ title, side }: { title: string; side?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pb-2.5 pt-3.5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {side && <span className="text-xs text-fg-muted">{side}</span>}
    </div>
  );
}

export function SectionHead({
  title,
  side,
  className,
}: {
  title: string;
  side?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-9 flex flex-wrap items-baseline justify-between gap-3", className)}>
      <h2 className="text-[15px] font-semibold tracking-[-0.005em]">{title}</h2>
      {side && <p className="text-[12.5px] text-fg-muted">{side}</p>}
    </div>
  );
}

/** A segmented control over values; `labels` in the same order. */
export function Seg<T extends string>({
  label,
  values,
  labels,
  value,
  onChange,
  className,
}: {
  label: string;
  values: readonly T[];
  labels?: Record<T, string> | ((v: T) => string);
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const text = (v: T) => (typeof labels === "function" ? labels(v) : labels ? (labels[v] ?? v) : v);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the mock draws it
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full gap-0.5 overflow-x-auto rounded-sm border border-border bg-surface-muted p-0.5",
        className,
      )}
    >
      {values.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex h-6 items-center whitespace-nowrap rounded-[3px] border px-2.5 text-xs transition-colors duration-fast ease-smooth",
            v === value
              ? "border-border-strong bg-surface font-medium text-fg"
              : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {text(v)}
        </button>
      ))}
    </div>
  );
}

/** "What these numbers mean": closed by default, lines inside. */
export function How({
  summary,
  children,
  className,
}: {
  summary: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group mt-3", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown
          size={14}
          aria-hidden
          className="transition-transform duration-medium ease-smooth group-open:rotate-180"
        />
        {summary}
      </summary>
      <div className="mt-2 flex max-w-[72ch] flex-col gap-1 rounded-sm border border-border bg-surface px-3 py-2.5 text-[12.5px] text-fg-muted">
        {children}
      </div>
    </details>
  );
}

const OK_TEXT = "text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]";
const OK_TINT = "bg-[color:color-mix(in_srgb,var(--state-success)_10%,transparent)]";
const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";
const WARN_TINT = "bg-[color:color-mix(in_srgb,var(--state-warn)_10%,transparent)]";

export const TONE = { OK_TEXT, OK_TINT, WARN_TEXT, WARN_TINT };

export function Pill({
  tone = "muted",
  live,
  children,
}: {
  tone?: "ok" | "warn" | "muted";
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 py-[5px] text-[11px] leading-none",
        tone === "ok" && `border-transparent ${OK_TINT} ${OK_TEXT}`,
        tone === "warn" && `border-transparent ${WARN_TINT} ${WARN_TEXT}`,
        tone === "muted" && "border-border bg-surface text-fg-muted",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          live && "motion-safe:animate-pulse",
          live && tone === "muted" && "bg-state-success",
        )}
      />
      {children}
    </span>
  );
}

/** The one bold move: the 27px sentence on Overview and Test (21px on a phone). */
export function BigLine({
  lead,
  tail,
  quiet,
  className,
}: {
  lead: string;
  tail?: string | null;
  /** Before an answer: the lead is a shade lighter. */
  quiet?: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "max-w-[31em] text-[21px] font-medium leading-[1.32] tracking-[-0.018em] [text-wrap:balance] sm:text-[27px] sm:leading-[1.28] sm:tracking-[-0.022em]",
        className,
      )}
    >
      <span className={quiet ? "text-[#3f3f46]" : undefined}>{lead}</span>
      {tail && <span className="font-normal text-fg-muted"> {tail}</span>}
    </p>
  );
}

/** One quiet line while a read is on its way, or after it failed. */
export function StateLine({ kind, children }: { kind: "loading" | "error"; children: string }) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "mt-4 text-[13px]",
        kind === "error" ? WARN_TEXT : "text-fg-muted motion-safe:animate-pulse",
      )}
    >
      {children}
    </p>
  );
}

/** An on and off switch (the mock's `.sw`): the track carries the state, no colour of its own. */
export function Switch({
  on,
  onChange,
  label,
  labelledBy,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-[18px] w-8 flex-none items-center rounded-pill border transition-colors duration-fast ease-smooth focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-40",
        on ? "border-fg bg-fg" : "border-border-strong bg-surface-muted",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-[2px] h-3 w-3 rounded-full transition-transform duration-fast ease-smooth motion-reduce:transition-none",
          on ? "translate-x-[16px] bg-surface" : "translate-x-[2px] bg-fg-muted",
        )}
      />
    </button>
  );
}
