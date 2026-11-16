"use client";

/**
 * Sign-in, second step (two-step mock §01): one field for the app's code,
 * or a recovery code instead. The code sends itself at the sixth digit;
 * Continue stays for anyone who tabs. The challenge lives in memory only
 * (call 10): a reload goes back to the password.
 */

import { setSession } from "@/lib/auth";
import {
  type Failure,
  homeFor,
  isFullCode,
  isFullRecovery,
  normalizeCode,
  normalizeRecovery,
  sendSecondStep,
  stashRecoveryNotice,
} from "@/lib/mfa";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  SignInAlt,
  SignInButton,
  SignInError,
  SignInFoot,
  SignInLabel,
  SignInLinkButton,
  SignInSub,
  SignInTitle,
  signInCode,
  signInInput,
  signInRecovery,
} from "./SignIn";

export type SecondMode = "code" | "recovery";
export type SecondPhase = "idle" | "sending" | "wrong" | "expired" | "locked" | "error";

export function phaseFor(kind: Failure): SecondPhase {
  if (kind === "wrong-code") return "wrong";
  if (kind === "expired" || kind === "session") return "expired";
  if (kind === "locked") return "locked";
  return "error";
}

export type SecondStepViewProps = {
  email: string;
  mode: SecondMode;
  value: string;
  phase: SecondPhase;
  message: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSwitch: () => void;
  onBack: () => void;
  fieldRef?: React.Ref<HTMLInputElement>;
  backRef?: React.Ref<HTMLButtonElement>;
};

export function SecondStepView({
  email,
  mode,
  value,
  phase,
  message,
  onChange,
  onSubmit,
  onSwitch,
  onBack,
  fieldRef,
  backRef,
}: SecondStepViewProps) {
  const isCode = mode === "code";
  const fieldId = isCode ? "second-code" : "second-recovery";
  const errorId = "second-error";
  const off = phase === "expired" || phase === "locked";
  const full = isCode ? isFullCode(value) : isFullRecovery(value);
  const sending = phase === "sending";

  return (
    <>
      <SignInTitle>One more step.</SignInTitle>
      <SignInSub>
        {isCode
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of your recovery codes."}
      </SignInSub>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!off && full && !sending) onSubmit();
        }}
      >
        <div className="mt-5 flex flex-col gap-3.5">
          <div>
            <SignInLabel htmlFor={fieldId}>{isCode ? "Code" : "Recovery code"}</SignInLabel>
            <input
              key={fieldId}
              id={fieldId}
              ref={fieldRef}
              type="text"
              value={phase === "locked" ? "" : value}
              onChange={(e) =>
                onChange(isCode ? normalizeCode(e.target.value) : normalizeRecovery(e.target.value))
              }
              inputMode={isCode ? "numeric" : "text"}
              pattern={isCode ? "[0-9]*" : undefined}
              autoComplete={isCode ? "one-time-code" : "off"}
              autoCapitalize={isCode ? undefined : "characters"}
              autoCorrect="off"
              spellCheck={false}
              placeholder={isCode ? undefined : "XXXX-XXXX-XXXX-XXXX"}
              disabled={off}
              readOnly={sending}
              aria-invalid={phase === "wrong" ? true : undefined}
              aria-describedby={message ? errorId : undefined}
              className={cn(signInInput, isCode ? signInCode : signInRecovery)}
            />
          </div>
        </div>

        {message && <SignInError id={errorId}>{message}</SignInError>}

        {phase === "expired" ? (
          <SignInButton ref={backRef} type="button" onClick={onBack}>
            Back to sign in
          </SignInButton>
        ) : (
          <SignInButton disabled={off || !full || sending}>
            {sending ? "Checking…" : "Continue"}
          </SignInButton>
        )}
      </form>

      {phase !== "expired" && (
        <SignInAlt>
          <SignInLinkButton onClick={onSwitch}>
            {isCode ? "Use a recovery code instead" : "Use the app code instead"}
          </SignInLinkButton>
        </SignInAlt>
      )}

      <SignInFoot>
        {email}
        {phase !== "expired" && (
          <>
            {" · "}
            <SignInLinkButton muted onClick={onBack}>
              Back to sign in
            </SignInLinkButton>
          </>
        )}
      </SignInFoot>
    </>
  );
}

export function SecondStep({
  email,
  challenge,
  onBack,
}: {
  email: string;
  challenge: string;
  onBack: () => void;
}) {
  const router = useRouter();
  const fieldRef = React.useRef<HTMLInputElement>(null);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const sendingRef = React.useRef(false);
  const [mode, setMode] = React.useState<SecondMode>("code");
  const [value, setValue] = React.useState("");
  const [phase, setPhase] = React.useState<SecondPhase>("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  // The field on arrival and after a switch; Back to sign in once expired.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the mode changes
  React.useEffect(() => {
    fieldRef.current?.focus();
  }, [mode]);
  React.useEffect(() => {
    if (phase === "expired") backRef.current?.focus();
    if (phase === "wrong") fieldRef.current?.focus();
  }, [phase]);

  async function send(typed: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPhase("sending");
    setMessage(null);
    const out = await sendSecondStep(challenge, mode, typed);
    sendingRef.current = false;
    if (out.ok) {
      setSession({ token: out.data.token, user: out.data.user });
      if (typeof out.data.recovery_codes_left === "number") {
        stashRecoveryNotice(out.data.recovery_codes_left);
      }
      router.replace(homeFor(out.data.user));
      return;
    }
    const next = phaseFor(out.kind);
    setPhase(next);
    setMessage(out.message);
    // After a wrong code the field empties and keeps focus.
    if (next === "wrong") setValue("");
  }

  function change(v: string) {
    setValue(v);
    if (phase === "wrong" || phase === "error") {
      setPhase("idle");
      setMessage(null);
    }
    // The sixth digit sends (mock §11, call 2).
    if (mode === "code" && isFullCode(v) && phase !== "sending") void send(v);
  }

  return (
    <SecondStepView
      email={email}
      mode={mode}
      value={value}
      phase={phase}
      message={message}
      onChange={change}
      onSubmit={() => void send(value)}
      onSwitch={() => {
        setMode((m) => (m === "code" ? "recovery" : "code"));
        setValue("");
        if (phase !== "locked") {
          setPhase("idle");
          setMessage(null);
        }
      }}
      onBack={onBack}
      fieldRef={fieldRef}
      backRef={backRef}
    />
  );
}
