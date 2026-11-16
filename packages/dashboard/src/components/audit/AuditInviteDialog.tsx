"use client";

/**
 * "New audit link" (mock section 01): the invite dialog in its audit kind.
 * Three states: the form, the link made (shown once, only its hash is
 * stored), and refused (audit links off, or ten audits open), each in the
 * API's own sentence.
 */

import { Button } from "@/components/ui/Button";
import { CopyBlock } from "@/components/ui/CopyBlock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { apiMessage, fullDate } from "@/lib/audit";
import { type AuditInviteAnswer, type AuditSummary, makeAuditInvite } from "@/lib/audit-api";
import { useEffect, useState } from "react";

/** The API's sentence while AUDIT_INVITES is off (403 audit_invites_off). */
export const INVITES_OFF_LINE = "Audit links are off until the sign-in protection is deployed.";

export type InviteState =
  | { kind: "form"; name: string; site: string; busy?: boolean; error?: string | null }
  | { kind: "made"; invite: AuditInviteAnswer }
  | { kind: "refused"; message: string };

export function openLine(summary: AuditSummary | null): string {
  return summary ? `${summary.open} of ${summary.max} audits open` : "";
}

/** The dialog's body for one state; the parent owns the Dialog. */
export function AuditInviteBody({
  state,
  summary,
  onName,
  onSite,
  onSubmit,
  onClose,
}: {
  state: InviteState;
  summary: AuditSummary | null;
  onName: (v: string) => void;
  onSite: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const open = openLine(summary);
  return (
    <>
      <DialogHeader>
        <DialogTitle>New audit link</DialogTitle>
        <DialogDescription>
          {state.kind === "made"
            ? "Copy it now. Only its hash is stored, so it cannot be shown again."
            : state.kind === "refused"
              ? state.message
              : `One sign-up, 14 days.${open ? ` ${open}.` : ""}`}
        </DialogDescription>
      </DialogHeader>
      {state.kind === "made" && (
        <div className="flex flex-col gap-2">
          <CopyBlock label="Audit link" content={state.invite.link} multiline />
          <p className="text-xs text-fg-muted">Expires {fullDate(state.invite.expires_at)}</p>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </div>
      )}
      {state.kind === "refused" && (
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      )}
      {state.kind === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-invite-name">Name</Label>
            <Input
              id="audit-invite-name"
              placeholder="Rina Holt"
              value={state.name}
              onChange={(e) => onName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-invite-site">Site</Label>
            <Input
              id="audit-invite-site"
              placeholder="quoteloom.example"
              value={state.site}
              onChange={(e) => onSite(e.target.value)}
            />
          </div>
          {state.error && <p className="text-xs text-state-err">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={state.busy}>
              {state.busy ? "Making link…" : "Make link"}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}

export function AuditInviteDialog({
  open,
  onOpenChange,
  summary,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: AuditSummary | null;
  onCreated: () => void;
}) {
  const initial = (): InviteState =>
    summary && !summary.invites_on
      ? { kind: "refused", message: INVITES_OFF_LINE }
      : { kind: "form", name: "", site: "" };
  const [state, setState] = useState<InviteState>(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh state each time the dialog opens
  useEffect(() => {
    if (open) setState(initial());
  }, [open]);

  async function submit() {
    if (state.kind !== "form" || state.busy) return;
    setState({ ...state, busy: true, error: null });
    try {
      const body: { name?: string; site?: string } = {};
      if (state.name.trim()) body.name = state.name.trim();
      if (state.site.trim()) body.site = state.site.trim();
      const invite = await makeAuditInvite(body);
      setState({ kind: "made", invite });
      onCreated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/^API error (403|409)/.test(msg)) {
        setState({ kind: "refused", message: apiMessage(e, INVITES_OFF_LINE) });
      } else {
        setState({ ...state, busy: false, error: "Could not make the link. Try again." });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <AuditInviteBody
          state={state}
          summary={summary}
          onName={(name) => state.kind === "form" && setState({ ...state, name })}
          onSite={(site) => state.kind === "form" && setState({ ...state, site })}
          onSubmit={() => void submit()}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
