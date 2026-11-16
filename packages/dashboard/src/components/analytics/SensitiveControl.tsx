"use client";

import { SwitchTrack } from "@/components/start/Measure";
import { TINT } from "@/components/start/tones";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/api";
import {
  ADD,
  CANCEL,
  CHANGE,
  CLAIMS_LINE,
  DIALOG_LEAD,
  DIALOG_TITLE,
  HIDE,
  HOW,
  KEPT_HELP,
  KEPT_LABEL,
  MARK_THIS_SITE,
  NOT_READ,
  OFF,
  ON,
  REWRITE_LINE,
  REWRITE_STEPS,
  SAVE,
  SECTION_PLACEHOLDER,
  SWITCH_LABEL,
  SWITCH_SUB,
  type SensitiveSaved,
  type SensitiveView,
  addSection,
  keptWord,
  readSensitive,
  removeSection,
  rewritingLine,
  saveSensitive,
  showsClaimsLine,
  staleCount,
} from "@/lib/sensitive";
import { cn } from "@/lib/utils";
import { Loader2, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

/**
 * The sensitive-site control (mock design/mock/sales-readiness/site-wide-
 * and-sensitive.html, sections 05 to 08, approved 2026-10-22), superadmin
 * only: the row in Results' Admin block, and the one dialog that "Mark this
 * site", "Change", the row's switch and the readiness list's "Mark it" all
 * open. Nothing here writes to production but Save; the rewrite of older
 * rows is three steps in words behind "How".
 */

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface SensitiveData {
  /** `missing`: an older worker or not a superadmin; nothing is drawn. */
  state: "loading" | "ok" | "missing" | "failed";
  view: SensitiveView | null;
  /** Versions waiting to be written again, while the flag is on. */
  rewriting: number;
  /** The last save in this session left older rows to rewrite (A17). */
  rowsToRewrite: boolean;
  reload: () => void;
  /** Take a save's answer, then read again. */
  apply: (saved: SensitiveSaved) => void;
}

/**
 * GET /admin/customers/sensitive, and, while the flag is on, the count of
 * versions waiting to be written. Read only for a superadmin: the API
 * answers a customer session 403, and nothing calls it then.
 */
export function useSensitive(customerId: string, superadmin: boolean): SensitiveData {
  const [state, setState] = useState<SensitiveData["state"]>("loading");
  const [view, setView] = useState<SensitiveView | null>(null);
  const [rewriting, setRewriting] = useState(0);
  // The customer whose last save left older rows: a session note, never stored.
  const [rewriteFor, setRewriteFor] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the reload trigger
  useEffect(() => {
    if (!customerId || !superadmin) {
      setState("missing");
      setView(null);
      return;
    }
    let cancelled = false;
    void readSensitive(customerId).then((out) => {
      if (cancelled) return;
      if (out.kind !== "ok") {
        setState(out.kind);
        setView(null);
        return;
      }
      setView(out.view);
      setState("ok");
      if (!out.view.sensitive) {
        setRewriting(0);
        return;
      }
      apiFetch<unknown>(`/admin/variants/list?customer_id=${encodeURIComponent(customerId)}`)
        .then((raw) => {
          if (!cancelled) setRewriting(staleCount(raw));
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, superadmin, key]);

  const apply = useCallback(
    (saved: SensitiveSaved) => {
      setView(saved);
      setState("ok");
      if (saved.rows_to_rewrite) setRewriteFor(customerId);
      if (!saved.sensitive) setRewriteFor(null);
      if (saved.versions_marked_stale > 0) setRewriting(saved.versions_marked_stale);
      reload();
    },
    [customerId, reload],
  );

  const rowsToRewrite = rewriteFor !== null && rewriteFor === customerId;
  return { state, view, rewriting, rowsToRewrite, reload, apply };
}

// ---------------------------------------------------------------------------
// The row in Admin (A14, A17 to A20)
// ---------------------------------------------------------------------------

function RowSwitch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={DIALOG_TITLE}
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] sm:min-h-0"
    >
      <SwitchTrack on={on} />
      <b className="font-medium text-fg">{on ? ON : OFF}</b>
    </button>
  );
}

/** The row's own part: the switch, the count, one button. The switch opens the dialog. */
export function SensitiveRowValue({
  data,
  onOpen,
}: {
  data: SensitiveData;
  onOpen: () => void;
}) {
  if (data.state === "loading") {
    return (
      <span className="inline-flex items-center text-fg-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span className="sr-only">Reading</span>
      </span>
    );
  }
  if (data.state !== "ok" || !data.view) {
    return <span className="text-[12.5px] text-fg-muted">{NOT_READ}</span>;
  }
  const on = data.view.sensitive;
  return (
    <>
      <RowSwitch on={on} onClick={onOpen} />
      {on && (
        <span className="text-[12.5px] text-fg-muted">
          {keptWord(data.view.kept_sections.length)}
        </span>
      )}
      <Button type="button" size="sm" variant="secondary" onClick={onOpen}>
        {on ? CHANGE : MARK_THIS_SITE}
      </Button>
    </>
  );
}

/** True when the row has a line under it (A17 to A19). */
export function hasSensitiveLines(data: SensitiveData): boolean {
  return (
    data.view?.sensitive === true && (data.rowsToRewrite || rewritingLine(data.rewriting) !== null)
  );
}

/**
 * The lines under the row: the rewrite of older rows (amber, its steps
 * behind "How"), and the versions sent back by the claims lock (quiet).
 */
export function SensitiveRowLines({
  data,
  howOpen = false,
}: {
  data: SensitiveData;
  /** For the fixtures and tests: "How" open on arrival. */
  howOpen?: boolean;
}) {
  if (!hasSensitiveLines(data)) return null;
  const rewriting = rewritingLine(data.rewriting);
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {data.rowsToRewrite && (
        <details className="group" open={howOpen} data-line="sensitive-rewrite">
          <summary
            className={cn(
              "cursor-pointer list-none rounded-sm px-2 py-1 leading-normal [&::-webkit-details-marker]:hidden",
              TINT.warn,
            )}
          >
            {REWRITE_LINE}{" "}
            <span className="whitespace-nowrap underline decoration-dotted underline-offset-[3px]">
              <span className="group-open:hidden">{HOW}</span>
              <span className="hidden group-open:inline">{HIDE}</span>
            </span>
          </summary>
          <ol className="mt-2 list-decimal rounded-sm border border-border bg-surface-muted py-2.5 pl-[30px] pr-3 text-[12.5px] leading-normal text-fg-muted">
            {REWRITE_STEPS.map((s) => (
              <li key={s} className="mt-1 first:mt-0">
                {s}
              </li>
            ))}
          </ol>
        </details>
      )}
      {rewriting && (
        <p
          className="rounded-sm bg-surface-muted px-2 py-1 leading-normal text-fg-muted"
          data-line="sensitive-rewriting"
        >
          {rewriting}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dialog (A15, A16, A23)
// ---------------------------------------------------------------------------

export interface SensitiveDialogProps {
  customerId: string;
  /**
   * The flag and the list as stored. Required: Save sends the list, so a
   * dialog opened before the read would overwrite the stored list.
   */
  view: SensitiveView;
  onClose: () => void;
  onSaved: (saved: SensitiveSaved) => void;
  /** For the fixtures and tests: the refusal drawn on arrival. */
  initialSaid?: string | null;
}

/**
 * One switch, the kept sections as chips with an input to add one, one line
 * under it. It opens with the switch on: every door to it ("Mark this
 * site", "Mark it", the row's switch while off) means to mark the site;
 * "Change" opens it as it is. Save sends the flag and the list together;
 * a refusal is the API's sentence in amber above the buttons.
 */
export function SensitiveDialog({
  customerId,
  view,
  onClose,
  onSaved,
  initialSaid = null,
}: SensitiveDialogProps) {
  const wasOn = view.sensitive;
  const [on, setOn] = useState(true);
  const [kept, setKept] = useState<string[]>(view.kept_sections);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(initialSaid);

  async function save() {
    // A section still in the input is part of what Save means.
    const list = addSection(kept, typed);
    setKept(list);
    setTyped("");
    setBusy(true);
    setSaid(null);
    const out = await saveSensitive(customerId, on, list);
    setBusy(false);
    if (out.kind === "ok") {
      onSaved(out.saved);
      return;
    }
    setSaid(out.kind === "refused" ? out.sentence : out.message);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] w-[calc(100%-2rem)] max-w-[448px] overflow-y-auto p-[18px] sm:p-6">
        <SensitiveBody
          wasOn={wasOn}
          on={on}
          kept={kept}
          typed={typed}
          busy={busy}
          said={said}
          onToggle={() => {
            setOn((v) => !v);
            setSaid(null);
          }}
          onTyped={setTyped}
          onAdd={() => {
            setKept((k) => addSection(k, typed));
            setTyped("");
          }}
          onRemove={(section) => {
            setKept((k) => removeSection(k, section));
            setSaid(null);
          }}
          onCancel={onClose}
          onSave={() => void save()}
        />
      </DialogContent>
    </Dialog>
  );
}

export interface SensitiveBodyProps {
  /** The flag as stored: the claims line shows only when Save would turn it on. */
  wasOn: boolean;
  on: boolean;
  kept: readonly string[];
  typed: string;
  busy: boolean;
  /** The API's refusal, as written. */
  said: string | null;
  onToggle: () => void;
  onTyped: (value: string) => void;
  onAdd: () => void;
  onRemove: (section: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

/** The dialog's content, drawn from its state (A15, A16, A23). */
export function SensitiveBody({
  wasOn,
  on,
  kept,
  typed,
  busy,
  said,
  onToggle,
  onTyped,
  onAdd,
  onRemove,
  onCancel,
  onSave,
}: SensitiveBodyProps) {
  const inputId = useId();
  const switchId = useId();
  return (
    <>
      <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">{DIALOG_TITLE}</DialogTitle>
      <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
        {DIALOG_LEAD}
      </DialogDescription>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-2.5">
        <div className="min-w-0">
          <p id={switchId} className="text-[13.5px] font-medium text-fg">
            {SWITCH_LABEL}
          </p>
          <p className="mt-px text-xs text-fg-muted">{SWITCH_SUB}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={switchId}
          disabled={busy}
          onClick={onToggle}
          className="inline-flex min-h-[44px] flex-none items-center gap-2 whitespace-nowrap rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50 sm:min-h-0"
        >
          <SwitchTrack on={on} />
          <b className="font-medium text-fg">{on ? ON : OFF}</b>
        </button>
      </div>
      {showsClaimsLine(wasOn, on) && (
        <p className="mt-2 text-xs text-fg-muted" data-line="claims">
          {CLAIMS_LINE}
        </p>
      )}

      <label htmlFor={inputId} className="mt-4 block text-xs font-medium text-fg">
        {KEPT_LABEL}
      </label>
      {kept.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0" data-list="kept">
          {kept.map((s) => (
            <li
              key={s}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border-strong bg-surface pl-[9px] pr-1.5 font-mono text-xs text-fg"
            >
              {s}
              <button
                type="button"
                aria-label={`Remove ${s}`}
                disabled={busy}
                onClick={() => onRemove(s)}
                className="inline-flex rounded-sm text-fg-faint hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        <input
          id={inputId}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={SECTION_PLACEHOLDER}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="h-[30px] min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-2.5 font-mono text-[13px] text-fg placeholder:text-fg-faint disabled:opacity-50"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onAdd}
          disabled={busy || typed.trim() === ""}
        >
          {ADD}
        </Button>
      </div>
      <p className="mt-2 text-xs text-fg-muted">{KEPT_HELP}</p>

      <div aria-live="polite">
        {said && (
          <p
            className={cn("mt-2.5 rounded-sm px-2 py-1 text-xs leading-normal", TINT.warn)}
            data-line="sensitive-refused"
          >
            {said}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {CANCEL}
        </Button>
        <Button type="button" onClick={onSave} disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {SAVE}
        </Button>
      </div>
    </>
  );
}
