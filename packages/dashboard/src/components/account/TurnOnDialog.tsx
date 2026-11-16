"use client";

/**
 * Turn on two-step sign-in: four steps in one dialog (two-step mock §04).
 * Password, scan, code, recovery codes. Step 4 has no close, no Esc and no
 * click outside until "I saved them" is ticked (call 6): two-step is
 * already on there, so a lost dialog would mean lost codes.
 */

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { type TurnOnState, canClose, canSend } from "@/lib/turn-on";
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";
import * as React from "react";
import {
  BlockError,
  CodesBlock,
  FieldError,
  KeyBlock,
  OK_TEXT,
  OK_TINT,
  QrCode,
  SavedCheck,
  StepBar,
  dialogCodeInput,
} from "./TwoStepParts";
import { useTurnOn } from "./useTurnOn";

export function DialogX() {
  return (
    <DialogClose className="absolute right-4 top-[18px] rounded-sm text-fg-faint transition-colors duration-fast hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]">
      <X size={16} />
      <span className="sr-only">Close</span>
    </DialogClose>
  );
}

export const dialogTitle = "pr-7 text-[15px] font-semibold tracking-[-0.005em]";
export const dialogDesc = "mt-1 text-[13.5px] leading-normal text-fg-muted";
export const fieldLabel = "mb-1.5 block text-[12.5px] font-medium text-fg";
export const badField = "border-[var(--state-err)]";

export type TurnOnRefs = {
  password?: React.Ref<HTMLInputElement>;
  code?: React.Ref<HTMLInputElement>;
  next?: React.Ref<HTMLButtonElement>;
  heading?: React.Ref<HTMLHeadingElement>;
  restart?: React.Ref<HTMLButtonElement>;
};

export type TurnOnBodyProps = {
  state: TurnOnState;
  email: string;
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
  refs?: TurnOnRefs;
};

