"use client";

import {
  BEFORE_HEADING,
  HIDE,
  READY_LINE,
  type ReadinessCheck,
  type ReadinessState,
  SHOW_CHECKS,
  countWords,
  listFolded,
  readinessCount,
} from "@/lib/readiness";
import { cn } from "@/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The readiness list (readiness-check mock, sections 01, 02 and 05): plain
 * lines with a dot, the API's sentence, the API's action label as a quiet
 * link at the end of the line. No card, no heading beyond "Before you go
 * live". Red first, then amber, green, grey; the list opens by itself when
 * a line is amber or red and folds to one line when every line is green.
 */

const DOT: Record<ReadinessState, string> = {
  green: "bg-state-success",
  amber: "bg-state-warn",
  red: "bg-state-err",
  grey: "border-[1.5px] border-fg-faint bg-transparent",
};

export function Dot({ state, className }: { state: ReadinessState; className?: string }) {
  return (
    <span
      aria-hidden
      data-dot={state}
      className={cn("inline-block h-[7px] w-[7px] flex-none rounded-full", DOT[state], className)}
    />
  );
}

/** The small mono mark after a line the customer never sees (A18, A20). */
export function Mark({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 inline-block rounded-[3px] border border-border px-1 py-px align-[1px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-faint">
      {children}
    </span>
  );
}

const QUIET =
  "ml-2 whitespace-nowrap rounded-sm text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]";

/** The action at the end of a line: handled in place, or the API's href. */
export type LineAction =
  | { kind: "click"; label: string; onClick: () => void; expanded?: boolean }
  | { kind: "href"; label: string; href: string };

/**
 * The action for a check: the screen's own handler when it has one for
 * this id (the label reads "Hide" while what it opened is open), else the
 * API's href, else none. The label is always the API's.
 */
export function actionFor(
  check: ReadinessCheck,
  inPlace?: (c: ReadinessCheck) => (() => void) | null,
  open = false,
): LineAction | null {
  if (!check.action) return null;
  const handler = inPlace?.(check) ?? null;
  if (handler) {
    return {
      kind: "click",
      label: open ? HIDE : check.action.label,
      onClick: handler,
      expanded: open,
    };
  }
  if (check.action.href)
    return { kind: "href", label: check.action.label, href: check.action.href };
  return null;
}

function Action({ action }: { action: LineAction }) {
  if (action.kind === "click") {
    return (
      <button
        type="button"
        className={QUIET}
        onClick={action.onClick}
        aria-expanded={action.expanded === undefined ? undefined : action.expanded}
      >
        {action.label}
      </button>
    );
  }
  if (action.href.startsWith("/")) {
    return (
      <Link href={action.href} className={QUIET}>
        {action.label}
      </Link>
    );
  }
  return (
    <a href={action.href} className={QUIET}>
      {action.label}
    </a>
  );
}

export interface ReadinessLineProps {
  check: ReadinessCheck;
  action?: LineAction | null;
  /** Marks after the sentence, superadmin views only. */
  marks?: string[];
  /** What the action opened, under the line (the tag with Copy, the question). */
  children?: ReactNode;
}

export function ReadinessLine({ check, action = null, marks = [], children }: ReadinessLineProps) {
  return (
    <li
      className="grid grid-cols-[7px_minmax(0,1fr)] items-start gap-x-2.5 py-1 text-[13px] leading-normal"
      data-check={check.id}
      data-state={check.state}
    >
      <Dot state={check.state} className="mt-[7px]" />
      <div className="min-w-0">
        <span className={check.state === "grey" ? "text-fg-muted" : "text-fg"}>{check.line}</span>
        {marks.map((m) => (
          <Mark key={m}>{m}</Mark>
        ))}
        {action && <Action action={action} />}
        {children && <div className="mt-1.5 sm:ml-[17px]">{children}</div>}
      </div>
    </li>
  );
}

export interface ReadinessListProps {
  checks: readonly ReadinessCheck[];
  /** The screen's in-place handlers by id; a check without one takes the API's href. */
  inPlace?: (c: ReadinessCheck) => (() => void) | null;
  /** Which check's in-place action is open (its label reads Hide). */
  openId?: string | null;
  /** What sits under the open check. */
  openContent?: ReactNode;
  marksFor?: (c: ReadinessCheck) => string[];
  className?: string;
}

export function ReadinessList({
  checks,
  inPlace,
  openId = null,
  openContent,
  marksFor,
  className,
}: ReadinessListProps) {
  return (
    <ul className={cn("m-0 list-none p-0", className)} data-list="readiness">
      {checks.map((c) => {
        const open = openId === c.id;
        return (
          <ReadinessLine
            key={c.id}
            check={c}
            action={actionFor(c, inPlace, open)}
            marks={marksFor?.(c) ?? []}
          >
            {open ? openContent : null}
          </ReadinessLine>
        );
      })}
    </ul>
  );
}

/** The customers list's one column (A19): "2 red 4 amber", "1 red", "Ready". */
export function CountWords({
  checks,
  className,
}: {
  checks: readonly ReadinessCheck[];
  className?: string;
}) {
  const words = countWords(readinessCount(checks));
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", className)}
      data-block="readiness-count"
    >
      {words.map((w, i) => (
        <span key={w.text} className={cn("inline-flex items-center gap-1.5", i > 0 && "ml-1")}>
          <Dot state={w.tone} />
          <span className={w.tone === "green" ? "text-fg-muted" : "text-fg"}>{w.text}</span>
        </span>
      ))}
    </span>
  );
}

export interface BeforeGoLiveProps extends Omit<ReadinessListProps, "className"> {
  /** For the fixtures and tests: the folded list open on arrival. */
  defaultOpen?: boolean;
}

/**
 * "Before you go live" on Look, above Go live (A1 to A4): the list open by
 * itself when a line is amber or red; folded to "Ready to go live." with
 * "Show the checks" when every line is green or grey.
 */
export function BeforeGoLive({ checks, defaultOpen = false, ...list }: BeforeGoLiveProps) {
  if (checks.length === 0) return null;
  const folded = listFolded(checks);
  return (
    <div className="mb-5" data-block="before-go-live">
      <p className="mb-1 text-[13px] font-semibold text-fg">{BEFORE_HEADING}</p>
      {folded ? (
        <details className="group" open={defaultOpen}>
          <summary className="flex cursor-pointer list-none items-center gap-2.5 py-1 text-[13px] [&::-webkit-details-marker]:hidden">
            <Dot state="green" />
            <span className="text-fg group-open:font-normal font-medium">{READY_LINE}</span>
            <span className="whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px]">
              <span className="group-open:hidden">{SHOW_CHECKS}</span>
              <span className="hidden group-open:inline">{HIDE}</span>
            </span>
          </summary>
          <ReadinessList checks={checks} {...list} className="mt-0.5" />
        </details>
      ) : (
        <ReadinessList checks={checks} {...list} />
      )}
    </div>
  );
}
