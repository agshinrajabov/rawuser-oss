"use client";

import { Dot } from "@/components/readiness/ReadinessList";
import { useReadiness } from "@/components/readiness/useReadiness";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  ADS_HEADING,
  ALSO_ON_LINKS,
  COPIED,
  COPIED_MS,
  COPY,
  GROUP_LABEL,
  REDUCED_WHY,
  RULE_NAMES,
  RULE_SEARCH,
  RUNNING_ADS,
  type Run,
  SUBTITLE_CONNECT,
  SUBTITLE_LINKS,
  WHAT_WE_READ,
  WHAT_WE_READ_LINES,
  WORD_LABEL,
  WORD_PLACEHOLDER,
  adGroups,
  adsReduced,
  alsoLine,
  asksWord,
  campaignWord,
  canCopy,
  copiedLine,
  lineParams,
  rowNote,
  shownLine,
  whereLine,
} from "@/lib/ad-links";
import { HIDE } from "@/lib/readiness";
import { cn } from "@/lib/utils";
import { AD_TEMPLATES, type AdPlatform, type AdTemplate } from "@rawuser/shared";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";

/**
 * Ad links, one line per platform (mock design/mock/sales-readiness/
 * ads-platforms.html, approved 2026-10-22; spec docs/specs/ads-platforms.md
 * §2). Two forms of the same rows: the ledger on Campaign links ("Your
 * ads", sections 01, 02, 04, A8, A9) and the tighter list inside Connect's
 * "Running ads?" (sections 03, A7, A10). The platform's own macros are
 * shaded; X's row carries the customer's campaign word.
 */

type Form = "links" | "connect";

const MACRO =
  "rounded-[2px] bg-surface-muted px-[2px] text-fg shadow-[inset_0_-1px_0_var(--border-strong)]";
const DONE = "text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]";
const QUIET_LINK = "underline decoration-dotted underline-offset-[3px]";

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) =>
        r.macro ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <span key={i} className={MACRO} data-macro="">
            {r.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <Fragment key={i}>{r.text}</Fragment>
        ),
      )}
    </>
  );
}

interface WordFieldProps {
  word: string;
  onWord: (w: string) => void;
}

/** X's campaign word, inline at the end of the line (mock A1, A2). */
function WordField({ word, onWord }: WordFieldProps) {
  const typed = word.length > 0;
  return (
    <input
      type="text"
      value={word}
      onChange={(e) => onWord(campaignWord(e.target.value))}
      aria-label={WORD_LABEL}
      placeholder={WORD_PLACEHOLDER}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      style={{ width: `${Math.max(word.length, WORD_PLACEHOLDER.length) + 1}ch` }}
      className={cn(
        "m-0 rounded-none border-0 border-b bg-[color-mix(in_srgb,var(--surface-muted)_60%,transparent)] px-[2px] py-0 align-baseline font-mono text-[length:inherit] leading-[inherit] text-fg outline-none placeholder:text-fg-faint focus-visible:border-solid focus-visible:border-fg",
        typed ? "border-solid border-fg-muted" : "border-dashed border-fg-faint",
      )}
      data-field="campaign-word"
    />
  );
}

interface LineProps {
  t: AdTemplate;
  reduced: boolean;
  word: string;
  onWord: (w: string) => void;
}

