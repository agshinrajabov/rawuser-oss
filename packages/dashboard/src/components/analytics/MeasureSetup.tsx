"use client";

import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import {
  LIST_PATH,
  type SetupSteps,
  type StepMode,
  chosenText,
  postTest,
  setupSteps,
} from "@/lib/measure";
import { cn } from "@/lib/utils";
import type { ConversionTarget, ConversionsListResponse, LiftReport } from "@/types/api";
import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProofData } from "./ProofSection";

/**
 * "Measure what Rawuser brings" (mock design/mock/sales-readiness/
 * measure-setup.html, sections 01, 02 and 04, approved 2026-10-04): three
 * steps under "Is it working?" while no test has run. Each has one line and
 * one button, and opens when the one before is done. Start test starts at
 * once; its line is the cost. On a phone the steps stack and a locked step
 * hides its button, so there is one button at a time.
 */

// ---------------------------------------------------------------------------
// Data: the customer's buttons, and the start and stop calls
// ---------------------------------------------------------------------------

/** GET /admin/conversions/list, customer-scoped; null while loading or when it failed. */
export function useButtons(customerId: string): {
  items: ConversionTarget[] | null;
  setItems: (items: ConversionTarget[]) => void;
} {
  const [items, setItems] = useState<ConversionTarget[] | null>(null);
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    setItems(null);
    apiFetch<ConversionsListResponse>(`${LIST_PATH}?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  return { items, setItems };
}

export interface TestAction {
  busy: "start" | "stop" | null;
  /** The API's own sentence on a refusal (409), or a plain failure line. */
  said: string | null;
  /** `anyway` only from "Start anyway" (too little traffic). */
  run: (action: "start" | "stop", opts?: { anyway?: boolean }) => Promise<boolean>;
  clear: () => void;
}

/** Start test and Stop test: one call each, the answer's report shown at once. */
export function useTestAction(customerId: string, proof: ProofData): TestAction {
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const { apply } = proof;
  const run = useCallback(
    async (action: "start" | "stop", opts?: { anyway?: boolean }) => {
      setBusy(action);
      setSaid(null);
      const out = await postTest(customerId, action, undefined, opts);
      setBusy(null);
      if (out.kind === "ok") {
        apply(out.report);
        return true;
      }
      setSaid(out.kind === "refused" ? out.sentence : out.message);
      return false;
    },
    [customerId, apply],
  );
  const clear = useCallback(() => setSaid(null), []);
  return { busy, said, run, clear };
}

// ---------------------------------------------------------------------------
// The three steps
// ---------------------------------------------------------------------------

interface MeasureSetupProps {
  report: LiftReport;
  items: ConversionTarget[] | null;
  test: TestAction;
  onChoose: () => void;
}

export function MeasureSetup({ report, items, test, onChoose }: MeasureSetupProps) {
  const steps: SetupSteps = setupSteps(report, items, Date.now());
  const { choose, start, result } = steps;

  return (
    <ol
      aria-label="Measure what Rawuser brings"
      className="m-0 grid list-none grid-cols-1 overflow-hidden rounded-md border border-border bg-surface p-0 sm:grid-cols-3"
    >
      <Step n={1} mode={choose.mode} title="Choose the button to count">
        {choose.chosen ? (
          <p className="mt-1.5 pl-8 text-[13px] leading-normal text-fg-muted">
            <b className="font-medium text-fg">{chosenText(choose.chosen)}</b>
            {choose.chosen.place && ` · ${choose.chosen.place}`}
          </p>
        ) : (
          <StepLine>{choose.line}</StepLine>
        )}
        <StepActions mode={choose.mode}>
          {choose.mode === "done" ? (
            <QuietButton onClick={onChoose}>Change</QuietButton>
          ) : (
            <Button type="button" onClick={onChoose}>
              Choose button
            </Button>
          )}
        </StepActions>
      </Step>

      <Step n={2} mode={start.mode} title="Start the test">
        <StepLine>{start.line}</StepLine>
        {start.button && (
          <StepActions mode={start.mode}>
            <Button
              type="button"
              variant={start.button.primary ? "default" : "secondary"}
              disabled={!start.button.enabled || test.busy !== null}
              onClick={() => void test.run("start")}
            >
              {test.busy === "start" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              )}
              Start test
            </Button>
          </StepActions>
        )}
        <div aria-live="polite" className="pl-8">
          {test.said && <Said>{test.said}</Said>}
        </div>
      </Step>

      <Step n={3} mode={result.mode} title="Get the result">
        <StepLine>{result.line}</StepLine>
      </Step>
    </ol>
  );
}

function Step({
  n,
  mode,
  title,
  children,
}: {
  n: number;
  mode: StepMode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li
      aria-current={mode === "on" ? "step" : undefined}
      className={cn(
        "relative flex flex-col px-4 pb-4 pt-3.5 sm:min-h-[150px] sm:px-5 sm:pb-[18px] sm:pt-4",
        "border-t border-border first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0",
        mode === "on" && "shadow-[inset_2px_0_0_var(--fg)] sm:shadow-[inset_0_2px_0_var(--fg)]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border font-mono text-[11px] font-medium leading-none",
            mode === "on" && "border-fg bg-surface text-fg",
            mode === "done" && "border-fg bg-fg text-surface",
            mode === "locked" && "border-dashed border-border-strong bg-surface text-fg-muted",
          )}
        >
          {mode === "done" ? <Check size={12} strokeWidth={2.25} /> : n}
        </span>
        <h3
          className={cn(
            "text-sm tracking-[-0.005em]",
            mode === "locked" ? "font-medium text-fg-muted" : "font-semibold text-fg",
          )}
        >
          {title}
          {mode === "done" && <span className="sr-only"> (done)</span>}
        </h3>
      </div>
      {children}
    </li>
  );
}

function StepLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 max-w-[34ch] pl-8 text-[13px] leading-normal text-fg-muted">{children}</p>
  );
}

/** A locked step's button shows on a wide screen only; a phone shows one button at a time. */
function StepActions({ mode, children }: { mode: StepMode; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mt-auto flex-wrap items-center gap-3 pl-8 pt-3 sm:pt-4",
        mode === "locked" ? "hidden sm:flex" : "flex",
      )}
    >
      {children}
    </div>
  );
}

export function QuietButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="whitespace-nowrap rounded-sm text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] transition-colors duration-fast hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** The API's sentence, as it came: amber, AA on the page ground. */
export function Said({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-2 block text-[12.5px] leading-normal text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]">
      {children}
    </span>
  );
}
