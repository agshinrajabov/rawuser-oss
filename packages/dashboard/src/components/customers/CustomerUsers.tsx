"use client";

/**
 * A customer's users under its card on Customers, with a superadmin's reset
 * of a lost two-step device (two-step mock §06). Reset shows only on a user
 * with two-step on (call 8); the confirm names the email and starts on
 * Cancel, so Enter never resets by accident. Superadmins are never listed
 * (the API returns customer users only). Without the list route on the
 * worker (A2) the Users line stays hidden.
 */

import { DialogX, dialogDesc, dialogTitle } from "@/components/account/TurnOnDialog";
import { BlockError, DoneLine, StatePill } from "@/components/account/TwoStepParts";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  type CustomerUser,
  endSession,
  listCustomerUsers,
  resetDoneLine,
  resetTwoStep,
} from "@/lib/mfa";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import * as React from "react";

export type UsersViewProps = {
  customerId: string;
  users: CustomerUser[];
  open: boolean;
  /** user id → the done line's revoked count, after a reset. */
  done: Record<string, number>;
  onToggle: () => void;
  onReset: (user: CustomerUser) => void;
  doneRef?: (id: string) => React.Ref<HTMLSpanElement>;
};

const grid =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 sm:h-11 sm:grid-cols-[minmax(0,1fr)_180px_190px] sm:py-0 sm:pl-10";

export function CustomerUsersView({
  customerId,
  users,
  open,
  done,
  onToggle,
  onReset,
  doneRef,
}: UsersViewProps) {
  const listId = `users-${customerId}`;
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        disabled={users.length === 0}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12.5px] text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:hover:text-fg-muted"
      >
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "shrink-0 text-fg-faint transition-transform duration-fast",
            open ? "rotate-180" : "-rotate-90",
          )}
        />
        Users · {users.length}
      </button>
      {open && users.length > 0 && (
        <div id={listId}>
          <div
            aria-hidden
            className={cn(
              grid,
              "hidden h-8 border-t border-border text-[11px] font-medium uppercase tracking-[0.04em] text-fg-faint sm:grid sm:h-8",
            )}
          >
            <span>Email</span>
            <span>Two-step</span>
            <span />
          </div>
          <ul aria-label="Users">
            {users.map((u) => {
              const revoked = done[u.id];
              return (
                <li key={u.id} className={cn(grid, "border-t border-border text-[13px]")}>
                  <span className="truncate text-fg">{u.email}</span>
                  <span className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">
                    <span className="sr-only">Two-step: </span>
                    <StatePill on={u.two_step} />
                  </span>
                  <span className="col-start-2 row-span-2 row-start-1 text-right sm:col-start-3 sm:row-span-1">
                    {revoked !== undefined ? (
                      <DoneLine ref={doneRef?.(u.id)}>{resetDoneLine(revoked)}</DoneLine>
                    ) : u.two_step ? (
                      <Button size="sm" variant="secondary" onClick={() => onReset(u)}>
                        Reset two-step
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export type ResetBodyProps = {
  email: string;
  busy: boolean;
  error: string | null;
  onReset: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
};

export function ResetBody({ email, busy, error, onReset, cancelRef }: ResetBodyProps) {
  return (
    <>
      <DialogX />
      <DialogTitle className={dialogTitle}>Reset two-step sign-in for {email}?</DialogTitle>
      <DialogDescription className={dialogDesc}>
        They sign in with their password and set it up again. Their sessions end.
      </DialogDescription>
      <p className={cn(dialogDesc, "mt-2.5 text-[12.5px]")}>Only on a request you have checked.</p>
      {error && <BlockError>{error}</BlockError>}
      <div className="mt-5 flex">
        <div className="ml-auto flex w-full gap-2 sm:w-auto">
          <DialogClose asChild>
            <Button ref={cancelRef} variant="ghost" className="flex-1 sm:flex-none">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            className="flex-1 sm:flex-none"
            disabled={busy}
            onClick={onReset}
          >
            Reset
          </Button>
        </div>
      </div>
    </>
  );
}

export function CustomerUsers({ customerId }: { customerId: string }) {
  const [users, setUsers] = React.useState<CustomerUser[] | null>(null);
  const [open, setOpen] = React.useState(false);
  const [done, setDone] = React.useState<Record<string, number>>({});
  const [target, setTarget] = React.useState<CustomerUser | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const doneEls = React.useRef<Record<string, HTMLSpanElement | null>>({});
  const [focusDone, setFocusDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void listCustomerUsers(customerId).then((u) => {
      if (alive) setUsers(u);
    });
    return () => {
      alive = false;
    };
  }, [customerId]);

  // After Reset, focus goes to the row's done line (mock §08).
  React.useEffect(() => {
    if (focusDone) doneEls.current[focusDone]?.focus();
  }, [focusDone]);

  // A2 not on the worker yet, or refused: no Users line.
  if (users === null) return null;

  async function reset() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const out = await resetTwoStep(target.id);
    setBusy(false);
    if (!out.ok) {
      if (out.kind === "session") return endSession();
      setError(out.message);
      return;
    }
    const id = target.id;
    setUsers((list) => list?.map((u) => (u.id === id ? { ...u, two_step: false } : u)) ?? list);
    setDone((d) => ({ ...d, [id]: out.data.revoked ?? 0 }));
    setTarget(null);
    setFocusDone(id);
  }

  return (
    <>
      <CustomerUsersView
        customerId={customerId}
        users={users}
        open={open}
        done={done}
        onToggle={() => setOpen((o) => !o)}
        onReset={(u) => {
          setError(null);
          setTarget(u);
        }}
        doneRef={(id) => (el: HTMLSpanElement | null) => {
          doneEls.current[id] = el;
        }}
      />
      <Dialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      >
        {target && (
          <DialogContent
            hideClose
            aria-describedby={undefined}
            className="w-[calc(100%-24px)] max-w-[448px]"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              cancelRef.current?.focus();
            }}
          >
            <ResetBody
              email={target.email}
              busy={busy}
              error={error}
              onReset={() => void reset()}
              cancelRef={cancelRef}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
