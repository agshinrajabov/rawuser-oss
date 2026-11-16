"use client";

import { Button } from "@/components/ui/Button";
import type { NextStep } from "@/lib/results";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

/**
 * "What to do next" (results-page mock): up to three steps, the biggest
 * first, each a title, one fact and one button.
 */
export function NextSteps({
  steps,
  customerId,
  onTag,
}: {
  steps: NextStep[];
  customerId: string;
  onTag: () => void;
}) {
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby="next-h" className="mt-8 sm:mt-10">
      <h2 id="next-h" className="text-[15px] font-semibold tracking-[-0.005em] text-fg">
        What to do next
      </h2>
      <ol className="mt-3 rounded-md border border-border bg-surface">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2.5 border-t border-border px-4 py-3.5 first:border-t-0 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:gap-x-3.5 sm:px-5"
          >
            <span className="self-start pt-0.5 font-mono text-[11px] text-fg-muted">{i + 1}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-[-0.005em] text-fg">{s.title}</p>
              <p className="mt-0.5 text-[13px] leading-normal text-fg-muted">{s.fact}</p>
            </div>
            <div className="col-start-2 justify-self-start sm:col-start-3 sm:justify-self-end">
              <StepAction step={s} customerId={customerId} onTag={onTag} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StepAction({
  step,
  customerId,
  onTag,
}: {
  step: NextStep;
  customerId: string;
  onTag: () => void;
}) {
  const a = step.action;
  const arrow = <ArrowRight size={14} className="text-fg-muted" aria-hidden />;
  if (a.kind === "tag") {
    return (
      <Button type="button" variant="secondary" onClick={onTag} className="whitespace-nowrap">
        {step.button}
        {arrow}
      </Button>
    );
  }
  return (
    <Button asChild variant="secondary" className="whitespace-nowrap">
      <Link href={`/start?customer_id=${encodeURIComponent(customerId)}`}>
        {step.button}
        {arrow}
      </Link>
    </Button>
  );
}
