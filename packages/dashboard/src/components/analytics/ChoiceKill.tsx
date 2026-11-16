"use client";

/**
 * The superadmin's "Turn off visitor choice now" (ADR 0038 part 2;
 * docs/specs/direct-visitors.md §2, `POST /admin/choice/kill`), in Results'
 * Admin block. It overrides the customer's own switch; visitors stop seeing
 * the question within the bundle's reach (about six minutes). Never rendered
 * for a customer: the worker answers 403 to anyone else as well.
 */

import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/api";
import { type ChoiceState, choicePath, killChoice, reachText, readChoice } from "@/lib/direct";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const WARN = "text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]";

/** The row's value: the state in words and the one action. */
export function ChoiceKillValue({
  state,
  busy,
  onAsk,
}: {
  state: ChoiceState;
  busy: boolean;
  onAsk: () => void;
}) {
  const now = state.killed
    ? "Turned off by Rawuser"
    : state.on
      ? "On, visitors are asked"
      : state.live
        ? "Off, by the customer"
        : "No question yet";
  return (
    <>
      <span className="text-[12.5px]">{now}</span>
      <Button
        type="button"
        size="sm"
        variant={state.killed ? "secondary" : "destructive"}
        disabled={busy}
        onClick={onAsk}
      >
        {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        {state.killed ? "Allow it again" : "Turn off visitor choice now"}
      </Button>
    </>
  );
}

export function ChoiceKillDialog({
  state,
  busy,
  onConfirm,
  onClose,
}: {
  state: ChoiceState;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const reach = reachText(state.reachS);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-[420px] p-5">
        <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">
          {state.killed ? "Allow visitor choice again?" : "Turn off visitor choice now?"}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
          {state.killed
            ? `The customer's own switch decides again. If it is on, visitors are asked within ${reach}.`
            : `Visitors stop seeing the question within ${reach}, whatever the customer's switch says. The customer sees that Rawuser turned it off.`}
        </DialogDescription>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant={state.killed ? "default" : "destructive"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {state.killed ? "Allow it again" : "Turn it off now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The whole control with its read; null (nothing) on a worker without the endpoint. */
export function ChoiceKill({
  customerId,
  children,
}: {
  customerId: string;
  /** The Admin block's row, given the value and a line under it. */
  children: (value: React.ReactNode, below: React.ReactNode) => React.ReactNode;
}) {
  const [state, setState] = useState<ChoiceState | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; warn: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<unknown>(choicePath(customerId))
      .then((r) => !cancelled && setState(readChoice(r)))
      .catch(() => !cancelled && setState(null));
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  if (state === null) return null;
  if (state === undefined) {
    return <>{children(<span className="text-[12.5px] text-fg-muted">Reading</span>, null)}</>;
  }

  async function confirm(s: ChoiceState) {
    setBusy(true);
    setSaid(null);
    const out = await killChoice(customerId, !s.killed);
    setBusy(false);
    setAsking(false);
    if (out.kind === "failed") return setSaid({ text: out.message, warn: true });
    setState(out.value);
    setSaid({
      text: out.value.killed
        ? `Off. Visitors stop seeing it within ${reachText(out.value.reachS)}.`
        : "Allowed again. The customer's switch decides.",
      warn: false,
    });
  }

  return (
    <>
      {children(
        <ChoiceKillValue state={state} busy={busy} onAsk={() => setAsking(true)} />,
        said ? (
          <p aria-live="polite" className={cn("text-[12.5px]", said.warn ? WARN : "text-fg-muted")}>
            {said.text}
          </p>
        ) : null,
      )}
      {asking && (
        <ChoiceKillDialog
          state={state}
          busy={busy}
          onClose={() => setAsking(false)}
          onConfirm={() => void confirm(state)}
        />
      )}
    </>
  );
}
