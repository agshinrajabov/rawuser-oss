"use client";

import { Codey } from "@/components/onboard/Codey";
import { Button } from "@/components/ui/Button";
import { CopyBlock } from "@/components/ui/CopyBlock";
import { apiFetch } from "@/lib/api";
import { dayTime } from "@/lib/install";
import {
  PRE_BACKSTOP_LINE,
  PRE_CHECK_FAILED,
  PRE_CONSENT_LINE,
  PRE_LEAD,
  PRE_REPASTE_COST_LINE,
  PRE_STALE_LINE,
  WHERE_STEPS,
  checkPre,
  preCspLines,
  preForms,
  preNeedsCheck,
  preStatus,
  preView,
  readPre,
} from "@/lib/pre-paste";
import { cn } from "@/lib/utils";
import type { PreFormId, PrePasteResponse } from "@/types/api";
import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "./PlatformSteps";
import { TINT } from "./tones";

/**
 * The two-part tag on the Pages card (mock
 * design/mock/sales-readiness/two-part-tag.html, approved 2026-10-26;
 * docs/specs/faster-tag.md step 6, "API contract (generation)"). Only after
 * go live; Connect keeps the one-line tag. A stale paste is one amber line
 * under the card's intro that opens in place with the new style; the offer
 * and the current state sit at the card's foot.
 */