/** The dialog's inside, without Radix's portal: rendered alone by the tests. */
export function TurnOnBody({
  state: s,
  email,
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
  refs = {},
}: TurnOnBodyProps) {
  const send = canSend(s);
  const expired = s.stop === "expired";

  if (s.step === 4) {
    return (
      <>
        {canClose(s) && <DialogX />}
        <StepBar step={4} className="mb-4 mr-7" />
        <DialogTitle
          ref={refs.heading}
          tabIndex={-1}
          className={cn(dialogTitle, "flex items-center gap-2 focus:outline-none")}
        >
          <span
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
              OK_TINT,
              OK_TEXT,
            )}
            aria-hidden
          >
            <Check size={12} />
          </span>
          Two-step sign-in is on
        </DialogTitle>
        <DialogDescription className={dialogDesc}>Other devices were signed out.</DialogDescription>
        <p className="mt-5 border-t border-border pt-4 text-[13.5px] font-semibold">
          Recovery codes
        </p>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">
          Use one if you lose your phone. They show only now.
        </p>
        <CodesBlock codes={s.codes ?? []} email={email} madeAt={madeAt} />
        <SavedCheck checked={s.saved} onChange={onSaved} />
        <div className="mt-5 flex">
          <Button
            type="button"
            className="w-full sm:ml-auto sm:w-auto"
            disabled={!s.saved}
            onClick={onDone}
          >
            Done
          </Button>
        </div>
      </>
    );
  }

  const titles = {
    1: ["Turn on two-step sign-in", "First, your password."],
    2: ["Scan this code", "Use your authenticator app."],
    3: ["Enter the code", "The 6-digit code your app shows now."],
  } as const;
  const [title, desc] = titles[s.step];

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (s.step === 1 && send) onSendPassword();
        else if (s.step === 2) onNext();
        else if (s.step === 3 && send) onSendCode();
      }}
    >
      <DialogX />
      <StepBar step={s.step} className="mb-4 mr-7" />
      <DialogTitle className={dialogTitle}>{title}</DialogTitle>
      <DialogDescription className={dialogDesc}>{desc}</DialogDescription>

      {s.step === 1 && (
        <div className="mt-4">
          <label htmlFor="turn-on-password" className={fieldLabel}>
            Password
          </label>
          <Input
            id="turn-on-password"
            ref={refs.password}
            type="password"
            autoComplete="current-password"
            value={s.password}
            onChange={(e) => onPassword(e.target.value)}
            disabled={s.stop === "locked"}
            aria-invalid={s.fieldError ? true : undefined}
            aria-describedby={s.fieldError ? "turn-on-password-error" : undefined}
            className={cn(s.fieldError && badField)}
          />
          {s.fieldError && <FieldError id="turn-on-password-error">{s.fieldError}</FieldError>}
        </div>
      )}

      {s.step === 2 && s.secret && s.uri && (
        <div className="mt-4 grid grid-cols-1 items-center justify-items-center gap-5 sm:grid-cols-[168px_minmax(0,1fr)] sm:justify-items-start">
          <QrCode uri={s.uri} />
          <KeyBlock secret={s.secret} lead="Can't scan? Type this key." center />
        </div>
      )}

      {s.step === 3 && !expired && (
        <div className="mt-4">
          <label htmlFor="turn-on-code" className={fieldLabel}>
            Code
          </label>
          <Input
            id="turn-on-code"
            ref={refs.code}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            spellCheck={false}
            value={s.code}
            onChange={(e) => onCode(e.target.value)}
            readOnly={s.busy}
            disabled={s.stop === "locked" || s.stop === "session"}
            aria-invalid={s.fieldError ? true : undefined}
            aria-describedby={s.fieldError ? "turn-on-code-error" : undefined}
            className={cn(dialogCodeInput, s.fieldError && badField)}
          />
          {s.fieldError && <FieldError id="turn-on-code-error">{s.fieldError}</FieldError>}
        </div>
      )}

      {s.blockError && <BlockError>{s.blockError}</BlockError>}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        {expired ? (
          <div className="ml-auto flex w-full gap-2 sm:w-auto">
            <DialogClose asChild>
              <Button type="button" variant="ghost" className="flex-1 sm:flex-none">
                Cancel
              </Button>
            </DialogClose>
            <Button
              ref={refs.restart}
              type="button"
              className="flex-1 sm:flex-none"
              onClick={onRestart}
            >
              Start again
            </Button>
          </div>
        ) : s.step === 1 ? (
          <div className="ml-auto flex w-full gap-2 sm:w-auto">
            <DialogClose asChild>
              <Button type="button" variant="ghost" className="flex-1 sm:flex-none">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className="flex-1 sm:flex-none" disabled={!send}>
              Continue
            </Button>
          </div>
        ) : (
          <div className="flex w-full gap-2 sm:contents">
            <Button type="button" variant="ghost" className="flex-1 sm:flex-none" onClick={onBack}>
              Back
            </Button>
            <Button
              ref={s.step === 2 ? refs.next : undefined}
              type="submit"
              className="flex-1 sm:ml-auto sm:flex-none"
              disabled={s.step === 3 && !send}
            >
              {s.step === 2 ? "Next" : "Turn on"}
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}

export type StepRefs = {
  password: React.RefObject<HTMLInputElement | null>;
  code: React.RefObject<HTMLInputElement | null>;
  next: React.RefObject<HTMLButtonElement | null>;
  heading: React.RefObject<HTMLHeadingElement | null>;
  restart: React.RefObject<HTMLButtonElement | null>;
};

export function useStepRefs(): StepRefs {
  return {
    password: React.useRef<HTMLInputElement>(null),
    code: React.useRef<HTMLInputElement>(null),
    next: React.useRef<HTMLButtonElement>(null),
    heading: React.useRef<HTMLHeadingElement>(null),
    restart: React.useRef<HTMLButtonElement>(null),
  };
}

/**
 * Where focus goes on each step (mock §08): the field on steps 1 and 3,
 * Next on step 2, the heading on step 4, Start again once expired. A
 * wrong password or code keeps focus in its emptied field.
 */
export function useStepFocus(s: TurnOnState, refs: StepRefs) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; a new error refocuses
  React.useEffect(() => {
    if (s.stop === "expired") refs.restart.current?.focus();
    else if (s.step === 1) refs.password.current?.focus();
    else if (s.step === 2) refs.next.current?.focus();
    else if (s.step === 3) refs.code.current?.focus();
    else refs.heading.current?.focus();
  }, [s.step, s.stop, s.fieldError]);
}

function TurnOnContent({
  email,
  onEnabled,
  onClose,
}: {
  email: string;
  onEnabled: () => void;
  onClose: () => void;
}) {
  const t = useTurnOn();
  const refs = useStepRefs();
  useStepFocus(t.state, refs);
  const closable = canClose(t.state);

  // Two-step is on from step 4: the page behind updates at once.
  const step4 = t.state.step === 4;
  const enabled = React.useRef(onEnabled);
  enabled.current = onEnabled;
  React.useEffect(() => {
    if (step4) enabled.current();
  }, [step4]);

  return (
    <DialogContent
      hideClose
      aria-describedby={undefined}
      className="max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[448px] overflow-y-auto"
      onOpenAutoFocus={(e) => {
        // The portal mounts after the first effects: focus the field here.
        e.preventDefault();
        refs.password.current?.focus();
      }}
      onEscapeKeyDown={(e) => {
        if (!closable) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (!closable) e.preventDefault();
      }}
    >
      <TurnOnBody
        state={t.state}
        email={email}
        madeAt={t.madeAt}
        onPassword={t.setPassword}
        onCode={t.setCode}
        onSendPassword={t.sendPassword}
        onSendCode={t.sendCode}
        onNext={t.next}
        onBack={t.back}
        onSaved={t.setSaved}
        onRestart={t.restart}
        onDone={onClose}
        refs={refs}
      />
    </DialogContent>
  );
}

export function TurnOnDialog({
  open,
  onOpenChange,
  email,
  onEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  onEnabled: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <TurnOnContent email={email} onEnabled={onEnabled} onClose={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}
