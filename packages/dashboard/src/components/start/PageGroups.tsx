"use client";

import { useButtons } from "@/components/analytics/MeasureSetup";
import { type SitePick, useSitePick } from "@/components/conversions/useSitePick";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import { removeTarget } from "@/lib/measure";
import { testIsOn } from "@/lib/measure";
import {
  CANCEL,
  COUNT_ON_THESE,
  GO_TO_RESULTS,
  type GroupRow,
  HIDE,
  OPEN_LINE,
  PICK_AGAIN,
  PRIVATE_WINDOW_LINE,
  REMOVE,
  SENSITIVE_TAG,
  SHOW_PAGES,
  TEST_RUNNING_LINE,
  USE_THIS_BUTTON,
  WAITING_PICK_LINE,
  WAITING_SUB,
  WHAT_IS_THIS,
  WHAT_LINES,
  acceptGroup,
  countingLine,
  groupRows,
  mintGroupPick,
  missingLine,
  openToPick,
  pageToSend,
  pagesLine,
  patternLabel,
  pickTitle,
  pickedLine,
  pollGroupPick,
  readGroups,
  removeGroup,
  setGroupCounted,
  visitsLine,
} from "@/lib/page-groups";
import {
  ENTRY,
  ON_EVERY_PAGE_FAINT,
  PICK_IT,
  SITE_OPEN_LABEL,
  SITE_OPEN_LINE,
  SITE_PICK_TITLE,
  buttonName,
  canPickAgain,
  setCounted,
  siteCountingLine,
  sitePickedLine,
} from "@/lib/site-pick";
import { isSiteWideTarget } from "@/lib/site-wide";
import { cn } from "@/lib/utils";
import type { ConversionTarget, LiftReport, PageGroupsResponse, PagesBreakdown } from "@/types/api";
import { Check, EllipsisVertical, ExternalLink, Loader2, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SwitchTrack } from "./Measure";
import { TINT } from "./tones";

/**
 * Page groups on the Pages card (mock design/mock/sales-readiness/
 * page-groups.html, sections 01 to 04 and 06, approved 2026-10-12 as drawn;
 * contract docs/specs/page-groups.md). One row per proposed or accepted
 * group under the confirmed pages: the path, how many pages, the visits
 * with no versions, one button. The pick is the existing count pick, opened
 * in place of the row. A counting row names the button and carries its
 * switch; Remove sits behind the row's menu. While a test runs nothing
 * changes and one quiet line says why.
 */

const POLL_MS = 3000;
const LINK_MS = 15 * 60 * 1000;
const QUIET =
  "whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg disabled:opacity-50";
const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";

// ---------------------------------------------------------------------------
// The read: the groups, whether a test runs, the sensitive flag
// ---------------------------------------------------------------------------

export interface PageGroupsData {
  /** Null while loading, on an older worker (404) or on any failure: no rows. */
  answer: PageGroupsResponse | null;
  testRunning: boolean;
  sensitive: boolean;
  reload: () => void;
  /** Replace the answer with one the API just gave. */
  apply: (answer: PageGroupsResponse) => void;
}

/**
 * The groups endpoint, silent on every failure. A test's state comes from
 * the answer when it carries `test_running`, else from the lift report;
 * the sensitive flag from the answer, else from the superadmin's own read.
 */
