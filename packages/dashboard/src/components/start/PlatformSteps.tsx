"use client";

import { RunningAds } from "@/components/links/AdLinks";
import { Codey } from "@/components/onboard/Codey";
import { TagCopy } from "@/components/onboard/TagCopy";
import { CopyBlock } from "@/components/ui/CopyBlock";
import {
  type WebflowPlan,
  connectSteps,
  defaultWebflowPlan,
  lovableMessage,
  notLine,
  pickerLabel,
  pickerOrder,
  platformMark,
  seenLine,
} from "@/lib/install";
import { cn } from "@/lib/utils";
import type { InstallPlatform, ProbeResponse } from "@/types/api";
import { useState } from "react";

/**
 * Connect, step 1 (install-friction mock, section 1): the platform the probe
 * names, that platform's three steps above the tag, and the tag. The heading
 * follows where the tag goes, so a Webflow free site is never told to find
 * a head it does not have. "Not Webflow?" opens the platform list for the
 * rare wrong guess. Until the first probe answers, the generic head steps
 * show.
 */

interface PlatformStepsProps {
  probe: ProbeResponse | null;
  tag: string;
  /** TagStatus, rendered under the tag. */
  children?: React.ReactNode;
  /**
   * The tag withheld (readiness-check mock, A7 and A9): the heading goes
   * quiet and this sits where the tag would be; no steps, no tag, no probe.
   */
  held?: React.ReactNode;
  /**
   * The ad lines without name macros (ads-platforms.md §2, privacy review
   * condition 2): a sensitive site or a yes to the question. Reduced when
   * the screen cannot tell.
   */
  adsReduced?: boolean;
}

export function PlatformSteps({
  probe,
  tag,
  children,
  held,
  adsReduced = true,
}: PlatformStepsProps) {
  const [picked, setPicked] = useState<InstallPlatform | null>(null);
  const [plan, setPlan] = useState<WebflowPlan | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const seen = probe?.install?.platform ?? null;
  const hosting = picked ? null : (probe?.install?.hosting ?? null);
  const platform = picked ?? seen;
  const webflowPlan = plan ?? defaultWebflowPlan(probe?.install?.tag_position);
  const steps = connectSteps(platform, webflowPlan);
  const seenText = platform ? seenLine(platform, hosting) : null;

  if (held) {
    return (
      <section className="border-t border-border py-5" data-step="tag-held">
        <h2 className="text-sm font-semibold text-fg-faint mb-1">
          1. <Codey text={connectSteps(null).heading} />
        </h2>
        {held}
      </section>
    );
  }

  return (
    <section className="border-t border-border py-5">
      <h2 className="text-sm font-semibold text-fg mb-1">
        1. <Codey text={steps.heading} />
      </h2>

      {platform === null ? (
        <p className="text-sm text-fg-muted mb-3 max-w-[60ch]">
          First line inside the head, exactly as written, no async. Nothing changes on the page yet.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-x-2.5 gap-y-2 flex-wrap mt-0.5 mb-3">
            {seenText && (
              <span className="inline-flex items-center gap-2 text-[13px] text-fg">
                <span
                  aria-hidden
                  className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-sm border border-border bg-surface font-mono text-[10px] text-fg-muted"
                >
                  {platformMark(platform)}
                </span>
                {picked ? `You picked ${pickerLabel(platform)}.` : seenText}
              </span>
            )}
            {platform === "webflow" && (
              <div className="order-3 basis-full sm:order-none sm:basis-auto">
                <Segmented
                  label="Webflow plan"
                  value={webflowPlan}
                  options={[
                    { value: "paid", label: "Paid site plan" },
                    { value: "free", label: "Free plan" },
                  ]}
                  onChange={(v) => setPlan(v)}
                />
              </div>
            )}
            <button
              type="button"
              className="text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg"
              aria-expanded={listOpen}
              onClick={() => setListOpen((v) => !v)}
            >
              {notLine(platform)}
            </button>
          </div>

          {listOpen && (
            <ul className="mb-3 max-w-[22rem] rounded-md border border-border bg-surface py-1 text-[13px]">
              {pickerOrder(seen).map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between px-4 py-2 text-left hover:bg-surface-muted",
                      p === platform && "bg-surface-muted",
                      p === "other" && "text-fg-muted",
                    )}
                    onClick={() => {
                      setPicked(p === seen ? null : p);
                      setListOpen(false);
                    }}
                  >
                    <span>{pickerLabel(p)}</span>
                    {p === seen && (
                      <span className="font-mono text-[11px] text-fg-muted">what we see</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {steps.steps.length > 0 && (
            <ol className="list-none m-0 mb-3 p-0 max-w-[62ch]">
              {steps.steps.map((s, i) => (
                <li
                  key={s}
                  className="relative py-[3px] pl-[22px] text-[13px] leading-relaxed text-fg"
                >
                  <span
                    aria-hidden
                    className="absolute left-0 top-[5px] font-mono text-[11px] text-fg-muted"
                  >
                    {i + 1}
                  </span>
                  <Codey text={s} />
                </li>
              ))}
            </ol>
          )}
          {steps.cost && (
            <div className="-mt-1 mb-3.5 pl-[22px] text-[12.5px] leading-relaxed text-fg-muted max-w-[62ch]">
              <p>{steps.cost}</p>
              {steps.more && (
                <details className="mt-1">
                  <summary className="cursor-pointer list-none inline underline decoration-dotted underline-offset-[3px] hover:text-fg">
                    {steps.more.summary}
                  </summary>
                  <span className="block mt-1">{steps.more.text}</span>
                </details>
              )}
            </div>
          )}
        </>
      )}

      {steps.message ? (
        <CopyBlock label="Message for Lovable" content={lovableMessage(tag)} multiline />
      ) : (
        <TagCopy label="Tag" content={tag} />
      )}
      {children}
      {/* Ad links (ads-platforms mock, section 03): under the tag's status line,
          closed by default; the reduced lines for a special-category site. */}
      <RunningAds reduced={adsReduced} />
    </section>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
}

/** The dashboard's segmented control (Topbar window selector look). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
}: SegmentedProps<T>) {
  return (
    <fieldset
      className={cn(
        "m-0 inline-flex w-max min-w-0 gap-0.5 rounded-sm border border-border bg-surface-muted p-0.5",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-[22px] whitespace-nowrap rounded-[3px] border px-[9px] text-xs transition-colors duration-fast ease-smooth disabled:opacity-50",
              on
                ? "border-border-strong bg-surface font-medium text-fg"
                : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
