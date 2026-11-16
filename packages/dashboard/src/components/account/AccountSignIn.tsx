"use client";

/**
 * Account, the Sign-in section (two-step mock §03): three rows. Two-step
 * sign-in (Off, or On since a date; Turn on, Turn off unless required),
 * Recovery codes (amber at 2 left), Other sessions (Sign out everywhere
 * else, never this one: call 5).
 */

import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  type MfaStatus,
  RECOVERY_TOTAL,
  endSession,
  getStatus,
  recoveryTone,
  shortDate,
  signOutOthers,
  signOutQuestion,
  signedOutLine,
} from "@/lib/mfa";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";
import * as React from "react";
import { type CheckMode, CodeCheckDialog } from "./CodeCheckDialog";
import { TurnOnDialog } from "./TurnOnDialog";
import { DoneLine, StatePill, WARN_TEXT } from "./TwoStepParts";

export const TURNED_OFF_LINE = "Two-step sign-in is off. Other devices were signed out.";

function Row({
  label,
  value,
  action,
}: {
  label: string;
  value: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="grid min-h-[60px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 px-4 py-3.5 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:px-5 [&+&]:border-t [&+&]:border-border">
      <span className="col-start-1 row-start-1 text-[13px] font-medium text-fg">{label}</span>
      <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-fg-muted sm:col-span-1 sm:col-start-2 sm:row-start-1">
        {value}
      </div>
      <div className="relative col-start-2 row-start-1 flex items-center justify-end gap-2 sm:col-start-3">
        {action}
      </div>
    </div>
  );
}

/** "Sign out everywhere else", or "Sign out" on a phone (mock §09). */
function TwoLabels({ long, short }: { long: string; short: string }) {
  return (
    <>
      <span className="hidden sm:inline">{long}</span>
      <span className="sm:hidden">{short}</span>
    </>
  );
}

export type OthersState = {
  confirming: boolean;
  busy: boolean;
  /** From the answer: how many sessions the click ended. */
  revoked: number | null;
  error: string | null;
};

export const OTHERS_START: OthersState = {
  confirming: false,
  busy: false,
  revoked: null,
  error: null,
};

export type AccountSignInViewProps = {
  status: MfaStatus;
  turnedOff: boolean;
  others: OthersState;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onNewCodes: () => void;
  onAskSignOut: () => void;
  onCancelSignOut: () => void;
  onSignOut: () => void;
  refs?: {
    signOut?: React.Ref<HTMLButtonElement>;
    cancel?: React.Ref<HTMLButtonElement>;
    done?: React.Ref<HTMLSpanElement>;
  };
};

export function AccountSignInView({
  status,
  turnedOff,
  others,
  onTurnOn,
  onTurnOff,
  onNewCodes,
  onAskSignOut,
  onCancelSignOut,
  onSignOut,
  refs = {},
}: AccountSignInViewProps) {
  const on = status.enabled;
  const left = status.recovery_codes_left;
  const count =
    others.revoked !== null
      ? 0
      : typeof status.other_sessions === "number"
        ? status.other_sessions
        : null;
  const noOthers = count === 0;

  return (
    <div className="rounded-md border border-border bg-surface">
      <Row
        label="Two-step sign-in"
        value={
          <>
            <StatePill on={on} />
            {on ? (
              <span>Since {status.enabled_at ? shortDate(status.enabled_at) : "today"}</span>
            ) : (
              <span>A code from your phone at each sign-in.</span>
            )}
            {on && status.required && (
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                <Lock size={12} aria-hidden />
                Required for your account
              </span>
            )}
            {!on && turnedOff && <DoneLine className="basis-full">{TURNED_OFF_LINE}</DoneLine>}
          </>
        }
        action={
          !on ? (
            <Button size="sm" onClick={onTurnOn}>
              Turn on
            </Button>
          ) : status.required ? null : (
            <Button size="sm" variant="ghost" className="text-fg-muted" onClick={onTurnOff}>
              Turn off
            </Button>
          )
        }
      />
      {on && (
        <Row
          label="Recovery codes"
          value={
            <span className={cn(recoveryTone(left) === "warn" && WARN_TEXT)}>
              <b className={cn("font-medium", recoveryTone(left) === "plain" && "text-fg")}>
                {left}
              </b>{" "}
              of {RECOVERY_TOTAL} left
            </span>
          }
          action={
            <Button size="sm" variant="secondary" onClick={onNewCodes}>
              <TwoLabels long="New recovery codes" short="New codes" />
            </Button>
          }
        />
      )}
      <Row
        label="Other sessions"
        value={
          others.revoked !== null ? (
            <DoneLine ref={refs.done}>{signedOutLine(others.revoked)}</DoneLine>
          ) : count === null ? (
            <span>Ends every other session.</span>
          ) : noOthers ? (
            <span>None</span>
          ) : (
            <span>
              <b className="font-medium text-fg">{count}</b> signed in elsewhere
            </span>
          )
        }
        action={
          <>
            <Button
              ref={refs.signOut}
              size="sm"
              variant="secondary"
              disabled={noOthers || others.busy}
              onClick={onAskSignOut}
              aria-expanded={others.confirming}
              aria-haspopup="dialog"
            >
              <TwoLabels long="Sign out everywhere else" short="Sign out" />
            </Button>
            {others.confirming && (
              <SignOutConfirm
                count={count}
                busy={others.busy}
                error={others.error}
                onCancel={onCancelSignOut}
                onConfirm={onSignOut}
                cancelRef={refs.cancel}
              />
            )}
          </>
        }
      />
    </div>
  );
}

