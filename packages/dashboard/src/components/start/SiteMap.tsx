"use client";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/api";
import {
  type DraftRow,
  KIND_OPTIONS,
  KIND_WORD,
  type LookRow,
  OFF_NOW_LINES,
  OFF_SAVE_LINES,
  ON_AGAIN_LINES,
  type PendingLine,
  apiErrorLine,
  checkNewPath,
  dialogTabs,
  draftFrom,
  saveBody,
} from "@/lib/site-map";
import { cn } from "@/lib/utils";
import type { SiteMapKind, SiteMapView } from "@/types/api";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, Loader2, Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Tick } from "./Measure";

/**
 * Site-shaped intents on the first-run screens (mock design/mock/
 * sales-readiness/site-shaped-intents.html, sections 01 to 05, approved
 * 2026-10-05): the Look row "Your pages" in its four states, the Change
 * dialog (a tab per language, a kind per row, Add a page, the switch in the
 * foot) and the Pages card's re-read line. Words in lib/site-map.ts.
 */

const QUIET =
  "whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg";

// ---------------------------------------------------------------------------
// Look: the row
// ---------------------------------------------------------------------------

function OffTick() {
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface-muted text-fg-faint">
      <Minus size={10} aria-hidden />
    </span>
  );
}

export function YourPagesRow({
  row,
  onChange,
  defaultWhy = false,
}: {
  row: LookRow;
  onChange: () => void;
  /** For the fixtures and tests: Why open on arrival. */
  defaultWhy?: boolean;
}) {
  const [why, setWhy] = useState(defaultWhy);
  if (row.kind === "hidden") return null;
  const fold = row.kind === "found" ? row.fold : null;
  return (
    <div className="border-b border-border px-4 py-3" data-row="your-pages">
      <div
        className={cn(
          "grid grid-cols-[24px_minmax(0,1fr)_auto] gap-3",
          fold ? "items-start" : "items-center",
        )}
      >
        <span className={cn("flex", fold && "mt-[3px]")}>
          {row.kind === "off" ? <OffTick /> : <Tick warn={false} />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Your pages</p>
          <p className="text-[13px] text-fg-muted">
            {row.kind === "off" ? (
              row.line
            ) : row.line ? (
              row.line
            ) : (
              <>
                {row.pairs.map((p, i) => (
                  <span key={p.path}>
                    {i > 0 && ", "}
                    <span className="whitespace-nowrap">
                      <span className="font-mono text-[12.5px] text-fg">{p.path}</span>{" "}
                      <span className="px-px text-fg-faint">→</span> {p.word}
                    </span>
                  </span>
                ))}
                {row.rest}
              </>
            )}
          </p>
          {fold && (
            <>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {fold.line}
                <button
                  type="button"
                  className={cn(QUIET, "ml-1.5")}
                  aria-expanded={why}
                  onClick={() => setWhy((v) => !v)}
                >
                  {why ? "Hide" : "Why"}
                </button>
              </p>
              {why && (
                <p className="mt-1.5 max-w-[58ch] rounded-sm border border-border bg-surface-muted px-2.5 py-2 text-[12.5px] leading-normal text-fg-muted">
                  {fold.why}
                </p>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          className={cn(QUIET, "justify-self-end", fold && "mt-0.5")}
          onClick={onChange}
        >
          Change
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Change dialog
// ---------------------------------------------------------------------------

function KindSelect({
  value,
  onChange,
  label,
  defaultOpen,
}: {
  value: SiteMapKind | null;
  onChange: (k: SiteMapKind) => void;
  label: string;
  defaultOpen?: boolean;
}) {
  return (
    <SelectPrimitive.Root
      value={value ?? undefined}
      onValueChange={(v) => onChange(v as SiteMapKind)}
      defaultOpen={defaultOpen}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          "flex h-[30px] min-w-0 items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface pl-2.5 pr-2 text-left text-[13px] text-fg",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] data-[state=open]:border-fg",
          (value === null || value === "none") && "text-fg-muted",
        )}
      >
        <SelectPrimitive.Value placeholder={<span className="block truncate">Choose</span>}>
          <span className="block truncate">{value ? KIND_WORD[value] : "Choose"}</span>
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={14} className="flex-none text-fg-faint" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-[60] w-[220px] max-w-[calc(100vw-24px)] rounded-md border border-border-strong bg-surface p-1"
        >
          <SelectPrimitive.Viewport>
            {KIND_OPTIONS.map((k) => (
              <div key={k}>
                {k === "none" && <SelectPrimitive.Separator className="my-1 h-px bg-border" />}
                <SelectPrimitive.Item
                  value={k}
                  className={cn(
                    "flex h-[30px] cursor-default select-none items-center justify-between gap-2 rounded-[3px] px-2 text-[13px] outline-none",
                    "data-[highlighted]:bg-surface-muted data-[state=checked]:font-medium",
                    k === "none" ? "text-fg-muted" : "text-fg",
                  )}
                >
                  <SelectPrimitive.ItemText>{KIND_WORD[k]}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Check size={14} className="text-fg" aria-hidden />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              </div>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function MenusSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] min-[480px]:min-h-0"
    >
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
      <span>
        Read your menus: <b className="font-medium text-fg">{on ? "On" : "Off"}</b>
      </span>
    </button>
  );
}

function TwoLines({ lines }: { lines: readonly [string, string] }) {
  return (
    <div className="mt-4 rounded-md border border-border bg-surface-muted px-4 py-3.5 text-[13px] text-fg">
      <p>{lines[0]}</p>
      <p className="mt-0.5 text-fg-muted">{lines[1]}</p>
    </div>
  );
}

export interface SiteMapEditorProps {
  view: SiteMapView;
  /** Save answered: the new view. */
  onSaved: (v: SiteMapView) => void;
  onCancel: () => void;
  /** For the fixtures and tests. */
  initial?: {
    tab?: string;
    on?: boolean;
    addOpen?: boolean;
    addPath?: string;
    addKind?: SiteMapKind | null;
    /** The path whose kind list is open on arrival. */
    openKindFor?: string;
  };
}

/** The dialog's body and foot, without the Radix root (so it renders in a test). */
export function SiteMapEditor({ view, onSaved, onCancel, initial = {} }: SiteMapEditorProps) {
  const [draft, setDraft] = useState<DraftRow[]>(() => draftFrom(view));
  const [on, setOn] = useState(initial.on ?? view.on);
  const [tab, setTab] = useState<string | null>(initial.tab ?? view.languages[0] ?? null);
  const [addOpen, setAddOpen] = useState(initial.addOpen ?? false);
  const [addPath, setAddPath] = useState(initial.addPath ?? "");
  const [addKind, setAddKind] = useState<SiteMapKind | null>(initial.addKind ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFrom(view));
    setOn(view.on);
  }, [view]);

  const tabs = dialogTabs(view, draft);
  const shown = tabs.length > 0 ? draft.filter((r) => r.tab === tab) : draft;

  function setKind(path: string, kind: SiteMapKind) {
    setDraft((d) => d.map((r) => (r.path === path ? { ...r, kind } : r)));
  }

  /** Removed from the list; Save sends it as `delete` (privacy review condition 5). */
  function remove(path: string) {
    setDraft((d) => d.filter((r) => r.path !== path));
  }

  function add() {
    const r = checkNewPath(
      addPath,
      draft.map((x) => x.path),
    );
    if ("error" in r) return setError(r.error);
    if (!addKind) return setError("Choose what kind of page it is.");
    setDraft((d) => [
      ...d,
      { path: r.path, kind: addKind, label: null, tab, missing: false, added: true },
    ]);
    setAddPath("");
    setAddKind(null);
    setAddOpen(false);
    setError(null);
  }

  async function save() {
    const body = saveBody(view, draft, on);
    if (!body) return onCancel();
    setSaving(true);
    setError(null);
    try {
      const next = await apiFetch<SiteMapView>("/admin/site-map", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSaved(next);
    } catch (e) {
      setError(apiErrorLine(e));
    } finally {
      setSaving(false);
    }
  }

  // The body: the list, or two lines when the switch says otherwise.
  const body =
    on && view.on ? null : !on && view.on ? OFF_SAVE_LINES : on ? ON_AGAIN_LINES : OFF_NOW_LINES;

  return (
    <div>
      {body ? (
        <TwoLines lines={body} />
      ) : (
        <>
          {tabs.length > 0 && (
            <div
              role="tablist"
              className="mt-4 flex gap-4 border-b border-border min-[480px]:gap-5"
            >
              {tabs.map((t) => (
                <button
                  key={t.lang}
                  type="button"
                  role="tab"
                  aria-selected={t.lang === tab}
                  onClick={() => setTab(t.lang)}
                  className={cn(
                    "-mb-px inline-flex h-8 items-center gap-1.5 whitespace-nowrap border-b-2 text-[13px]",
                    t.lang === tab
                      ? "border-fg font-medium text-fg"
                      : "border-transparent text-fg-muted hover:text-fg",
                  )}
                >
                  {t.label}
                  <span className="font-mono text-[11px] font-normal text-fg-faint">{t.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className={cn(tabs.length > 0 ? "mt-1" : "mt-4 border-t border-border")}>
            <ul className="max-h-[min(52vh,440px)] overflow-y-auto">
              {shown.map((r) => (
                <li
                  key={r.path}
                  className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_156px] items-center gap-2.5 border-b border-border py-[9px] min-[480px]:grid-cols-[minmax(0,1fr)_176px] min-[480px]:gap-4"
                >
                  <div className="min-w-0">
                    <span className="block truncate font-mono text-[13px] text-fg" title={r.path}>
                      {r.path}
                    </span>
                    <span className="mt-px flex min-w-0 items-baseline gap-2 text-xs">
                      {r.missing ? (
                        <span className="truncate text-fg-faint">Not in your menus now</span>
                      ) : (
                        r.label && <span className="truncate text-fg-muted">{r.label}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => remove(r.path)}
                        aria-label={`Remove ${r.path}`}
                        className="flex-none text-fg-faint underline decoration-dotted underline-offset-[3px] hover:text-fg focus-visible:text-fg"
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  <KindSelect
                    value={r.kind}
                    onChange={(k) => setKind(r.path, k)}
                    label={`Kind of ${r.path}`}
                    defaultOpen={initial.openKindFor === r.path}
                  />
                </li>
              ))}
            </ul>
            {addOpen ? (
              <div className="grid grid-cols-[minmax(0,1fr)_156px] items-center gap-2 pt-3 min-[480px]:grid-cols-[minmax(0,1fr)_176px_auto]">
                <input
                  value={addPath}
                  onChange={(e) => setAddPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") add();
                  }}
                  placeholder="/page"
                  aria-label="Path of the page"
                  className="h-[30px] min-w-0 rounded-sm border border-border-strong bg-surface px-2.5 font-mono text-[13px] text-fg placeholder:text-fg-faint"
                />
                <KindSelect value={addKind} onChange={setAddKind} label="Kind of the new page" />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={add}
                  className="col-span-full min-[480px]:col-span-1"
                >
                  Add
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg"
              >
                <Plus size={12} aria-hidden />
                Add a page
              </button>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="mt-3 text-[13px] text-state-err" role="alert">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-col items-stretch gap-3 border-t border-border pt-4 min-[480px]:flex-row min-[480px]:flex-wrap min-[480px]:items-center min-[480px]:justify-between">
        <MenusSwitch on={on} onToggle={() => setOn((v) => !v)} />
        <div className="flex gap-2 min-[480px]:ml-auto">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            className="flex-1 min-[480px]:flex-none"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="flex-1 min-[480px]:flex-none"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SiteMapDialog({
  open,
  onOpenChange,
  view,
  onSaved,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  view: SiteMapView | null;
  onSaved: (v: SiteMapView) => void;
  initial?: SiteMapEditorProps["initial"];
}) {
  return (
    <Dialog open={open && view !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] w-[calc(100%-20px)] max-w-[560px] overflow-y-auto px-4 py-5 min-[480px]:p-6">
        <DialogHeader className="mb-0 space-y-1">
          <DialogTitle className="pr-7 text-[15px]">Your pages</DialogTitle>
          <DialogDescription className="text-[13px]">
            Read from your menus. Fix any that are wrong.
          </DialogDescription>
        </DialogHeader>
        {view && (
          <SiteMapEditor
            view={view}
            initial={initial}
            onCancel={() => onOpenChange(false)}
            onSaved={(v) => {
              onSaved(v);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The Pages card's re-read line (mock section 05; founder's call 6 as amended)
// ---------------------------------------------------------------------------

export function ReReadLine({
  line,
  onWrite,
  onChange,
  busy = false,
  error = null,
}: {
  line: PendingLine;
  onWrite: () => void;
  onChange: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <div
      className="mt-2.5 rounded-sm border border-border bg-surface px-2.5 py-2 text-[13px]"
      data-row="re-read"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-fg">
          {line.plain ?? (
            <>
              {line.lead}
              {line.pairs.map((p, i) => (
                <span key={p.path}>
                  {i > 0 && ", "}
                  <span className="whitespace-nowrap">
                    <span className="font-mono text-[12.5px]">{p.path}</span> → {p.word}
                    {i === line.pairs.length - 1 && "."}
                  </span>
                </span>
              ))}
            </>
          )}{" "}
          <span className="text-fg-muted">{line.versions}</span>
        </span>
        <span className="flex items-center gap-3 min-[480px]:ml-auto">
          <Button type="button" size="sm" onClick={onWrite} disabled={busy}>
            {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
            Write
          </Button>
          <button type="button" className={QUIET} onClick={onChange}>
            Change
          </button>
        </span>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{line.auto}</p>
      {error && <p className="mt-1 text-xs text-state-err">{error}</p>}
    </div>
  );
}