export function usePageGroups(customerId: string, superadmin: boolean): PageGroupsData {
  const [answer, setAnswer] = useState<PageGroupsResponse | null>(null);
  const [reportOn, setReportOn] = useState(false);
  const [flag, setFlag] = useState(false);
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);
  const apply = useCallback((a: PageGroupsResponse) => setAnswer(a), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the reload trigger
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    void readGroups(customerId).then((out) => {
      if (cancelled) return;
      setAnswer(out.kind === "ok" ? out.answer : null);
    });
    apiFetch<LiftReport>(`/admin/analytics/lift?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => {
        if (!cancelled) setReportOn(testIsOn(r));
      })
      .catch(() => {});
    if (superadmin) {
      apiFetch<{ sensitive?: boolean }>(
        `/admin/customers/sensitive?customer_id=${encodeURIComponent(customerId)}`,
      )
        .then((s) => {
          if (!cancelled) setFlag(s?.sensitive === true);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [customerId, superadmin, key]);

  return {
    answer,
    testRunning: answer?.test_running ?? reportOn,
    sensitive: answer?.sensitive ?? flag,
    reload,
    apply,
  };
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

export interface PageGroupRowsProps {
  customerId: string;
  data: PageGroupsData;
  /** The breakdown's page rows: one known page of a group to open the picker on. */
  visited?: PagesBreakdown | null;
  /** The tag on a sensitive customer's rows shows in the superadmin's view only. */
  superadmin?: boolean;
  /** For the tests: open on arrival. */
  defaultOpen?: boolean;
  /**
   * The customer's buttons, for the site rows under the groups (site-wide
   * mock, A2 and A3); read here when not given.
   */
  buttons?: ConversionTarget[] | null;
}

type Pick =
  /** `needed`: the worker found no page to open; the row asks for one with that line. */
  | { kind: "link"; pattern: string; needed?: string }
  | { kind: "minting"; pattern: string; needed?: string }
  | { kind: "waiting"; pattern: string; link: string; since: number }
  | { kind: "picked"; pattern: string; target: ConversionTarget };

/**
 * The group rows under the confirmed pages, the "What is this?" disclosure
 * under them. Nothing renders without an answer or with no row in it.
 */
export function PageGroupRows({
  customerId,
  data,
  visited = null,
  superadmin = false,
  defaultOpen = false,
  buttons,
}: PageGroupRowsProps) {
  const rows = groupRows(data.answer);
  // The site rows sit under the groups: the list is read only when there
  // are groups to sit under, and not at all when the caller gave it.
  const read = useButtons(buttons === undefined && rows.length > 0 ? customerId : "");
  const items = buttons === undefined ? read.items : buttons;
  const [pick, setPick] = useState<Pick | null>(null);
  // What the operator pasted when the worker asked for a page; sent on the next mint.
  const [pasted, setPasted] = useState("");
  const [said, setSaid] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A switch moved: the row keeps the target the API answered with.
  const [targets, setTargets] = useState<Record<string, ConversionTarget | null>>({});
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const say = useCallback(
    (pattern: string, line: string | null) => setSaid((s) => ({ ...s, [pattern]: line })),
    [],
  );

  /** "Count a button on these pages" and "Pick again": the link step in place of the row. */
  function begin(row: GroupRow) {
    say(row.pattern, null);
    setPasted("");
    setPick({ kind: "link", pattern: row.pattern });
  }

  /**
   * "Open /products/… to pick": accept the proposal if it is one, mint the
   * link, open the page. When the worker has no page to open it asks for
   * one: the row shows the input and the pasted page rides on the next mint.
   */
  async function start(row: GroupRow) {
    const needed = pick?.kind === "link" ? pick.needed : undefined;
    say(row.pattern, null);
    setPick({ kind: "minting", pattern: row.pattern, needed });
    if (!row.accepted) {
      const a = await acceptGroup(customerId, row.pattern);
      if (!live.current) return;
      if (a.kind !== "ok") {
        say(row.pattern, a.kind === "refused" ? a.sentence : a.message);
        setPick(null);
        return;
      }
    }
    const page = pageToSend(needed !== undefined ? pasted : null, row.pattern, visited);
    const out = await mintGroupPick(customerId, row.pattern, page);
    if (!live.current) return;
    if (out.kind === "page_needed") {
      setPick({ kind: "link", pattern: row.pattern, needed: out.sentence });
      return;
    }
    if (out.kind !== "ok") {
      say(row.pattern, out.kind === "refused" ? out.sentence : out.message);
      setPick(null);
      data.reload();
      return;
    }
    setPick({ kind: "waiting", pattern: row.pattern, link: out.value.link, since: Date.now() });
    window.open(out.value.link, "_blank", "noopener");
  }

  useEffect(() => {
    if (pick?.kind !== "waiting") return;
    let cancelled = false;
    const t = setInterval(() => {
      if (Date.now() - pick.since > LINK_MS) {
        say(pick.pattern, "The link ran out. Pick again.");
        setPick(null);
        return;
      }
      void pollGroupPick(customerId, pick.pattern).then((out) => {
        if (cancelled || out.kind === "waiting") return;
        if (out.kind === "landed") {
          setPick({ kind: "picked", pattern: pick.pattern, target: out.target });
          return;
        }
        say(pick.pattern, out.kind === "refused" ? out.sentence : out.message);
        setPick(null);
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pick, customerId, say]);

  function cancel() {
    setPick(null);
    data.reload();
  }

  function use(pattern: string, target: ConversionTarget) {
    setTargets((m) => ({ ...m, [pattern]: target }));
    setPick(null);
    data.reload();
  }

  async function toggle(row: GroupRow, target: ConversionTarget, on: boolean) {
    setBusy(row.pattern);
    say(row.pattern, null);
    const out = await setGroupCounted(customerId, target, on);
    if (!live.current) return;
    setBusy(null);
    if (out.kind === "ok") {
      setTargets((m) => ({ ...m, [row.pattern]: out.value ?? { ...target, enabled: on } }));
      return;
    }
    say(row.pattern, out.kind === "refused" ? out.sentence : out.message);
  }

  async function remove(row: GroupRow) {
    setBusy(row.pattern);
    say(row.pattern, null);
    const out = await removeGroup(customerId, row.pattern);
    if (!live.current) return;
    setBusy(null);
    if (out.kind === "ok") {
      setTargets((m) => ({ ...m, [row.pattern]: null }));
      data.reload();
      return;
    }
    say(row.pattern, out.kind === "refused" ? out.sentence : out.message);
  }

  if (rows.length === 0) return null;
  const blocked = data.testRunning;
  const tag = superadmin && data.sensitive;

  return (
    <div data-groups="">
      <ul>
        {rows.map((row) => {
          const target = row.pattern in targets ? targets[row.pattern] : row.counted;
          const inPick = pick?.pattern === row.pattern ? pick : null;
          const line = said[row.pattern] ?? null;
          if (inPick) {
            const phase: GroupPickPhase =
              inPick.kind === "picked"
                ? { kind: "picked", target: inPick.target }
                : inPick.kind === "waiting"
                  ? { kind: "waiting" }
                  : { kind: "link", busy: inPick.kind === "minting", needed: inPick.needed };
            return (
              <li
                key={row.pattern}
                className="border-b border-border py-2.5"
                data-group={row.pattern}
              >
                <GroupPickStep
                  pattern={row.pattern}
                  pages={row.pages}
                  phase={phase}
                  onOpen={() => void start(row)}
                  pasted={pasted}
                  onPaste={setPasted}
                  onCancel={cancel}
                  onUse={(t) => use(row.pattern, t)}
                  onPickAgain={() => begin(row)}
                />
                {line && (
                  <p role="alert" className={cn("mt-1.5 text-[12.5px]", WARN_TEXT)}>
                    {line}
                  </p>
                )}
              </li>
            );
          }
          return (
            <GroupRowView
              key={row.pattern}
              row={row}
              target={target ?? null}
              customerId={customerId}
              blocked={blocked}
              tag={tag}
              sensitive={data.sensitive}
              busy={busy === row.pattern}
              said={line}
              onCount={() => begin(row)}
              onToggle={(t, on) => void toggle(row, t, on)}
              onPickAgain={() => begin(row)}
              onRemove={() => void remove(row)}
            />
          );
        })}
        <SiteRows customerId={customerId} items={items} onItems={read.setItems} blocked={blocked} />
      </ul>
      <details className="group mt-2.5 text-xs" open={defaultOpen} data-line="what-is-this">
        <summary className="cursor-pointer list-none text-fg-muted [&::-webkit-details-marker]:hidden">
          <span className="underline decoration-dotted underline-offset-[3px]">
            <span className="group-open:hidden">{WHAT_IS_THIS}</span>
            <span className="hidden group-open:inline">{HIDE}</span>
          </span>
        </summary>
        <ul className="mt-2 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted">
          {WHAT_LINES.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row: proposed, or counting
// ---------------------------------------------------------------------------

export interface GroupRowViewProps {
  row: GroupRow;
  /** The group's counted button; null on a proposal or before the pick. */
  target: ConversionTarget | null;
  customerId: string;
  /** A test runs: the button is off, the switch is shown but not live, the menu is gone. */
  blocked?: boolean;
  /** The quiet tag "Pages are recorded as a group". */
  tag?: boolean;
  /** The amber line names no count and lists no page. */
  sensitive?: boolean;
  busy?: boolean;
  /** The API's own sentence under the row. */
  said?: string | null;
  onCount: () => void;
  onToggle: (t: ConversionTarget, on: boolean) => void;
  onPickAgain: () => void;
  onRemove: () => void;
  /** For the tests: the menu open on arrival. */
  menuOpen?: boolean;
}

export function GroupRowView({
  row,
  target,
  customerId,
  blocked = false,
  tag = false,
  sensitive = false,
  busy = false,
  said = null,
  onCount,
  onToggle,
  onPickAgain,
  onRemove,
  menuOpen = false,
}: GroupRowViewProps) {
  const counting = target !== null;
  const lead = !counting && !row.lite;
  const pages = pagesLine(row.pages, lead);
  const visits = visitsLine(row.visits);
  const missing = counting ? missingLine(row.missing, sensitive) : null;
  const results = `/test?customer_id=${encodeURIComponent(customerId)}`;

  return (
    <li
      data-group={row.pattern}
      className={cn(
        "grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-border py-[9px] text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]",
        row.lite && !counting && "text-fg-muted",
      )}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={cn("font-mono", row.lite && !counting ? "text-fg-muted" : "text-fg")}>
          {patternLabel(row.pattern)}
        </span>
        {pages && <span className="text-fg-muted sm:whitespace-nowrap">{pages}</span>}
        {counting ? (
          <span className={cn(target.enabled ? "text-fg-muted" : "text-fg-faint")}>
            {countingLine(target.label, target.enabled)}
          </span>
        ) : (
          visits && <span className="text-fg-faint sm:whitespace-nowrap">{visits}</span>
        )}
        {tag && (
          <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border px-[7px] py-[3px] text-[11px] leading-none text-fg-muted">
            {SENSITIVE_TAG}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2.5 justify-self-start sm:justify-self-end">
        {counting ? (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={target.enabled}
              aria-label={`Count clicks on ${target.label}`}
              disabled={blocked || busy}
              onClick={() => onToggle(target, !target.enabled)}
              className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50 sm:min-h-0"
            >
              <SwitchTrack on={target.enabled} />
              <b className="font-medium text-fg">{target.enabled ? "On" : "Off"}</b>
            </button>
            {!blocked && (
              <RowMenu
                busy={busy}
                defaultOpen={menuOpen}
                items={[
                  { label: PICK_AGAIN, onSelect: onPickAgain },
                  { label: REMOVE, onSelect: onRemove },
                ]}
              />
            )}
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={blocked || busy}
            onClick={onCount}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {COUNT_ON_THESE}
          </Button>
        )}
      </span>
      {missing && (
        <div className="col-span-full text-xs" data-line="group-missing">
          {sensitive || !row.missing?.paths?.length ? (
            <p className={cn("rounded-sm px-2 py-1 leading-normal", TINT.warn)}>{missing}</p>
          ) : (
            <details className="group">
              <summary
                className={cn(
                  "cursor-pointer list-none rounded-sm px-2 py-1 leading-normal [&::-webkit-details-marker]:hidden",
                  TINT.warn,
                )}
              >
                {missing}{" "}
                <span className="whitespace-nowrap underline decoration-dotted underline-offset-[3px]">
                  <span className="group-open:hidden">{SHOW_PAGES}</span>
                  <span className="hidden group-open:inline">{HIDE}</span>
                </span>
              </summary>
              <ul className="mt-1.5 rounded-sm border border-border bg-surface-muted px-3 py-2 font-mono text-xs text-fg-muted">
                {row.missing.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {blocked && (
        <p
          className="col-span-full rounded-sm bg-surface-muted px-2 py-1 text-xs leading-normal text-fg-muted"
          data-line="group-blocked"
        >
          {TEST_RUNNING_LINE}{" "}
          <a
            href={results}
            className="whitespace-nowrap underline decoration-dotted underline-offset-[3px]"
          >
            {GO_TO_RESULTS}
          </a>
        </p>
      )}
      {said && (
        <p role="alert" className={cn("col-span-full text-[12.5px]", WARN_TEXT)}>
          {said}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// A button on every page, under the groups (site-wide mock, A2 and A3)
// ---------------------------------------------------------------------------

/** The site pick's words in the shared pick step (A4 to A7). */
export const SITE_WORDS: PickWords = {
  title: SITE_PICK_TITLE,
  open: SITE_OPEN_LINE,
  openLabel: SITE_OPEN_LABEL,
  name: buttonName,
  picked: sitePickedLine,
};

/** The pick step for the site pick, in place of a row. */
export function SitePickStep({ pick }: { pick: SitePick }) {
  const p = pick.phase;
  if (!p) return null;
  return (
    <GroupPickStep
      pattern="/"
      pages={null}
      words={SITE_WORDS}
      phase={
        p.kind === "picked"
          ? { kind: "picked", target: p.target }
          : p.kind === "waiting"
            ? { kind: "waiting" }
            : { kind: "link", busy: p.busy }
      }
      onOpen={pick.open}
      onCancel={pick.cancel}
      onUse={() => pick.use()}
      onPickAgain={pick.again}
    />
  );
}

/**
 * The counted buttons on every page as rows like a group's (A3), then the
 * entry, lighter (A2). While a test runs the switches are shown but not
 * live, the menus and the entry are gone; the group rows above say why.
 */
export function SiteRows({
  customerId,
  items,
  onItems,
  blocked = false,
}: {
  customerId: string;
  items: ConversionTarget[] | null;
  onItems: (items: ConversionTarget[]) => void;
  blocked?: boolean;
}) {
  const pick = useSitePick(customerId, items, onItems);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (items === null) return null;
  const site = items.filter((t) => isSiteWideTarget(t));

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

  const line = said ?? pick.said;
  return (
    <>
      {site.map((t) =>
        pick.slot === t.id ? (
          <li key={t.id} className="border-b border-border py-2.5" data-site={t.id}>
            <SitePickStep pick={pick} />
          </li>
        ) : (
          <li
            key={t.id}
            data-site={t.id}
            className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-border py-[9px] text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className={t.enabled ? "text-fg-muted" : "text-fg-faint"}>
                {siteCountingLine(t)}
              </span>
              <span className="text-fg-faint">{ON_EVERY_PAGE_FAINT}</span>
            </span>
            <span className="flex items-center gap-2.5 justify-self-start sm:justify-self-end">
              <button
                type="button"
                role="switch"
                aria-checked={t.enabled}
                aria-label={`Count clicks on ${t.label}`}
                disabled={blocked || busy === t.id}
                onClick={() => void toggle(t, !t.enabled)}
                className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50 sm:min-h-0"
              >
                <SwitchTrack on={t.enabled} />
                <b className="font-medium text-fg">{t.enabled ? "On" : "Off"}</b>
              </button>
              {!blocked && (
                <RowMenu
                  busy={busy === t.id}
                  items={[
                    ...(canPickAgain(t)
                      ? [{ label: PICK_AGAIN, onSelect: () => pick.begin(t.id, t) }]
                      : []),
                    { label: REMOVE, onSelect: () => void remove(t) },
                  ]}
                />
              )}
            </span>
          </li>
        ),
      )}
      {!blocked &&
        (pick.slot === "entry" ? (
          <li className="border-b border-border py-2.5" data-line="site-entry">
            <SitePickStep pick={pick} />
          </li>
        ) : (
          <li
            className="grid grid-cols-1 items-center gap-x-3 gap-y-1.5 border-b border-border py-[9px] text-[13px] text-fg-muted sm:grid-cols-[minmax(0,1fr)_auto]"
            data-line="site-entry"
          >
            <span>{ENTRY}</span>
            <span className="justify-self-start sm:justify-self-end">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => pick.begin("entry")}
              >
                {PICK_IT}
              </Button>
            </span>
          </li>
        ))}
      {line && (
        <li role="alert" className={cn("py-1.5 text-[12.5px]", WARN_TEXT)}>
          {line}
        </li>
      )}
    </>
  );
}

/** The row's menu: a small list under the three dots, closed on Escape or a click outside. */
export function RowMenu({
  items,
  busy = false,
  defaultOpen = false,
}: {
  items: Array<{ label: string; onSelect: () => void }>;
  busy?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();
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
    <span ref={wrap} className="relative inline-flex">
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50"
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" aria-hidden />
        ) : (
          <EllipsisVertical size={14} aria-hidden />
        )}
      </button>
      {open && (
        <span
          id={id}
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-10 min-w-[140px] sm:left-auto sm:right-0 rounded-md border border-border-strong bg-surface p-1 text-left"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className="block w-full rounded-sm px-2.5 py-1.5 text-left text-[13px] text-fg hover:bg-surface-muted"
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The pick step, in place of the row (mock section 02)
// ---------------------------------------------------------------------------

export type GroupPickPhase =
  /** `needed`: the worker's line asking for a page; the input shows only with it. */
  | { kind: "link"; busy?: boolean; needed?: string }
  | { kind: "waiting" }
  | { kind: "picked"; target: ConversionTarget };

/**
 * The step's words for another kind of pick (the site pick, mock
 * site-wide-and-sensitive.html A4 to A7); the group's own words without.
 */
export interface PickWords {
  title: string;
  open: string;
  openLabel: string;
  /** The picked button's name: its words in quotes, or a contact kind as it is. */
  name: (t: ConversionTarget) => string;
  picked: (t: ConversionTarget) => string;
}

export interface GroupPickStepProps {
  pattern: string;
  pages: number | null;
  phase: GroupPickPhase;
  onOpen: () => void;
  onCancel: () => void;
  onUse: (t: ConversionTarget) => void;
  onPickAgain: () => void;
  /** The pasted page, when the worker asked for one. */
  pasted?: string;
  onPaste?: (value: string) => void;
  words?: PickWords;
}

export function GroupPickStep({
  pattern,
  pages,
  phase,
  onOpen,
  onCancel,
  onUse,
  onPickAgain,
  pasted = "",
  onPaste,
  words,
}: GroupPickStepProps) {
  const picked = phase.kind === "picked";
  const needed = phase.kind === "link" ? (phase.needed ?? null) : null;
  const minting = phase.kind === "link" && phase.busy === true;
  const pasteId = useId();
  return (
    <div
      className="rounded-md border border-border bg-bg px-4 py-3"
      data-pick={phase.kind}
      aria-live="polite"
    >
      <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:grid-cols-[24px_minmax(0,1fr)_auto]">
        <span
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center rounded-full",
            picked ? TINT.ok : "bg-surface-muted text-fg-faint",
          )}
        >
          {phase.kind === "link" && <MousePointerClick size={10} aria-hidden />}
          {phase.kind === "waiting" && <Loader2 size={10} className="animate-spin" aria-hidden />}
          {picked && <Check size={10} aria-hidden />}
        </span>
        <div className="min-w-0">
          {picked ? (
            <>
              <p className="text-sm font-medium text-fg">
                <b className="font-medium">
                  {words ? words.name(phase.target) : `“${phase.target.label}”`}
                </b>
              </p>
              <p className="text-[13px] text-fg-muted">
                {words ? words.picked(phase.target) : pickedLine(phase.target, pages)}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-fg">{words?.title ?? pickTitle(pages)}</p>
              <p className="text-[13px] text-fg-muted">
                {phase.kind === "waiting" ? WAITING_PICK_LINE : (words?.open ?? OPEN_LINE)}
              </p>
            </>
          )}
        </div>
        <span
          className={cn(
            "col-start-2 flex flex-wrap items-center gap-3 justify-self-start",
            phase.kind === "waiting" ? "sm:col-start-3 sm:justify-self-end" : "sm:col-span-2",
          )}
        >
          {phase.kind === "link" && (
            <>
              <Button type="button" size="sm" onClick={onOpen} disabled={phase.busy}>
                {phase.busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                {words?.openLabel ?? openToPick(pattern)}
                {!phase.busy && <ExternalLink size={12} aria-hidden />}
              </Button>
              <button type="button" className={QUIET} onClick={onCancel}>
                {CANCEL}
              </button>
            </>
          )}
          {phase.kind === "waiting" && (
            <button type="button" className={QUIET} onClick={onCancel}>
              {CANCEL}
            </button>
          )}
          {picked && (
            <>
              <Button type="button" size="sm" onClick={() => onUse(phase.target)}>
                {USE_THIS_BUTTON}
              </Button>
              <button type="button" className={QUIET} onClick={onPickAgain}>
                {PICK_AGAIN}
              </button>
            </>
          )}
        </span>
      </div>
      {needed !== null && (
        <div className="mt-2 sm:ml-9" data-line="group-page-needed">
          <label htmlFor={pasteId} className={cn("block text-[12.5px]", WARN_TEXT)}>
            {needed}
          </label>
          <input
            id={pasteId}
            value={pasted}
            onChange={(e) => onPaste?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !minting) onOpen();
            }}
            placeholder={patternLabel(pattern)}
            disabled={minting}
            className="mt-1 w-full max-w-md min-w-0 rounded-sm border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-[13px] text-fg disabled:opacity-50"
          />
        </div>
      )}
      {phase.kind === "link" && (
        <p className="mt-2 text-xs text-fg-muted sm:ml-9">{PRIVATE_WINDOW_LINE}</p>
      )}
      {phase.kind === "waiting" && (
        <p className="mt-2 text-xs text-fg-faint sm:ml-9">{WAITING_SUB}</p>
      )}
    </div>
  );
}
