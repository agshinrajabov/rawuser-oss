"use client";

import { Button } from "@/components/ui/Button";
import {
  type AnswerOutcome,
  CHANGE,
  type ConnectCategory,
  HIDE,
  NO,
  QUESTION,
  type ReadinessState,
  WHY_LINES,
  WHY_WE_ASK,
  YES,
  answerSpecialCategory,
} from "@/lib/readiness";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Dot } from "./ReadinessList";

/**
 * The special-category question (readiness-check mock, section 03; check 3
 * of docs/specs/readiness-check.md with the privacy review's condition 2):
 * Yes or No and "Why we ask" in two lines, above the tag on Connect and as
 * a row on Look. The answer is a fact about the site, written once with
 * POST /admin/customers/special-category; a 409 is shown as written.
 */

const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";
const ERR_TEXT = "text-[color:color-mix(in_srgb,var(--state-err)_85%,black)]";

export interface QuestionRowProps {
  customerId: string;
  /** The amber line over the question when the page read gave one (A10). */
  prompt?: string | null;
  /** Called after the API took the answer. */
  onAnswered: (answer: boolean) => void;
  /** For the fixtures and tests: the disclosure open on arrival. */
  whyOpen?: boolean;
  /** Tests: the call. */
  answer?: typeof answerSpecialCategory;
  className?: string;
}

export function QuestionRow({
  customerId,
  prompt = null,
  onAnswered,
  whyOpen = false,
  answer = answerSpecialCategory,
  className,
}: QuestionRowProps) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function choose(value: boolean) {
    setBusy(value);
    setSaid(null);
    const out: AnswerOutcome = await answer(customerId, value);
    setBusy(null);
    if (out.kind === "ok") {
      onAnswered(value);
      return;
    }
    setSaid(out.kind === "refused" ? out.sentence : out.message);
  }

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2.5",
        prompt
          ? "border-[color-mix(in_srgb,var(--state-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_5%,transparent)]"
          : "border-border bg-surface",
        className,
      )}
      data-block="special-category"
    >
      {prompt && (
        <p className={cn("mb-1.5 flex items-start gap-2 text-[12.5px]", WARN_TEXT)}>
          <Dot state="amber" className="mt-[6px]" />
          <span>{prompt}</span>
        </p>
      )}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3.5">
        <span className="min-w-0 text-[13px] text-fg sm:flex-1 sm:basis-[320px]">{QUESTION}</span>
        <span className="flex flex-none gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void choose(false)}
          >
            {busy === false && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            {NO}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void choose(true)}
          >
            {busy === true && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            {YES}
          </Button>
        </span>
      </div>
      <details className="group mt-1.5 text-xs" open={whyOpen}>
        <summary className="cursor-pointer list-none text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">{WHY_WE_ASK}</span>
          <span className="hidden group-open:inline">{HIDE}</span>
        </summary>
        <ul className="mt-2 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted">
          {WHY_LINES.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
      <div aria-live="polite">
        {said && <p className={cn("mt-2 text-[12.5px]", WARN_TEXT)}>{said}</p>}
      </div>
    </div>
  );
}

/**
 * The answer as one line (A8, A9): green with Change after a No, red
 * after a Yes the site is not yet marked for, green once marked.
 */
export function AnsweredRow({
  state,
  line,
  onChange,
  className,
}: {
  state: ReadinessState;
  line: string;
  /** Change, after a No (A8). */
  onChange?: () => void;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2.5 py-1 text-[13px]",
        state === "red" ? ERR_TEXT : "text-fg",
        className,
      )}
      data-block="special-category-answer"
      data-state={state}
    >
      <Dot state={state} className="mt-[7px]" />
      <span>
        {line}
        {onChange && (
          <button
            type="button"
            onClick={onChange}
            className="ml-1 whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg"
          >
            {CHANGE}
          </button>
        )}
      </span>
    </p>
  );
}

/**
 * The question and its answer on Connect (A7 to A9): the question while
 * unanswered or after Change; one line after a No (with Change), after a
 * Yes not yet marked (red, no Change), after a Yes marked (green).
 */
export function ConnectQuestion({
  customerId,
  category,
  asking,
  onAsk,
  onAnswered,
  whyOpen,
  answer,
}: {
  customerId: string;
  category: ConnectCategory;
  /** Change pressed on the No row: the question again. */
  asking: boolean;
  onAsk: () => void;
  onAnswered: (answer: boolean) => void;
  whyOpen?: boolean;
  answer?: typeof answerSpecialCategory;
}) {
  if (category.kind === "ask" || asking) {
    return (
      <QuestionRow
        customerId={customerId}
        prompt={category.kind === "ask" ? category.prompt : null}
        onAnswered={onAnswered}
        whyOpen={whyOpen}
        answer={answer}
        className="mb-5"
      />
    );
  }
  if (category.kind === "no") {
    return <AnsweredRow state="green" line={category.line} onChange={onAsk} className="mb-3" />;
  }
  if (category.kind === "yes-held") {
    return <AnsweredRow state="red" line={category.line} className="mb-3" />;
  }
  return <AnsweredRow state="green" line={category.line} className="mb-3" />;
}

/** The dashed box where the tag would be while it is withheld (A7, A9). */
export function HeldBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-2 rounded-md border border-dashed border-border-strong px-3 py-2.5 text-[13px] text-fg-faint"
      data-block="tag-held"
    >
      {children}
    </div>
  );
}
