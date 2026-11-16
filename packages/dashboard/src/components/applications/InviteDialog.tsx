"use client";

/**
 * New invite link: optional name, site and email, then the one-time link
 * with a copy step and, when an address was given, one line on whether the
 * email went out (docs/specs/invite-email.md §7). The worker keeps only the
 * token's hash, so this is the only time the link can be shown. Pilot
 * invites only; audit links have their own dialog and no email field.
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
import { ApiError } from "@/lib/api";
import { toMs } from "@/lib/apply";
import { EMAIL_HELP, emailLine, inviteBody, makePilotInvite } from "@/lib/invite";
import type { PilotApplicationInvite } from "@/types/api";
import { useState } from "react";

export const BAD_EMAIL_LINE = "Enter one email address, like name@example.com.";

export type PilotInviteState =
  | {
      kind: "form";
      name: string;
      site: string;
      email: string;
      busy?: boolean;
      error?: string | null;
    }
  | { kind: "made"; invite: PilotApplicationInvite; email: string };

/** The dialog's body for one state; the parent owns the Dialog. */
export function PilotInviteBody({
  state,
  onName,
  onSite,
  onEmail,
  onSubmit,
  onClose,
}: {
  state: PilotInviteState;
  onName: (v: string) => void;
  onSite: (v: string) => void;
  onEmail: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const expires = state.kind === "made" ? toMs(state.invite.expires_at) : null;
  const sent = state.kind === "made" ? emailLine(state.invite, state.email) : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>New invite link</DialogTitle>
        <DialogDescription>
          {state.kind === "made"
            ? "Copy it now. Only its hash is stored, so it cannot be shown again."
            : "One submission, 14 days. Name and site are optional; they only label the invite."}
        </DialogDescription>
      </DialogHeader>

      {state.kind === "made" ? (
        <div className="flex flex-col gap-2">
          <CopyBlock label="Invite link" content={state.invite.link} multiline />
          {sent && (
            <p
              className={`text-xs ${sent.ok ? "text-fg" : "text-state-warn"}`}
              data-email-line={sent.ok ? "sent" : "not-sent"}
            >
              {sent.text}
            </p>
          )}
          {expires && (
            <p className="text-xs text-fg-muted">
              Expires{" "}
              {new Date(expires).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </p>
          )}
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-name">Name</Label>
            <Input
              id="invite-name"
              placeholder="Northwind"
              value={state.name}
              onChange={(e) => onName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-site">Site</Label>
            <Input
              id="invite-site"
              placeholder="northwind.example"
              value={state.site}
              onChange={(e) => onSite(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email">Email (optional)</Label>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="name@example.com"
              aria-describedby="invite-email-help"
              value={state.email}
              onChange={(e) => onEmail(e.target.value)}
            />
            <p id="invite-email-help" className="text-xs text-fg-muted">
              {EMAIL_HELP}
            </p>
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

const EMPTY: PilotInviteState = { kind: "form", name: "", site: "", email: "" };

export function InviteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [state, setState] = useState<PilotInviteState>(EMPTY);

  async function submit() {
    if (state.kind !== "form" || state.busy) return;
    setState({ ...state, busy: true, error: null });
    const body = inviteBody(state.name, state.site, state.email);
    try {
      const invite = await makePilotInvite(body);
      setState({ kind: "made", invite, email: body.email ?? "" });
      onCreated();
    } catch (err) {
      const error =
        err instanceof ApiError && err.status === 400 && body.email
          ? BAD_EMAIL_LINE
          : err instanceof Error
            ? err.message
            : "Could not make the link.";
      setState({ ...state, busy: false, error });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setState(EMPTY);
      }}
    >
      <DialogContent>
        <PilotInviteBody
          state={state}
          onName={(name) => state.kind === "form" && setState({ ...state, name })}
          onSite={(site) => state.kind === "form" && setState({ ...state, site })}
          onEmail={(email) => state.kind === "form" && setState({ ...state, email })}
          onSubmit={() => void submit()}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
