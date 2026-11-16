"use client";

import { CountPick } from "@/components/conversions/CountPick";
import { SwitchTrack } from "@/components/start/Measure";
import { RowMenu, SitePickStep } from "@/components/start/PageGroups";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { removeTarget } from "@/lib/measure";
import {
  GO_TO_RESULTS,
  HIDE,
  PICK_AGAIN,
  REMOVE,
  TEST_RUNNING_LINE,
  buttonWhere,
} from "@/lib/page-groups";
import {
  DONE,
  ENTRY,
  LIST_EMPTY,
  LIST_LEAD,
  LIST_TITLE,
  ONE_PAGE_ONLY,
  PICK_IT,
  WHAT_TO_COUNT,
  WHAT_TO_COUNT_LINES,
  buttonName,
  canPickAgain,
  setCounted,
} from "@/lib/site-pick";
import { cn } from "@/lib/utils";
import type { ConversionTarget } from "@/types/api";
import { Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { type SitePick, useSitePick } from "./useSitePick";

/**
 * "Which buttons count?" (mock design/mock/sales-readiness/site-wide-and-
 * sensitive.html, sections 01 to 03 and 08, approved 2026-10-22): one row
 * per button with its own switch, where it counts in words ("on the
 * homepage", "on 69 pages", "on every page"), Remove behind the row's menu.
 * Under the rows one quiet entry, "A button on every page (menu or
 * footer)", whose pick runs in place of the row. While a test runs the
 * switches are shown but not live, the menus and the entry are gone, and
 * one quiet line says why.
 */

const QUIET =
  "whitespace-nowrap rounded-sm text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50";
const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

export interface ButtonRowProps {
  target: ConversionTarget;
  /** A test runs: the switch is shown but not live, the menu is gone. */
  blocked?: boolean;
  busy?: boolean;
  onToggle: (on: boolean) => void;
  onPickAgain?: (() => void) | null;
  onRemove: () => void;
  /** Under the last row while a test runs (A11). */
  children?: React.ReactNode;
  /** For the tests: the menu open on arrival. */
  menuOpen?: boolean;
}

export function ButtonRow({
  target,
  blocked = false,
  busy = false,
  onToggle,
  onPickAgain = null,
  onRemove,
  children,
  menuOpen = false,
}: ButtonRowProps) {
  const on = target.enabled;
  const where = buttonWhere(target).where;
  const name = buttonName(target);
  const items = [
    ...(onPickAgain ? [{ label: PICK_AGAIN, onSelect: onPickAgain }] : []),
    { label: REMOVE, onSelect: onRemove },
  ];
  return (
    <li
      data-button={target.id}
      data-on={on ? "" : undefined}
      className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-border py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <b className={cn("break-words", on ? "font-medium text-fg" : "font-normal text-fg-muted")}>
          {name}
        </b>
        <span className="text-fg-muted">{where}</span>
      </span>
      <span className="flex items-center gap-2.5 justify-self-start sm:justify-self-end">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Count clicks on ${target.label}`}
          disabled={blocked || busy}
          onClick={() => onToggle(!on)}
          className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50 sm:min-h-0"
        >
          <SwitchTrack on={on} />
          <b className="font-medium text-fg">{on ? "On" : "Off"}</b>
        </button>
        {!blocked && <RowMenu busy={busy} defaultOpen={menuOpen} items={items} />}
      </span>
      {children}
    </li>
  );
}

/** The quiet line under the last row while a test runs (A11): the group row's own words. */
/** On Test itself (dashboard v2): the mock's lock line, no link to where it already is. */
export const LOCKED_HERE = "Locked while the test runs, so the comparison stays fair.";

export function TestRunningLine({
  customerId,
  onGoToResults,
  here = false,
}: {
  customerId: string;
  /** On Results itself the link closes the screen it sits in. */
  onGoToResults?: () => void;
  /** On Test: the lock line alone. */
  here?: boolean;
}) {
  if (here) {
    return (
      <p
        className="col-span-full flex items-center gap-2 text-xs leading-normal text-fg-muted"
        data-line="buttons-blocked"
      >
        <Lock size={14} aria-hidden />
        {LOCKED_HERE}
      </p>
    );
  }
  const href = `/test?customer_id=${encodeURIComponent(customerId)}`;
  const link = "whitespace-nowrap underline decoration-dotted underline-offset-[3px]";
  return (
    <p
      className="col-span-full rounded-sm bg-surface-muted px-2 py-1 text-xs leading-normal text-fg-muted"
      data-line="buttons-blocked"
    >
      {TEST_RUNNING_LINE}{" "}
      {onGoToResults ? (
        <button type="button" className={link} onClick={onGoToResults}>
          {GO_TO_RESULTS}
        </button>
      ) : (
        <a href={href} className={link}>
          {GO_TO_RESULTS}
        </a>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ButtonListProps {
  customerId: string;
  items: ConversionTarget[];
  blocked: boolean;
  /** The list after a change the API made. */
  onItems: (items: ConversionTarget[]) => void;
  /** Shared with the dialog so it can use a picked button when it closes. */
  pick: SitePick;
  onGoToResults?: () => void;
  /** For the tests: one row's menu open on arrival. */
  menuOpenId?: string | null;
  /** On Test (dashboard v2): the lock line without a link. */
  here?: boolean;
}

/** The rows, the entry, and the one-page pick's line (A1, A8, A11). */
export function ButtonList({
  customerId,
  items,
  blocked,
  onItems,
  pick,
  onGoToResults,
  menuOpenId = null,
  here = false,
}: ButtonListProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function toggle(t: ConversionTarget, on: boolean) {
    setBusy(t.id);
    setSaid(null);
    const out = await setCounted(customerId, t, on);
    setBusy(null);
    if (out.kind === "ok") onItems(out.value);
    else setSaid(out.kind === "refused" ? out.sentence : out.message);
  }

  async function remove(t: ConversionTarget) {
    setBusy(t.id);
    setSaid(null);
    const out = await removeTarget(customerId, t);
    setBusy(null);
    if (out.kind === "ok") onItems(out.items);
    else setSaid(out.kind === "refused" ? out.sentence : out.message);
  }

  const last = items.length - 1;
  const line = said ?? pick.said;
  return (
    <>
      <ul className="m-0 mt-4 list-none border-t border-border p-0" data-list="buttons">
        {items.map((t, i) =>
          pick.slot === t.id ? (
            <li key={t.id} className="border-b border-border py-2.5" data-button={t.id}>
              <SitePickStep pick={pick} />
            </li>
          ) : (
            <ButtonRow
              key={t.id}
              target={t}
              blocked={blocked}
              busy={busy === t.id}
              onToggle={(on) => void toggle(t, on)}
              onPickAgain={canPickAgain(t) ? () => pick.begin(t.id, t) : null}
              onRemove={() => void remove(t)}
              menuOpen={menuOpenId === t.id}
            >
              {blocked && i === last && (
                <TestRunningLine
                  customerId={customerId}
                  onGoToResults={onGoToResults}
                  here={here}
                />
              )}
            </ButtonRow>
          ),
        )}
        {!blocked && (
          <li
            className={cn(
              "border-b border-border text-[13px]",
              pick.slot === "entry"
                ? "py-2.5"
                : "grid grid-cols-1 items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]",
            )}
            data-line="site-entry"
          >
            {pick.slot === "entry" ? (
              <SitePickStep pick={pick} />
            ) : (
              <>
                <span className="text-fg-muted">{ENTRY}</span>
                <span className="justify-self-start sm:justify-self-end">
                  <button type="button" className={QUIET} onClick={() => pick.begin("entry")}>
                    {PICK_IT}
                  </button>
                </span>
              </>
            )}
          </li>
        )}
      </ul>
      {blocked && items.length === 0 && (
        <div className="mt-2">
          <TestRunningLine customerId={customerId} onGoToResults={onGoToResults} here={here} />
        </div>
      )}
      <div aria-live="polite">
        {line && <p className={cn("mt-2 text-[12.5px] leading-normal", WARN_TEXT)}>{line}</p>}
      </div>
      {!blocked && (
        <p className="mt-3 flex flex-wrap items-baseline gap-x-1 text-xs text-fg-muted">
          {ONE_PAGE_ONLY}{" "}
          <CountPick
            customerId={customerId}
            pagePath="/"
            variant="link"
            onLanded={(_t, next) => onItems(next)}
          />
        </p>
      )}
    </>
  );
}

/** "What should I count?" under the list (A10): two lines, nothing more. */
export function WhatToCount({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <details className="group mt-2.5 text-xs" open={defaultOpen} data-line="what-to-count">
      <summary className="cursor-pointer list-none text-fg-muted [&::-webkit-details-marker]:hidden">
        <span className="underline decoration-dotted underline-offset-[3px]">
          <span className="group-open:hidden">{WHAT_TO_COUNT}</span>
          <span className="hidden group-open:inline">{HIDE}</span>
        </span>
      </summary>
      <ul className="mt-2 space-y-1 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted">
        {WHAT_TO_COUNT_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </details>
  );
}

// ---------------------------------------------------------------------------
// The dialog on Results
// ---------------------------------------------------------------------------

export interface ButtonsDialogProps {
  customerId: string;
  items: ConversionTarget[] | null;
  /** A test runs: read only (A11). */
  blocked: boolean;
  onClose: () => void;
  /** The list after any change; the dialog stays open. */
  onChanged: (items: ConversionTarget[]) => void;
}

export function ButtonsDialog({
  customerId,
  items,
  blocked,
  onClose,
  onChanged,
}: ButtonsDialogProps) {
  const pick = useSitePick(customerId, items, onChanged);
  const close = () => {
    pick.settle();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[92dvh] w-[calc(100%-2rem)] max-w-[560px] overflow-y-auto p-5 sm:p-6">
        <ButtonsBody
          customerId={customerId}
          items={items}
          blocked={blocked}
          onItems={onChanged}
          pick={pick}
          onDone={close}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's content (A1, A8, A11, A21). */
export function ButtonsBody({
  customerId,
  items,
  blocked,
  onItems,
  pick,
  onDone,
  menuOpenId = null,
}: Omit<ButtonListProps, "items" | "onGoToResults"> & {
  items: ConversionTarget[] | null;
  onDone: () => void;
}) {
  const empty = items !== null && items.length === 0;
  return (
    <>
      <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">{LIST_TITLE}</DialogTitle>
      <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
        {empty ? LIST_EMPTY : LIST_LEAD}
      </DialogDescription>

      {items === null ? (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-fg-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Reading your buttons
        </p>
      ) : (
        <>
          <ButtonList
            customerId={customerId}
            items={items}
            blocked={blocked}
            onItems={onItems}
            pick={pick}
            onGoToResults={onDone}
            menuOpenId={menuOpenId}
          />
          <WhatToCount />
        </>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" onClick={onDone}>
          {DONE}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The entry alone: the Conversions screen
// ---------------------------------------------------------------------------

/**
 * "A button on every page (menu or footer)" with "Pick it on your page" as
 * one quiet row, its pick in place (the Conversions screen, where the
 * readiness line "Count it on every page" leads). The new row lands in the
 * list above it.
 */
export function SiteEntry({
  customerId,
  items,
  onItems,
  blocked = false,
}: {
  customerId: string;
  items: ConversionTarget[] | null;
  onItems: (items: ConversionTarget[]) => void;
  /** A test runs: the entry is gone and one quiet line says why (mock, 08). */
  blocked?: boolean;
}) {
  const pick = useSitePick(customerId, items, onItems);
  if (blocked) return <TestRunningLine customerId={customerId} />;
  return (
    <div data-line="site-entry">
      {pick.slot === "entry" ? (
        <SitePickStep pick={pick} />
      ) : (
        <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 text-[13px] text-fg-muted sm:grid-cols-[minmax(0,1fr)_auto]">
          <span>{ENTRY}</span>
          <span className="justify-self-start sm:justify-self-end">
            <Button type="button" size="sm" variant="secondary" onClick={() => pick.begin("entry")}>
              {PICK_IT}
            </Button>
          </span>
        </div>
      )}
      {pick.said && (
        <p aria-live="polite" className={cn("mt-1.5 text-[12.5px]", WARN_TEXT)}>
          {pick.said}
        </p>
      )}
    </div>
  );
}
