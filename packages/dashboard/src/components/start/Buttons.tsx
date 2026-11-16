"use client";

import { apiFetch } from "@/lib/api";
import {
  buttonNote,
  buttonsLine,
  isCountedButton,
  readButtons,
  setButton,
  withSwitch,
} from "@/lib/buttons";
import { cn } from "@/lib/utils";
import type { ButtonRow, ButtonsAnswer, MeasureButton } from "@/types/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { SwitchTrack } from "./Measure";

/**
 * A button keeps the page's words until its own switch is on (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 04, approved
 * 2026-10-12; contract docs/specs/button-rewrite.md). The parts list on
 * Look and the list under a page on the Pages card are the same rows.
 */

const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";
const QUIET =
  "whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg";

/**
 * One row of a parts list: the part's name, the page's words, an action at
 * the right, and one line under the words. On a phone the name and the
 * action share the first line and the words take the full width.
 */
export function PartRow({
  name,
  pill,
  words,
  note,
  caution = false,
  action,
  children,
}: {
  name: string;
  /** "counted" */
  pill?: string | null;
  words: React.ReactNode;
  note?: React.ReactNode;
  /** The note is a caution: amber text. */
  caution?: boolean;
  action?: React.ReactNode;
  /** Under the note, in the words' column. */
  children?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border py-[9px] text-[13px] last:border-b-0 sm:grid-cols-[156px_minmax(0,1fr)_auto] sm:items-start sm:gap-y-0.5">
      <span className="col-start-1 row-start-1 flex min-h-7 flex-wrap items-center gap-1.5 text-fg-muted sm:min-h-0">
        {name}
        {pill && (
          <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border px-[7px] py-[3px] text-[11px] leading-none text-fg-muted">
            {pill}
          </span>
        )}
      </span>
      <span className="col-span-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:col-span-1 sm:col-start-2 sm:row-start-1">
        {words}
      </span>
      {action && <span className="col-start-2 row-start-1 sm:col-start-3">{action}</span>}
      {note && (
        <span
          className={cn(
            "col-span-2 text-[12.5px] sm:col-span-1 sm:col-start-2",
            caution ? WARN_TEXT : "text-fg-muted",
          )}
        >
          {note}
        </span>
      )}
      {children && <span className="col-span-2 sm:col-span-1 sm:col-start-2">{children}</span>}
    </li>
  );
}

/** "Rewrite: Off". A 44 px row to tap on a phone. */
export function RewriteSwitch({
  name,
  on,
  busy = false,
  onToggle,
}: {
  /** The part's name, for the switch's label. */
  name: string;
  on: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`Rewrite the ${name.charAt(0).toLowerCase()}${name.slice(1)}`}
      disabled={busy}
      onClick={onToggle}
      className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-60 sm:min-h-0"
    >
      <SwitchTrack on={on} />
      <span>
        Rewrite: <b className="font-medium text-fg">{on ? "On" : "Off"}</b>
      </span>
    </button>
  );
}

/** A button's row: its switch, the pill when its clicks are counted, the note or the caution. */
export function ButtonPartRow({
  button,
  chosen,
  busy,
  onToggle,
  children,
}: {
  button: ButtonRow;
  /** Look only: the button chosen in "The button to count". */
  chosen?: MeasureButton | null;
  busy?: boolean;
  onToggle: (path: string, on: boolean) => void;
  children?: React.ReactNode;
}) {
  const note = buttonNote(button);
  return (
    <PartRow
      name={button.label}
      pill={isCountedButton(button, chosen) ? "counted" : null}
      words={button.text}
      note={note.text}
      caution={note.caution}
      action={
        <RewriteSwitch
          name={button.label}
          on={button.rewrite}
          busy={busy}
          onToggle={() => onToggle(button.path, !button.rewrite)}
        />
      }
    >
      {children}
    </PartRow>
  );
}

/** The API's sentence when a switch did not move (the 409 during a test), quiet and plain. */
export function ButtonRefusal({ line }: { line: string | null }) {
  if (!line) return null;
  return (
    <p role="alert" className={cn("mt-2 text-[12.5px]", WARN_TEXT)}>
      {line}
    </p>
  );
}

/**
 * A page's buttons and their switches. Starts from the list an answer
 * already carried (the quickstart's or the manifest's `buttons`); a switch
 * is one POST and the screen takes the answer's list. Null while there is
 * no list (a worker from before 2026-10-12): no switch is drawn.
 */
export function useButtons({
  customerId,
  pagePath,
  initial,
  onChanged,
}: {
  customerId: string;
  pagePath: string;
  initial: readonly ButtonRow[] | null | undefined;
  /** The switch was stored; `stale` versions will be written again. */
  onChanged?: (stale: number) => void;
}) {
  const [buttons, setButtons] = useState<ButtonRow[] | null>(() => readButtons(initial));
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A fresh read replaces the list.
  useEffect(() => {
    setButtons(readButtons(initial));
    setRefusal(null);
  }, [initial]);

  /** Read the list again (after a pick moved a part to another element). */
  const reload = useCallback(async () => {
    try {
      const r = await apiFetch<ButtonsAnswer>(
        `/admin/onboard/buttons?customer_id=${encodeURIComponent(customerId)}&page_path=${encodeURIComponent(pagePath)}`,
      );
      const next = readButtons(r?.buttons);
      if (live.current && next) setButtons(next);
    } catch {
      // The list on screen stays; a worker without the endpoint has none.
    }
  }, [customerId, pagePath]);

  async function toggle(path: string, on: boolean) {
    if (!buttons || busy) return;
    const before = buttons;
    setBusy(path);
    setRefusal(null);
    setButtons(withSwitch(before, path, on));
    const r = await setButton(apiFetch, { customerId, pagePath, path, on }, before);
    if (!live.current) return;
    // A refusal puts the switch back, and the API's own sentence says why.
    setButtons(r.buttons);
    setBusy(null);
    if (r.ok) onChanged?.(r.stale);
    else setRefusal(r.refusal);
  }

  return { buttons, busy, refusal, toggle, reload };
}

/**
 * Under a page on the Pages card, after go live: one quiet line that says
 * how its buttons stand, and the same rows behind See. A switch turned on
 * marks the page's versions to be written again, so the parent is told.
 */
export function PageButtons({
  customerId,
  pagePath,
  buttons: initial,
  onStale,
  defaultOpen = false,
}: {
  customerId: string;
  pagePath: string;
  buttons: readonly ButtonRow[] | null | undefined;
  onStale?: () => void;
  /** For the tests: the list open on arrival. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { buttons, busy, refusal, toggle } = useButtons({
    customerId,
    pagePath,
    initial,
    onChanged: (stale) => {
      if (stale > 0) onStale?.();
    },
  });
  const line = buttonsLine(buttons);
  if (!buttons || !line) return null;
  return (
    <div data-buttons={pagePath}>
      <p className="px-2 text-fg-muted">
        {line}{" "}
        <button
          type="button"
          className={QUIET}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "See"}
        </button>
      </p>
      {open && (
        <div className="mt-1 px-2">
          <ul className="border-t border-border">
            {buttons.map((b) => (
              <ButtonPartRow
                key={b.path}
                button={b}
                busy={busy === b.path}
                onToggle={(path, on) => void toggle(path, on)}
              />
            ))}
          </ul>
          <ButtonRefusal line={refusal} />
        </div>
      )}
    </div>
  );
}