function SignOutConfirm({
  count,
  busy,
  error,
  onCancel,
  onConfirm,
  cancelRef,
}: {
  count: number | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <dialog
      open
      aria-labelledby="sign-out-q"
      className="absolute left-auto right-0 top-[calc(100%+8px)] z-20 m-0 w-[min(290px,calc(100vw-64px))] whitespace-normal rounded-md border border-border-strong bg-surface px-4 py-3.5 text-left text-fg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h4 id="sign-out-q" className="text-[13.5px] font-semibold">
        {signOutQuestion(count)}
      </h4>
      <p className="mt-1 text-[12.5px] leading-normal text-fg-muted">
        Those devices need your password again.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-state-err">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          Sign out
        </Button>
      </div>
    </dialog>
  );
}

export function AccountSkeleton() {
  return (
    <div className="rounded-md border border-border bg-surface" aria-busy="true">
      {(["a", "b", "c"] as const).map((k) => (
        <div
          key={k}
          className="flex min-h-[60px] items-center gap-5 px-5 [&+&]:border-t [&+&]:border-border"
        >
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="ml-auto h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

/** The section with its calls and dialogs. `openCodes` opens New recovery codes once. */
export function AccountSignIn({ email, openCodes }: { email: string; openCodes: boolean }) {
  const [status, setStatus] = React.useState<MfaStatus | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [turnedOff, setTurnedOff] = React.useState(false);
  const [others, setOthers] = React.useState<OthersState>(OTHERS_START);
  const [turnOnOpen, setTurnOnOpen] = React.useState(false);
  const [check, setCheck] = React.useState<CheckMode | null>(null);
  const askedCodes = React.useRef(false);
  const signOutRef = React.useRef<HTMLButtonElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const doneRef = React.useRef<HTMLSpanElement>(null);

  const load = React.useCallback(async () => {
    setLoadError(false);
    const out = await getStatus();
    if (out.ok) setStatus(out.data);
    else if (out.kind === "session") endSession();
    else setLoadError(true);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The recovery line's link lands here with the New codes dialog open.
  React.useEffect(() => {
    if (openCodes && status?.enabled && !askedCodes.current) {
      askedCodes.current = true;
      setCheck("codes");
    }
  }, [openCodes, status]);

  React.useEffect(() => {
    if (others.confirming) cancelRef.current?.focus();
  }, [others.confirming]);
  React.useEffect(() => {
    if (others.revoked !== null) doneRef.current?.focus();
  }, [others.revoked]);

  // A click outside the confirm closes it.
  React.useEffect(() => {
    if (!others.confirming) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node | null;
      const pop = cancelRef.current?.closest("dialog");
      if (pop && t && !pop.contains(t) && !signOutRef.current?.contains(t)) {
        setOthers((o) => ({ ...o, confirming: false, error: null }));
      }
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [others.confirming]);

  async function signOut() {
    setOthers((o) => ({ ...o, busy: true, error: null }));
    const out = await signOutOthers();
    if (out.ok) {
      setOthers({ confirming: false, busy: false, revoked: out.data.revoked ?? 0, error: null });
      return;
    }
    if (out.kind === "session") return endSession();
    setOthers((o) => ({ ...o, busy: false, error: out.message }));
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-5 py-4 text-[13px] text-fg-muted">
        Couldn't load your sign-in settings.
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!status) return <AccountSkeleton />;

  return (
    <>
      <AccountSignInView
        status={status}
        turnedOff={turnedOff}
        others={others}
        onTurnOn={() => setTurnOnOpen(true)}
        onTurnOff={() => setCheck("off")}
        onNewCodes={() => setCheck("codes")}
        onAskSignOut={() => setOthers((o) => ({ ...o, confirming: !o.confirming, error: null }))}
        onCancelSignOut={() => {
          setOthers((o) => ({ ...o, confirming: false, error: null }));
          signOutRef.current?.focus();
        }}
        onSignOut={() => void signOut()}
        refs={{ signOut: signOutRef, cancel: cancelRef, done: doneRef }}
      />
      <TurnOnDialog
        open={turnOnOpen}
        onOpenChange={setTurnOnOpen}
        email={email}
        onEnabled={() => {
          setTurnedOff(false);
          // The other sessions ended with the switch; the count reads again.
          setOthers(OTHERS_START);
          void load();
        }}
      />
      <CodeCheckDialog
        mode={check ?? "codes"}
        open={check !== null}
        onOpenChange={(o) => {
          if (!o) setCheck(null);
        }}
        email={email}
        onChanged={(mode) => {
          if (mode === "off") setTurnedOff(true);
          setOthers(OTHERS_START);
          void load();
        }}
      />
    </>
  );
}