/** The answer for one customer, loaded once; `set` takes a check's answer. */
export function usePrePaste(customerId: string): {
  answer: PrePasteResponse | null;
  set: (a: PrePasteResponse) => void;
} {
  const [answer, setAnswer] = useState<PrePasteResponse | null>(null);
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    void readPre(customerId, apiFetch).then((a) => {
      if (!cancelled) setAnswer(a);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  return { answer, set: setAnswer };
}

interface TwoPartProps {
  customerId: string;
  answer: PrePasteResponse;
  onAnswer: (a: PrePasteResponse) => void;
  /** For the tests: open on arrival. */
  defaultOpen?: boolean;
}

function useCheck(customerId: string, onAnswer: (a: PrePasteResponse) => void) {
  const [state, setState] = useState<"idle" | "checking" | "failed">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async () => {
    setState("checking");
    const a = await checkPre(customerId, apiFetch);
    if (!mounted.current) return;
    if (a) {
      onAnswer(a);
      setState("idle");
    } else setState("failed");
  }, [customerId, onAnswer]);
  return { state, run };
}

/** Reads the exact policy lines once the paste is shown, when the API says it must. */
function useLinesOnOpen(open: boolean, answer: PrePasteResponse, run: () => Promise<void>) {
  const asked = useRef(false);
  useEffect(() => {
    if (!open || asked.current || !preNeedsCheck(answer)) return;
    asked.current = true;
    void run();
  }, [open, answer, run]);
}

const LINK = "underline decoration-dotted underline-offset-[3px] whitespace-nowrap";

function ConsentLine() {
  return (
    <p className="flex items-start gap-2 text-[13px] text-fg" data-line="pre-consent">
      <ShieldCheck size={14} className="mt-[3px] flex-none text-fg-muted" aria-hidden />
      <span>{PRE_CONSENT_LINE}</span>
    </p>
  );
}

function BeforeYouChoose() {
  return (
    <details className="group text-[12.5px] text-fg-muted" data-line="pre-before">
      <summary className={cn("cursor-pointer list-none [&::-webkit-details-marker]:hidden", LINK)}>
        Before you choose
      </summary>
      <div className="mt-1.5 flex max-w-[62ch] flex-col gap-1 border-l border-border pl-3 text-fg">
        <p>{PRE_BACKSTOP_LINE}</p>
        <p>{PRE_REPASTE_COST_LINE}</p>
      </div>
    </details>
  );
}

function PolicyLine({ answer, fresh }: { answer: PrePasteResponse; fresh: boolean }) {
  const lines = preCspLines(answer);
  if (lines.length === 0) return null;
  const hash = answer.csp?.hash ?? "";
  return (
    <div className="flex flex-col gap-2" data-line="pre-csp">
      <p className="text-[13px] text-fg">Your security policy blocks the style. Add this line.</p>
      {lines.map((l) => (
        <CopyBlock
          key={l}
          label={fresh ? "New line for your policy" : "One line for your policy"}
          content={l}
          highlight={hash ? [hash] : undefined}
          multiline
        />
      ))}
      <p className="text-[12.5px] text-fg-muted">The marked hash is the style's.</p>
    </div>
  );
}

function StatusRow({
  answer,
  check,
}: {
  answer: PrePasteResponse;
  check: { state: "idle" | "checking" | "failed"; run: () => Promise<void> };
}) {
  const status = preStatus(answer);
  return (
    <div className="flex min-h-6 flex-wrap items-center gap-2 text-[13px]">
      {status && (
        <>
          {status.tone === "ok" ? (
            <Check size={16} className="flex-none text-state-success" aria-hidden />
          ) : status.tone === "warn" ? (
            <AlertTriangle size={16} className="flex-none text-state-warn" aria-hidden />
          ) : null}
          <span className={status.tone === "muted" ? "text-fg-muted" : "text-fg"}>
            {status.text}
          </span>
        </>
      )}
      {answer.probed_at !== null && (
        <span className="text-xs text-fg-faint">checked {dayTime(answer.probed_at)}</span>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="ml-auto"
        disabled={check.state === "checking"}
        onClick={() => void check.run()}
      >
        {check.state === "checking" && <Loader2 size={12} className="animate-spin" />}
        {check.state === "checking" ? "Checking" : "Check again"}
      </Button>
      {check.state === "failed" && (
        <p className="basis-full text-xs text-fg-muted">{PRE_CHECK_FAILED}</p>
      )}
    </div>
  );
}

function StyleBlock({ answer, fresh }: { answer: PrePasteResponse; fresh: boolean }) {
  const style = answer.paste?.style ?? "";
  return (
    <CopyBlock
      label={fresh ? "New style, replaces the old" : "1 · Style"}
      content={style}
      meta={`${style.length.toLocaleString("en-US")} characters`}
      clamp
    />
  );
}

/**
 * The stale paste (mock section 05): one amber line under the intro, the
 * new style, its policy line when the API says the site needs one, Check
 * again. The consent line sits above the style here too (privacy review, build).
 */
export function PreStaleNote({ customerId, answer, onAnswer, defaultOpen = false }: TwoPartProps) {
  const [open, setOpen] = useState(defaultOpen);
  const check = useCheck(customerId, onAnswer);
  useLinesOnOpen(open, answer, check.run);
  if (preView(answer).kind !== "stale") return null;
  return (
    <div className="mb-2.5 mt-0.5 text-xs" data-line="pre-stale">
      <p className={cn("rounded-sm px-2 py-1 leading-normal", TINT.warn)}>
        {PRE_STALE_LINE}{" "}
        <button
          type="button"
          className={LINK}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Show the new paste"}
        </button>
      </p>
      {open && (
        <div className="mt-1.5 flex flex-col gap-3 rounded-md border border-[color-mix(in_srgb,var(--state-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_5%,transparent)] px-3.5 py-3">
          <p className="text-[12.5px] text-fg-muted">
            Until you paste it, pages with new parts show as built.
          </p>
          <ConsentLine />
          <StyleBlock answer={answer} fresh />
          {check.state === "checking" && preNeedsCheck(answer) ? (
            <p className="flex items-center gap-2 text-[13px] text-fg-muted">
              <Loader2 size={14} className="animate-spin" /> Reading your policy
            </p>
          ) : (
            <PolicyLine answer={answer} fresh />
          )}
          <p className="text-[12.5px] text-fg-muted">The script line stays as it is.</p>
          <BeforeYouChoose />
          <StatusRow answer={answer} check={check} />
        </div>
      )}
    </div>
  );
}

/**
 * The offer, the current paste and "not yet", at the card's foot. Closed,
 * one line; open, the steps for the platform, the consent line, the two
 * parts, the policy line beside the style when needed, and Check again.
 */
export function TwoPartTag({ customerId, answer, onAnswer, defaultOpen = false }: TwoPartProps) {
  const view = preView(answer);
  // A paste the policy refuses opens with its line (mock section 03).
  const [open, setOpen] = useState(defaultOpen || answer.csp?.refused === true);
  const { chosen, forms } = preForms(answer);
  const [form, setForm] = useState<PreFormId>(chosen);
  const check = useCheck(customerId, onAnswer);
  useLinesOnOpen(open, answer, check.run);

  if (view.kind === "hidden" || view.kind === "stale") return null;

  if (view.kind === "not_yet") {
    return (
      <section className="mt-3 border-t border-border pt-3 text-[13px]" data-line="pre-not-yet">
        <p className="text-fg-muted">
          <span className="font-medium text-fg">Two-part tag.</span> Not yet for {view.platform}.
        </p>
      </section>
    );
  }

  if (view.kind === "current" && !answer.csp?.refused) {
    return (
      <section className="mt-3 border-t border-border pt-3" data-line="pre-current">
        <p className="mb-1 text-[13px] font-medium text-fg">Two-part tag</p>
        <StatusRow answer={answer} check={check} />
      </section>
    );
  }

  const ready = forms.filter((f) => f.ready);
  const notYet = forms.filter((f) => !f.ready);
  const current = ready.find((f) => f.id === form) ?? ready[0];
  const policy = preCspLines(answer).length > 0;

  return (
    <section className="mt-3 border-t border-border pt-3 text-[13px]" data-line="pre-offer">
      <p className="text-fg">
        <span className="font-medium">Two-part tag.</span> {PRE_LEAD}{" "}
        <button
          type="button"
          className={cn("text-xs", LINK)}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Show the two-part tag"}
        </button>
      </p>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Segmented
              label="Where your site is built"
              value={current?.id ?? "html"}
              options={ready.map((f) => ({ value: f.id, label: f.name }))}
              onChange={setForm}
            />
            {notYet.length > 0 && (
              <span className="text-xs text-fg-faint">
                {notYet.map((f) => f.name).join(", ")}: not yet
              </span>
            )}
          </div>
          {current && (
            <ol className="flex max-w-[62ch] list-decimal flex-col gap-1 pl-5 text-fg marker:font-mono marker:text-[11px] marker:text-fg-muted">
              {current.where.map((w) => (
                <li key={w}>
                  <Codey text={WHERE_STEPS[w]} />
                </li>
              ))}
              <li>Publish, then check again here.</li>
            </ol>
          )}
          <div
            className={cn(
              "grid gap-4",
              policy && "md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:items-start",
            )}
          >
            <div className="flex min-w-0 flex-col gap-3">
              <ConsentLine />
              <StyleBlock answer={answer} fresh={false} />
              <CopyBlock
                label="2 · Script"
                content={answer.paste?.script ?? ""}
                // "async " alone: "data-cfasync" holds the word too.
                highlight={["async "]}
                multiline
              />
            </div>
            {check.state === "checking" && preNeedsCheck(answer) ? (
              <p className="flex items-center gap-2 text-fg-muted">
                <Loader2 size={14} className="animate-spin" /> Reading your policy
              </p>
            ) : policy ? (
              <div className="min-w-0 md:border-l md:border-border md:pl-4">
                <PolicyLine answer={answer} fresh={false} />
              </div>
            ) : null}
          </div>
          <BeforeYouChoose />
          <StatusRow answer={answer} check={check} />
        </div>
      )}
    </section>
  );
}