/** The parameters, one unbroken piece each, with a break allowed at every `&`. */
function Line({ t, reduced, word, onWord }: LineProps) {
  const params = lineParams(shownLine(t, reduced));
  const field = asksWord(t, reduced);
  return (
    <>
      {params.map((runs, i) => {
        const last = i === params.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parameters are positional
          <Fragment key={i}>
            {i > 0 && <wbr />}
            <span className="whitespace-nowrap">
              <Runs runs={runs} />
              {last && field && <WordField word={word} onWord={onWord} />}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

export interface AdRowProps {
  t: AdTemplate;
  form: Form;
  reduced: boolean;
  word: string;
  onWord: (w: string) => void;
  copied: boolean;
  onCopy: () => void;
  last?: boolean;
}

function CopyButton({
  label,
  copied,
  disabled,
  onCopy,
  form,
}: {
  label: string;
  copied: boolean;
  disabled: boolean;
  onCopy: () => void;
  form: Form;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      disabled={disabled}
      aria-label={`${copied ? COPIED : COPY}: ${label}`}
      className={cn(
        "gap-1.5",
        form === "connect" ? "h-6 px-2" : "px-2.5",
        copied ? DONE : "text-fg-muted hover:text-fg",
      )}
      data-copied={copied || undefined}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied ? COPIED : COPY}
    </Button>
  );
}

/**
 * One platform. 1280: the platform and where, the line, Copy, in three
 * columns. 390: the platform and Copy on top, the line full width below,
 * so Copy sits at the same place on every row (mock section 05).
 */
export function AdRow({ t, form, reduced, word, onWord, copied, onCopy, last }: AdRowProps) {
  const name = t.label;
  const also = alsoLine(t);
  const where = whereLine(t, form);
  const note = rowNote(t, reduced);
  const copy = (
    <CopyButton
      label={name}
      copied={copied}
      disabled={!canCopy(t, reduced, word)}
      onCopy={onCopy}
      form={form}
    />
  );

  if (form === "connect") {
    return (
      <div
        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border py-2 last:border-b sm:grid-cols-[150px_minmax(0,1fr)_auto] sm:gap-x-3.5 sm:gap-y-0.5"
        data-ad={t.platform}
      >
        <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-baseline gap-x-2 sm:block">
          <p className="text-[12.5px] font-medium text-fg">{name}</p>
          <p className="mt-px text-[11.5px] leading-snug text-fg-faint">{where}</p>
        </div>
        <div className="col-span-2 row-start-2 min-w-0 pt-px font-mono text-[11.5px] leading-relaxed text-fg [overflow-wrap:anywhere] sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <Line t={t} reduced={reduced} word={word} onWord={onWord} />
          {note && (
            <span className="mt-0.5 block font-sans text-[11.5px] text-fg-muted" data-note="">
              {note}
            </span>
          )}
        </div>
        <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">{copy}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-t border-border py-3 sm:grid-cols-[150px_minmax(0,1fr)_72px] sm:gap-y-1.5 xl:grid-cols-[200px_minmax(0,1fr)_80px] xl:gap-x-4",
        last && "border-b",
      )}
      data-ad={t.platform}
    >
      <div className="col-start-1 row-start-1 min-w-0">
        <p className="text-[13.5px] font-medium leading-[1.35] text-fg">
          {name}
          {also && (
            <span className="mt-px block text-xs font-normal text-fg-faint sm:ml-1.5 sm:mt-0 sm:inline sm:whitespace-nowrap">
              {also}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs leading-[1.45] text-fg-muted">{where}</p>
      </div>
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <p className="rounded-sm border border-border bg-surface px-2.5 py-[5px] font-mono text-xs leading-[1.65] text-fg [overflow-wrap:anywhere]">
          <Line t={t} reduced={reduced} word={word} onWord={onWord} />
        </p>
        {note && (
          <p
            className="mt-1.5 flex items-start gap-2 text-xs leading-[1.45] text-fg-muted"
            data-note=""
          >
            <Dot state="grey" className="mt-[5px]" />
            <span>{note}</span>
          </p>
        )}
      </div>
      <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">{copy}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The rows, with their state
// ---------------------------------------------------------------------------

interface RowsState {
  /** The row showing Copied, for two seconds. */
  copied: AdPlatform | null;
  /** The campaign word per row that asks for one. */
  words: Partial<Record<AdPlatform, string>>;
}

function useRows(initial?: Partial<RowsState>) {
  const [copied, setCopied] = useState<AdPlatform | null>(initial?.copied ?? null);
  const [words, setWords] = useState<Partial<Record<AdPlatform, string>>>(initial?.words ?? {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function copy(t: AdTemplate, reduced: boolean) {
    const word = words[t.platform] ?? "";
    if (!canCopy(t, reduced, word)) return;
    navigator.clipboard
      .writeText(copiedLine(t, reduced, word))
      .then(() => {
        setCopied(t.platform);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), COPIED_MS);
      })
      .catch(() => {
        // ignore: a non-secure context cannot write to the clipboard
      });
  }

  return {
    copied,
    word: (p: AdPlatform) => words[p] ?? "",
    setWord: (p: AdPlatform, w: string) => setWords((prev) => ({ ...prev, [p]: w })),
    copy,
  };
}

function ShadedSubtitle({ parts, className }: { parts: readonly string[]; className: string }) {
  const [before, word, after] = parts;
  return (
    <p className={className}>
      {before} <span className={cn(MACRO, "font-mono text-[0.92em]")}>{word}</span> {after}
    </p>
  );
}

function Rules({ form }: { form: Form }) {
  const size = form === "connect" ? "text-[12.5px]" : "text-[13px]";
  return (
    <ul className={cn("m-0 list-none p-0", form === "connect" ? "mt-2.5" : "mt-3.5")}>
      {[
        <span key="names">{RULE_NAMES}</span>,
        <span key="search">
          {RULE_SEARCH[0]} <code className="font-mono text-xs">{RULE_SEARCH[1]}</code>{" "}
          {RULE_SEARCH[2]}
        </span>,
      ].map((line) => (
        <li
          key={line.key}
          className={cn(
            "grid grid-cols-[7px_minmax(0,1fr)] items-start gap-2.5 py-[3px] leading-normal text-fg",
            size,
          )}
          data-rule=""
        >
          <Dot state="grey" className="mt-[7px]" />
          {line}
        </li>
      ))}
    </ul>
  );
}

/** "What Rawuser reads" under the rules (mock A3), two lines behind a click. */
export function WhatWeRead({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <details className="group/read mt-2 sm:ml-[17px]" open={defaultOpen} data-line="what-we-read">
      <summary className="inline cursor-pointer list-none text-[12.5px] text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className={QUIET_LINK}>
          <span className="group-open/read:hidden">{WHAT_WE_READ}</span>
          <span className="hidden group-open/read:inline">{HIDE}</span>
        </span>
      </summary>
      <ul className="m-0 mt-2 max-w-[62ch] list-none space-y-1 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted">
        {WHAT_WE_READ_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Campaign links: Your ads
// ---------------------------------------------------------------------------

export interface YourAdsProps {
  reduced: boolean;
  templates?: readonly AdTemplate[];
  /** Tests and stories: a row shown as Copied, words already typed, the disclosure open. */
  initial?: Partial<RowsState> & { readOpen?: boolean };
}

/** "Your ads" above the link builder (mock sections 01, 02, 04, A8, A9). */
export function YourAds({ reduced, templates = AD_TEMPLATES, initial }: YourAdsProps) {
  const rows = useRows(initial);
  const groups = adGroups(templates);
  return (
    <section className="max-w-[900px]" data-block="your-ads" data-reduced={reduced || undefined}>
      <h2 className="text-sm font-semibold text-fg">{ADS_HEADING}</h2>
      {reduced ? (
        <p className="mt-3 flex max-w-[72ch] items-start gap-2.5 text-[13px] leading-normal text-fg">
          <Dot state="grey" className="mt-[7px]" />
          <span>{REDUCED_WHY}</span>
        </p>
      ) : (
        <ShadedSubtitle
          parts={SUBTITLE_LINKS}
          className="mt-0.5 max-w-[72ch] text-[13px] text-fg-muted"
        />
      )}

      {groups.map((g, gi) => (
        <div key={g.group}>
          <p className="mt-[18px] pb-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">
            {GROUP_LABEL[g.group]}
          </p>
          {g.rows.map((t, i) => (
            <AdRow
              key={t.platform}
              t={t}
              form="links"
              reduced={reduced}
              word={rows.word(t.platform)}
              onWord={(w) => rows.setWord(t.platform, w)}
              copied={rows.copied === t.platform}
              onCopy={() => rows.copy(t, reduced)}
              last={gi === groups.length - 1 && i === g.rows.length - 1}
            />
          ))}
        </div>
      ))}

      {!reduced && (
        <>
          <Rules form="links" />
          <WhatWeRead defaultOpen={initial?.readOpen} />
        </>
      )}
    </section>
  );
}

/**
 * Your ads for the customer in view. The readiness answer says whether the
 * lines are reduced; until it lands the rows wait in a skeleton, so a
 * special-category site never sees a name macro for a moment.
 */
export function YourAdsForCustomer() {
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const customerId =
    user?.role === "customer" && user.customer_id
      ? user.customer_id
      : (searchParams.get("customer_id") ?? "");
  const readiness = useReadiness(customerId);

  if (readiness.state === "loading") {
    return (
      <section className="max-w-[900px]" data-block="your-ads" aria-busy>
        <h2 className="text-sm font-semibold text-fg">{ADS_HEADING}</h2>
        <Skeleton className="mt-3 h-[500px] w-full" />
      </section>
    );
  }
  return <YourAds reduced={adsReduced(readiness.answer)} />;
}

// ---------------------------------------------------------------------------
// Connect: Running ads?
// ---------------------------------------------------------------------------

export interface RunningAdsProps {
  reduced: boolean;
  templates?: readonly AdTemplate[];
  defaultOpen?: boolean;
  initial?: Partial<RowsState>;
}

/** "Running ads?" under the tag's status line, closed by default (mock section 03, A7, A10). */
export function RunningAds({
  reduced,
  templates = AD_TEMPLATES,
  defaultOpen = false,
  initial,
}: RunningAdsProps) {
  const rows = useRows(initial);
  return (
    <details
      className="group/ra mt-3"
      open={defaultOpen}
      data-line="running-ads"
      data-reduced={reduced || undefined}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className={QUIET_LINK}>{RUNNING_ADS}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className="transition-transform duration-medium ease-smooth group-open/ra:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="mt-2.5">
        {reduced ? (
          <p className="max-w-[62ch] text-[12.5px] text-fg-muted">{REDUCED_WHY}</p>
        ) : (
          <ShadedSubtitle
            parts={SUBTITLE_CONNECT}
            className="max-w-[62ch] text-[12.5px] text-fg-muted"
          />
        )}
        <div className="mt-2">
          {adGroups(templates)
            .flatMap((g) => g.rows)
            .map((t) => (
              <AdRow
                key={t.platform}
                t={t}
                form="connect"
                reduced={reduced}
                word={rows.word(t.platform)}
                onWord={(w) => rows.setWord(t.platform, w)}
                copied={rows.copied === t.platform}
                onCopy={() => rows.copy(t, reduced)}
              />
            ))}
        </div>
        {!reduced && (
          <>
            <Rules form="connect" />
            <p className="mt-1.5 text-xs text-fg-faint sm:ml-[17px]">{ALSO_ON_LINKS}</p>
          </>
        )}
      </div>
    </details>
  );
}
