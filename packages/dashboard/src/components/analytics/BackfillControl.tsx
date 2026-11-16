"use client";

import { WARN_WASH } from "@/components/start/tones";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import {
  type BackfillOutcome,
  type BackfillWhat,
  type QueueState,
  backfillCopy,
  busyMessage,
  queueLine,
  readQueue,
  resultView,
  runBackfill,
} from "@/lib/backfill";
import { cn } from "@/lib/utils";
import { Clock, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The two rebuilds in the Admin section, superadmin only
 * (docs/specs/proof-engine.md, Rollout step 0.5; measure-setup mock,
 * section 05): Rebuild version history (bodies), then Rebuild daily counts
 * (outcomes), once per customer after a deploy. Each opens one dialog that
 * says what it writes, checks the write queue, runs, and shows the
 * endpoint's counts.
 */

interface BackfillControlProps {
  customerId: string;
  domain: string;
  /** A customer role renders nothing; the endpoint answers it 403 anyway. */
  superadmin: boolean;
}

/** The buttons and their dialog; the Admin row around them carries the label and the warning. */
export function BackfillControl({ customerId, domain, superadmin }: BackfillControlProps) {
  const [open, setOpen] = useState<BackfillWhat | null>(null);
  if (!superadmin) return null;

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen("bodies")}>
        Rebuild version history
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen("outcomes")}>
        Rebuild daily counts
      </Button>
      <span className="text-[12.5px] text-fg-muted">
        Once per customer after a deploy, history first.
      </span>

      {open && (
        <BackfillDialog
          customerId={customerId}
          domain={domain}
          what={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function BackfillDialog({
  customerId,
  domain,
  what,
  onClose,
}: {
  customerId: string;
  domain: string;
  what: BackfillWhat;
  onClose: () => void;
}) {
  const copy = backfillCopy(what, domain);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<BackfillOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    readQueue(customerId).then((q) => {
      if (!cancelled) setQueue(q);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  async function confirm() {
    setRunning(true);
    setOutcome(null);
    const result = await runBackfill(customerId, what);
    setOutcome(result);
    if (result.kind === "busy" && result.waiting !== null) {
      setQueue({ kind: "busy", waiting: result.waiting });
    }
    setRunning(false);
  }

  const done = outcome?.kind === "done";
  const blocked = queue?.kind === "busy";

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-[520px] overflow-y-auto">
        <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">{copy.title}</DialogTitle>
        <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
          {copy.lead}
        </DialogDescription>
        <dl className="mt-4 border-t border-border">
          {[...copy.rows, { dt: "Write queue", dd: queueLine(queue, domain) }].map((r) => (
            <div
              key={r.dt}
              className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-b border-border py-2.5 text-[13px] leading-normal sm:grid-cols-[118px_minmax(0,1fr)]"
            >
              <dt className="pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-muted">
                {r.dt}
              </dt>
              <dd
                className={cn(
                  "m-0 text-fg",
                  r.dt === "Write queue" && queue === null && "text-fg-muted",
                )}
              >
                {r.dt === "Write queue" && blocked && (
                  <span
                    aria-hidden
                    className="mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-state-warn"
                  />
                )}
                {r.dd}
              </dd>
            </div>
          ))}
        </dl>

        {/* Always mounted, so a screen reader hears the answer when it lands. */}
        <div aria-live="polite">
          {outcome && <BackfillResult outcome={outcome} domain={domain} />}
        </div>

        <div className="mt-[22px] flex flex-wrap justify-end gap-2">
          {done ? (
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onClose} disabled={running}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void confirm()}
                disabled={running || queue === null || blocked}
              >
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {running ? copy.running : copy.confirm}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the endpoint answered, in words and counts. Exported for the test. */
export function BackfillResult({ outcome, domain }: { outcome: BackfillOutcome; domain: string }) {
  if (outcome.kind === "busy") {
    return (
      <p
        className={cn(
          "mt-4 flex gap-2 rounded-sm border border-[color-mix(in_srgb,var(--state-warn)_40%,transparent)] px-3.5 py-3 text-[13px] leading-normal text-fg",
          WARN_WASH,
        )}
      >
        <Clock className="mt-[2px] h-3.5 w-3.5 shrink-0 text-state-warn" aria-hidden />
        {busyMessage(outcome.waiting, domain)}
      </p>
    );
  }
  if (outcome.kind === "failed") {
    return (
      <p role="alert" className="mt-3 text-[13px] leading-normal text-state-err">
        {outcome.message}
      </p>
    );
  }
  const view = resultView(outcome, domain);
  return (
    <div className="mt-4 rounded-sm border border-border px-3.5 py-3">
      <p className="text-[13px] font-medium text-fg">{view.headline}</p>
      {view.stats.length > 0 && (
        <dl className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5">
          {view.stats.map((s) => (
            <div key={s.k}>
              <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-faint">
                {s.k}
              </dt>
              <dd className="m-0 font-mono text-[15px] tabular-nums text-fg">{s.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.note && <p className="mt-2.5 text-xs leading-normal text-fg-muted">{view.note}</p>}
    </div>
  );
}
