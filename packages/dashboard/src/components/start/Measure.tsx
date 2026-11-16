"use client";

import { CountPick } from "@/components/conversions/CountPick";
import { Button } from "@/components/ui/Button";
import {
  CHANGE_LINE,
  COUNT_ANOTHER,
  type GoLiveTest,
  NOTICE_HINT,
  NOTICE_LINK,
  NOTICE_PARAGRAPH,
  buttonRow,
  candidates,
  slotPlace,
} from "@/lib/golive";
import { cn } from "@/lib/utils";
import type { MeasureButton, MeasureProposal } from "@/types/api";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { TINT, WARN_WASH } from "./tones";

/**
 * Measure at go live on the Look screen (mock design/mock/sales-readiness/
 * measure-at-go-live.html, sections 01 to 04, approved 2026-10-05): the row
 * "The button to count" and, beside Go live, the test line, its switch and
 * "Text for your privacy notice". Never inside the hatch or a disclosure
 * (privacy review condition 1); the notice link shows in every state
 * (condition 2).
 */

export function Tick({ warn }: { warn: boolean }) {
  return warn ? (
    <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded-full", TINT.warn)}>
      <TriangleAlert size={10} aria-hidden />
    </span>
  ) : (
    <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded-full", TINT.ok)}>
      <Check size={10} aria-hidden />
    </span>
  );
}

const QUIET =
  "whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg";

/** The track and knob of a switch; the button around it carries the role and the words. */
export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block h-4 w-7 flex-none rounded-full transition-colors duration-medium ease-smooth motion-reduce:transition-none",
        on ? "bg-fg" : "bg-border-strong",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-surface transition-transform duration-medium ease-smooth motion-reduce:transition-none",
          on && "translate-x-3",
        )}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The button to count
// ---------------------------------------------------------------------------

interface ButtonToCountProps {
  customerId: string;
  pagePath: string;
  measure: MeasureProposal | null | undefined;
  chosen: MeasureButton | null;
  onChoose: (b: MeasureButton) => void;
  /** The other language pages this go live writes. */
  ticked: string[];
  /** For the fixtures and tests: open on arrival. */
  defaultOpen?: boolean;
  /**
   * Bumped by "Count another button" under Go live: the list opens and the
   * row comes into view.
   */
  openSignal?: number;
}

