"use client";

/**
 * Required set-up (two-step mock §05): when the role needs two-step
 * sign-in and it is off, sign-in lands here with a 15-minute set-up
 * session. The same four steps as the Turn on dialog, on the login's own
 * page (call 9): no sidebar, no trap, no close. Done opens the dashboard
 * with the new token.
 */

import {
  CodesBlock,
  KeyBlock,
  QrCode,
  SavedCheck,
  StepBar,
} from "@/components/account/TwoStepParts";
import { useTurnOn } from "@/components/account/useTurnOn";
import { type SessionUser, clearSession, getCurrentSession } from "@/lib/auth";
import { homeFor } from "@/lib/mfa";
import { STEP_NAMES, type TurnOnState, canSend } from "@/lib/turn-on";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  SignInAlt,
  SignInButton,
  SignInError,
  SignInFoot,
  SignInFrame,
  SignInLabel,
  SignInLinkButton,
  SignInSub,
  SignInTitle,
  signInCode,
  signInInput,
} from "./SignIn";

export type RequiredSetupViewProps = {
  email: string;
  state: TurnOnState;
  madeAt: number;
  onPassword: (v: string) => void;
  onCode: (v: string) => void;
  onSendPassword: () => void;
  onSendCode: () => void;
  onNext: () => void;
  onBack: () => void;
  onSaved: (v: boolean) => void;
  onRestart: () => void;
  onDone: () => void;
  onSignOut: () => void;
  refs?: {
    field?: React.Ref<HTMLInputElement>;
    primary?: React.Ref<HTMLButtonElement>;
    title?: React.Ref<HTMLHeadingElement>;
  };
};

export function RequiredSetupView({
  email,
  state: s,
  madeAt,
  onPassword,
  onCode,
  onSendPassword,
  onSendCode,
  onNext,
  onBack,
  onSaved,
  onRestart,
  onDone,
  onSignOut,
  refs = {},
}: RequiredSetupViewProps) {
  const done = s.step === 4;
  const ended = s.stop === "session";
  const expired = s.stop === "expired";
  const message = s.fieldError ?? s.blockError;
  const errorId = "setup-error";

  function primary() {
    if (ended) {
      return (
        <SignInButton ref={refs.primary} type="button" onClick={onSignOut}>
          Back to sign in
        </SignInButton>
      );
    }
    if (expired) {
      return (
        <SignInButton ref={refs.primary} type="button" onClick={onRestart}>
          Start again
        </SignInButton>
      );
    }
    if (s.step === 1) return <SignInButton disabled={!canSend(s)}>Continue</SignInButton>;
    if (s.step === 2) return <SignInButton ref={refs.primary}>Next</SignInButton>;
    if (s.step === 3) {
      return <SignInButton disabled={!canSend(s)}>{s.busy ? "Checking…" : "Turn on"}</SignInButton>;
    }
    return (
      <SignInButton type="button" disabled={!s.saved} onClick={onDone}>
        Done
      </SignInButton>
    );
  }

  return (
    <SignInFrame align={done ? "top" : "center"}>
      <SignInTitle ref={refs.title} tabIndex={-1}>
        {done ? "All set." : "Secure your account."}
      </SignInTitle>
      <SignInSub>
        {done
          ? "Two-step sign-in is on. Save these codes now."
          : "Your account needs two-step sign-in."}
      </SignInSub>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (s.step === 1 && canSend(s)) onSendPassword();
          else if (s.step === 2) onNext();
          else if (s.step === 3 && canSend(s)) onSendCode();
        }}
      >
        <div className={cn("flex flex-col gap-3", "mt-5")}>
          <StepBar step={s.step} name={STEP_NAMES[s.step]} live />

          {s.step === 1 && (
            <div>
              <SignInLabel htmlFor="setup-password">Password</SignInLabel>
              <input
                id="setup-password"
                ref={refs.field}
                type="password"
                autoComplete="current-password"
                placeholder="Your password again"
                value={s.password}
                onChange={(e) => onPassword(e.target.value)}
                disabled={s.stop === "locked" || ended}
                aria-invalid={s.fieldError ? true : undefined}
                aria-describedby={message ? errorId : undefined}
                className={signInInput}
              />
            </div>
          )}

          {s.step === 2 && s.secret && s.uri && (
            <div className="mt-1 grid grid-cols-1 items-center justify-items-center gap-5 sm:grid-cols-[168px_minmax(0,1fr)] sm:justify-items-start">
              <QrCode uri={s.uri} />
              <KeyBlock
                secret={s.secret}
                lead="Scan it with your authenticator app. Or type this key."
                center
              />
            </div>
          )}

          {s.step === 3 && (
            <div>
              <SignInLabel htmlFor="setup-code">Code</SignInLabel>
              <input
                id="setup-code"
                ref={refs.field}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                spellCheck={false}
                value={s.code}
                onChange={(e) => onCode(e.target.value)}
                readOnly={s.busy}
                disabled={s.stop !== null}
                aria-invalid={s.fieldError ? true : undefined}
                aria-describedby={message ? errorId : undefined}
                className={cn(signInInput, signInCode)}
              />
            </div>
          )}

          {done && (
            <div>
              <CodesBlock codes={s.codes ?? []} email={email} madeAt={madeAt} columns="two" />
              <SavedCheck checked={s.saved} onChange={onSaved} className="mt-3" />
            </div>
          )}
        </div>

        {message && <SignInError id={errorId}>{message}</SignInError>}
        {primary()}
      </form>

      {(s.step === 2 || s.step === 3) && !ended && !expired && (
        <SignInAlt>
          <SignInLinkButton onClick={onBack}>Back</SignInLinkButton>
        </SignInAlt>
      )}

      {!done && !ended && (
        <SignInFoot>
          {email}
          {" · "}
          <SignInLinkButton muted onClick={onSignOut}>
            Sign out
          </SignInLinkButton>
        </SignInFoot>
      )}
    </SignInFrame>
  );
}

export function RequiredSetup() {
  const router = useRouter();
  const t = useTurnOn();
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const field = React.useRef<HTMLInputElement>(null);
  const primary = React.useRef<HTMLButtonElement>(null);
  const title = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    let alive = true;
    void getCurrentSession().then((s) => {
      if (!alive) return;
      if (!s) router.replace("/login");
      else if (!s.enrolOnly) router.replace(homeFor(s.user));
      else setUser(s.user);
    });
    return () => {
      alive = false;
    };
  }, [router]);

  // Each step change moves focus to its field or its primary button.
  const { step, stop, fieldError } = t.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new error refocuses too
  React.useEffect(() => {
    if (!user) return;
    if (stop === "session" || stop === "expired" || step === 2) primary.current?.focus();
    else if (step === 4) title.current?.focus();
    else field.current?.focus();
  }, [user, step, stop, fieldError]);

  function signOut() {
    clearSession();
    router.replace("/login");
  }

  if (!user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-fg"
          aria-label="Loading"
        />
      </div>
    );
  }

  return (
    <RequiredSetupView
      email={user.email}
      state={t.state}
      madeAt={t.madeAt}
      onPassword={t.setPassword}
      onCode={t.setCode}
      onSendPassword={t.sendPassword}
      onSendCode={t.sendCode}
      onNext={t.next}
      onBack={t.back}
      onSaved={t.setSaved}
      onRestart={t.restart}
      onDone={() => router.replace(homeFor(user))}
      onSignOut={signOut}
      refs={{ field, primary, title }}
    />
  );
}
