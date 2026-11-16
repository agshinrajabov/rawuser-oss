"use client";

import { Segmented } from "@/components/start/PlatformSteps";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/api";
import {
  type LedgerRow,
  changeDialog,
  controlParts,
  dialogKind,
  endDialog,
  metricWhat,
  startDialog,
  startLedger,
} from "@/lib/proof";
import { cn } from "@/lib/utils";
import type {
  HoldoutControl as HoldoutControlData,
  HoldoutSetResult,
  LiftReport,
  WeeklyDraft,
} from "@/types/api";
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The test size in the Admin section, superadmin only (measure-setup mock,
 * section 05; proof-engine mock, section 3): Off, 10%, 20%, and 50% for a
 * small pilot. Every change goes through one dialog that states the cost
 * and the read time at this customer's own traffic. The test starts ten
 * minutes after the change, once every location has the setting.
 */

interface TestSizeProps {
  customerId: string;
  domain: string;
  control: HoldoutControlData;
  report: LiftReport | null;
  /** The change went through: reload the control and the card. */
  onChanged: () => void;
}

const LABEL: Record<number, string> = { 0: "Off", 10: "10%", 20: "20%", 50: "50%" };

export function TestSizeControl({ customerId, domain, control, report, onChanged }: TestSizeProps) {
  const current = control.running?.percent ?? 0;
  const [target, setTarget] = useState<number | null>(null);

  return (
    <>
      <Segmented
        label="Test size"
        value={String(current)}
        options={control.choices.map((p) => ({ value: String(p), label: LABEL[p] ?? `${p}%` }))}
        onChange={(v) => {
          const p = Number(v);
          if (p !== current) setTarget(p);
        }}
      />
      <span className="text-[12.5px] text-fg-muted">
        {controlParts(control).map((p) =>
          p.strong ? (
            <b key={p.text} className="font-medium text-fg">
              {p.text}
            </b>
          ) : (
            <span key={p.text}>{p.text}</span>
          ),
        )}
      </span>

      {target !== null && (
        <ChangeDialog
          customerId={customerId}
          domain={domain}
          control={control}
          report={report}
          from={current}
          to={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/** "Open Monday's draft": the weekly message, never sent from here. */
export function WeeklyDraftButton({ customerId }: { customerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Open Monday&apos;s draft
      </Button>
      <span className="text-[12.5px] text-fg-muted">Never sent from here.</span>
      {open && <WeeklyDraftDialog customerId={customerId} onClose={() => setOpen(false)} />}
    </>
  );
}

function Ledger({ rows }: { rows: LedgerRow[] }) {
  return (
    <dl className="mt-4 border-t border-border">
      {rows.map((r) => (
        <div
          key={r.dt}
          className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-b border-border py-2.5 text-[13px] leading-normal sm:grid-cols-[118px_minmax(0,1fr)]"
        >
          <dt className="pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-muted">
            {r.dt}
          </dt>
          <dd className="m-0 text-fg">
            {r.dd}
            {r.m && <span className="mt-0.5 block text-[12.5px] text-fg-muted">{r.m}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The one dialog for every change of the test size (superadmin). */
export function ChangeDialog({
  customerId,
  domain,
  control,
  report,
  from,
  to,
  onClose,
  onDone,
}: {
  customerId: string;
  domain: string;
  control: HoldoutControlData;
  report: LiftReport | null;
  from: number;
  to: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const kind = dialogKind(from, to);
  const what = report ? metricWhat(report) : "one of your confirmed buttons";
  const ledger = kind === "end" ? null : startLedger(control, to, what, now);
  const text =
    kind === "end"
      ? endDialog(domain, report)
      : kind === "start"
        ? { ...startDialog(domain, to), rows: ledger?.rows ?? [] }
        : { ...changeDialog(domain, control, report, from, to, now), rows: ledger?.rows ?? [] };

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<HoldoutSetResult>("/admin/customers/holdout", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, percent: to }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change did not go through. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-[520px] overflow-y-auto">
        <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">{text.title}</DialogTitle>
        <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
          {text.lead}
        </DialogDescription>
        <Ledger rows={text.rows} />
        {ledger && (
          <div className="mt-2.5 overflow-x-auto">
            <div className="grid w-max grid-cols-[auto_auto_auto_auto] gap-x-4 gap-y-1 font-mono text-[11.5px] text-fg-muted">
              <span className="text-fg-faint">Holdout</span>
              <span className="text-fg-faint">Reads in</span>
              <span className="text-fg-faint">Visits a month</span>
              <span className="text-fg-faint">Clicks given up</span>
              {ledger.compare.map((r) => (
                <div key={r.percent} className={cn("contents", r.on && "text-fg")}>
                  <span>{r.percent}%</span>
                  <span>{r.weeks}</span>
                  <span>{r.visits}</span>
                  <span>{r.clicks}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {ledger && <p className="mt-3 text-xs leading-normal text-fg-muted">{ledger.basis}</p>}
        {error && <p className="mt-3 text-[13px] text-state-err">{error}</p>}
        <div className="mt-[22px] flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {text.cancel}
          </Button>
          <Button
            type="button"
            variant={text.danger ? "destructive" : "default"}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {text.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Monday's message as a draft for the founder (founder, 2026-10-04): the
 * code never sends it, and a negative one never goes out without him
 * writing first.
 */
function WeeklyDraftDialog({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const [draft, setDraft] = useState<WeeklyDraft | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<WeeklyDraft>(`/admin/analytics/weekly?customer_id=${encodeURIComponent(customerId)}`)
      .then((d) => {
        if (!cancelled) setDraft(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.text}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the text stays selectable
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-[720px] overflow-y-auto p-0">
        <div className="px-6 pt-6">
          <DialogTitle className="pr-7 text-[15px]">Monday&apos;s draft</DialogTitle>
          <DialogDescription className="mt-1 text-[13px]">
            Read from the closed days to last Sunday. Nothing is sent from here; you edit it and
            send it yourself.
          </DialogDescription>
        </div>
        {error && (
          <p className="px-6 pb-6 pt-3 text-[13px] text-fg-muted">
            The draft could not be read just now.
          </p>
        )}
        {!draft && !error && (
          <p className="flex items-center gap-2 px-6 pb-6 pt-3 text-[13px] text-fg-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the week…
          </p>
        )}
        {draft && (
          <div className="mx-6 mb-6 mt-4 rounded-md border border-border bg-surface">
            <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-[3px] border-b border-border px-[18px] py-3 font-mono text-[11.5px] text-fg-muted">
              <span className="text-fg-faint">Week to</span>
              <span>{draft.week_ending}</span>
              <span className="text-fg-faint">Subject</span>
              <span className="text-fg">{draft.subject}</span>
            </div>
            <pre className="m-0 whitespace-pre-wrap p-[18px] font-mono text-[12.5px] leading-[1.65] text-fg">
              {draft.text}
            </pre>
            <div className="flex justify-end border-t border-border px-3 py-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy the draft"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