export function ButtonToCount({
  customerId,
  pagePath,
  measure,
  chosen,
  onChoose,
  ticked,
  defaultOpen = false,
  openSignal = 0,
}: ButtonToCountProps) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openSignal <= 0) return;
    setOpen(true);
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    root.current?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }, [openSignal]);
  // Buttons picked on the page join the list (their own words).
  const [picked, setPicked] = useState<MeasureButton[]>([]);
  const list = [...picked, ...candidates(measure)].filter(
    (b, i, all) => all.findIndex((o) => o.section_path === b.section_path) === i,
  );
  const row = buttonRow(measure, chosen, ticked);
  const name = useId();

  function landed(b: MeasureButton) {
    setPicked((p) => [b, ...p.filter((o) => o.section_path !== b.section_path)]);
    onChoose(b);
    setOpen(false);
  }

  const pick = (variant: "link" | "button") => (
    <CountPick
      customerId={customerId}
      pagePath={pagePath}
      variant={variant}
      onLanded={(t) => landed({ section_path: t.section_path, label: t.label })}
    />
  );

  return (
    <div
      ref={root}
      className={cn("border-b border-border px-4 py-3", row.warn && !open && WARN_WASH)}
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        <Tick warn={row.warn && !open} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">The button to count</p>
          <p className="text-[13px] text-fg-muted">
            {open ? (
              CHANGE_LINE
            ) : row.kind === "chosen" ? (
              <>
                <b className="font-medium text-fg">{row.label}</b>
                {row.rest}
              </>
            ) : (
              row.line
            )}
          </p>
        </div>
        {open ? (
          <button type="button" className={QUIET} onClick={() => setOpen(false)}>
            Done
          </button>
        ) : row.kind === "none" && list.length === 0 ? (
          <span />
        ) : (
          <button
            type="button"
            className={QUIET}
            onClick={() => setOpen(true)}
            aria-expanded={false}
          >
            Change
          </button>
        )}
        {!open && row.kind === "none" && (
          <div className="col-start-2 col-end-[-1] justify-self-start">{pick("button")}</div>
        )}
      </div>

      {open && (
        <>
          <fieldset className="m-0 mt-3 flex max-w-none flex-col gap-1 border-0 p-0 sm:ml-9 sm:max-w-[420px]">
            <legend className="sr-only">The button to count</legend>
            {list.map((b) => {
              const on = chosen?.section_path === b.section_path;
              return (
                <label
                  key={b.section_path}
                  className={cn(
                    "grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-sm border bg-surface px-3 py-2.5 text-[13px] transition-colors duration-fast sm:px-2.5 sm:py-[7px]",
                    on ? "border-fg" : "border-border hover:border-border-strong",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)]",
                  )}
                >
                  <input
                    type="radio"
                    name={name}
                    value={b.section_path}
                    checked={on}
                    onChange={() => {
                      onChoose(b);
                      setOpen(false);
                    }}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px]",
                      on ? "border-fg" : "border-border-strong",
                    )}
                  >
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-fg" />}
                  </span>
                  <span className="min-w-0 truncate font-medium text-fg">{b.label}</span>
                  <span className="whitespace-nowrap text-xs text-fg-faint">
                    {slotPlace(b.section_path)}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-1 text-xs text-fg-muted sm:ml-9">
            Not here? {pick("link")}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beside Go live: the line, the switch, the notice link
// ---------------------------------------------------------------------------

export function GoLiveTestLine({
  test,
  onToggle,
  noticeOpen,
}: {
  test: GoLiveTest;
  onToggle: () => void;
  /** For the fixtures and tests: the notice popover open on arrival. */
  noticeOpen?: boolean;
}) {
  return (
    <div className="mt-3 flex flex-col items-start gap-1.5 text-[13px] sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3.5 sm:gap-y-2">
      {test.control === "none" ? (
        <span className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap text-fg-muted sm:min-h-0">
          <span
            aria-hidden
            className="inline-block h-[7px] w-[7px] flex-none rounded-full border-[1.5px] border-fg-faint"
          />
          <span>
            Test: <b className="font-medium text-fg">Off</b>
          </span>
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={test.on}
          aria-label="Test"
          disabled={test.control === "disabled"}
          onClick={onToggle}
          className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50 sm:min-h-0"
        >
          <SwitchTrack on={test.on} />
          <span>
            Test: <b className="font-medium text-fg">{test.on ? "On" : "Off"}</b>
          </span>
        </button>
      )}
      <span className={cn(test.on ? "text-fg" : "text-fg-muted")} aria-live="polite">
        {test.line}
      </span>
      <NoticeLink defaultOpen={noticeOpen} />
    </div>
  );
}

/**
 * One warning before the test starts (mock pilot-gaps, screen 05): the
 * counted button's page gets a small share of visits, or the result is far
 * off. Under the test line, in view before the click. The link opens the
 * list in "The button to count"; Go live itself is the "anyway".
 */
export function GoLiveWarning({
  line,
  onCountAnother,
}: {
  line: string | null;
  onCountAnother: () => void;
}) {
  if (!line) return null;
  return (
    <p
      className={cn(
        "mt-2.5 flex max-w-[712px] items-start gap-2 rounded-sm px-2.5 py-[7px] text-[13px] leading-normal",
        TINT.warn,
      )}
      data-line="go-live-warning"
    >
      <TriangleAlert size={12} aria-hidden className="mt-[3px] flex-none" />
      <span>
        {line}{" "}
        <button
          type="button"
          onClick={onCountAnother}
          className="whitespace-nowrap rounded-sm underline decoration-dotted underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {COUNT_ANOTHER}
        </button>
      </span>
    </p>
  );
}

/** "Text for your privacy notice": the paste paragraph and a Copy button, in a small popover. */
export function NoticeLink({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span ref={wrap} className="relative block w-full sm:inline-block sm:w-auto">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((v) => !v);
          setCopied(false);
        }}
        className={cn(QUIET, "inline-flex min-h-6 items-center")}
      >
        {NOTICE_LINK}
      </button>
      {open && (
        <span
          id={panelId}
          className="mt-2 block w-full rounded-md border border-border-strong bg-surface px-4 py-3.5 text-left sm:absolute sm:right-0 sm:top-full sm:z-20 sm:w-[420px]"
        >
          <span className="block text-[13.5px] font-semibold text-fg">{NOTICE_LINK}</span>
          <span className="mt-1 block text-[12.5px] text-fg-muted">{NOTICE_HINT}</span>
          <span className="mt-2.5 block max-h-[40vh] overflow-y-auto rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-[1.55] text-fg">
            {NOTICE_PARAGRAPH}
          </span>
          <span className="mt-2.5 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                navigator.clipboard
                  .writeText(NOTICE_PARAGRAPH)
                  .then(() => setCopied(true))
                  .catch(() => {});
              }}
            >
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
