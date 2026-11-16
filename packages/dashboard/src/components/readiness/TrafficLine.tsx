"use client";

import { Button } from "@/components/ui/Button";
import { HIDE, type ReadinessCheck, WHAT_MEAN, trafficWhy } from "@/lib/readiness";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Dot } from "./ReadinessList";

/**
 * The day-3 traffic line (readiness-check mock, section 04): on Results, in
 * the test card under the counted buttons. The dot and the API's sentence;
 * the API's action as a small secondary button; "What does that mean?" in
 * two lines behind a disclosure.
 */
export function TrafficLine({
  check,
  onAction,
  whyOpen = false,
  className,
}: {
  check: ReadinessCheck;
  /** The screen's own handler for the action; without one the API's href is the link. */
  onAction?: (() => void) | null;
  /** For the fixtures and tests: the disclosure open on arrival. */
  whyOpen?: boolean;
  className?: string;
}) {
  const action = check.action;
  const button = action
    ? onAction
      ? { label: action.label, onClick: onAction, href: null }
      : action.href
        ? { label: action.label, onClick: null, href: action.href }
        : null
    : null;
  return (
    <div className={cn("text-[13px]", className)} data-line="traffic">
      <div className="flex items-start gap-2.5">
        <Dot state={check.state} className="mt-[7px]" />
        <span className="min-w-0 flex-1 text-fg">{check.line}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:ml-[17px]">
        {button &&
          (button.onClick ? (
            <Button type="button" size="sm" variant="secondary" onClick={button.onClick}>
              {button.label}
            </Button>
          ) : (
            <Button asChild size="sm" variant="secondary">
              {button.href?.startsWith("/") ? (
                <Link href={button.href}>{button.label}</Link>
              ) : (
                <a href={button.href ?? "#"}>{button.label}</a>
              )}
            </Button>
          ))}
        <details className="group text-xs" open={whyOpen}>
          <summary className="cursor-pointer list-none text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">{WHAT_MEAN}</span>
            <span className="hidden group-open:inline">{HIDE}</span>
          </summary>
          <ul className="mt-2 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted">
            {trafficWhy(check.state).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
