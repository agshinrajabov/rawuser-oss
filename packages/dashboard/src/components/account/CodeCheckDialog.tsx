"use client";

/**
 * Turn off, and New recovery codes (two-step mock §03, foot): both ask for
 * the password and a code (from the app, or a recovery code), and both end
 * the other sessions. New codes then shows the codes once, as Turn on's
 * step 4, under "Your new recovery codes".
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
import { type Failure, endSession, newRecoveryCodes, turnOff } from "@/lib/mfa";
import { cn } from "@/lib/utils";
import * as React from "react";
import { DialogX, badField, dialogDesc, dialogTitle, fieldLabel } from "./TurnOnDialog";
import { BlockError, CodesBlock, FieldError, SavedCheck, dialogCodeInput } from "./TwoStepParts";

export type CheckMode = "off" | "codes";

export type CheckState = {
  password: string;
  code: string;
  busy: boolean;
  passwordError: string | null;
  codeError: string | null;
  blockError: string | null;
  /** New codes, once made. */
  codes: string[] | null;
  saved: boolean;
};

export const CHECK_START: CheckState = {
  password: "",
  code: "",
  busy: false,
  passwordError: null,
  codeError: null,
  blockError: null,
  codes: null,
  saved: false,
};

/** A refusal, into the dialog's state. */
export function checkFailed(s: CheckState, kind: Failure, message: string): CheckState {
  const base = { ...s, busy: false };
  if (kind === "wrong-password") return { ...base, password: "", passwordError: message };
  if (kind === "wrong-code") return { ...base, codeError: message };
  return { ...base, blockError: message };
}

const WORDS = {
  off: {
    title: "Turn off two-step sign-in?",
    desc: "Your password alone will sign you in.",
    action: "Turn off",
  },
  codes: {
    title: "New recovery codes",
    desc: "Your old codes stop working.",
    action: "Make new codes",
  },
} as const;

export type CheckBodyProps = {
  mode: CheckMode;
  state: CheckState;
  email: string;
  madeAt: number;
  onPassword: (v: string) => void;
  onCode: (v: string) => void;
  onSubmit: () => void;
  onSaved: (v: boolean) => void;
  onDone: () => void;
  passwordRef?: React.Ref<HTMLInputElement>;
  codeRef?: React.Ref<HTMLInputElement>;
  headingRef?: React.Ref<HTMLHeadingElement>;
};

export function CodeCheckBody({
  mode,
  state: s,
  email,
  madeAt,
  onPassword,
  onCode,
  onSubmit,
  onSaved,
  onDone,
  passwordRef,
  codeRef,
  headingRef,
}: CheckBodyProps) {
  if (s.codes) {
    return (
      <>
        {s.saved && <DialogX />}
        <DialogTitle
          ref={headingRef}
          tabIndex={-1}
          className={cn(dialogTitle, "focus:outline-none")}
        >
          Your new recovery codes
        </DialogTitle>
        <DialogDescription className={dialogDesc}>Other devices were signed out.</DialogDescription>
        <p className="mt-4 text-[12.5px] text-fg-muted">
          Use one if you lose your phone. They show only now.
        </p>
        <CodesBlock codes={s.codes} email={email} madeAt={madeAt} />
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

  const w = WORDS[mode];
  const ready = s.password !== "" && s.code.trim() !== "" && !s.busy;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <DialogX />
      <DialogTitle className={dialogTitle}>{w.title}</DialogTitle>
      <DialogDescription className={dialogDesc}>{w.desc}</DialogDescription>
      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label htmlFor={`${mode}-password`} className={fieldLabel}>
            Password
          </label>
          <Input
            id={`${mode}-password`}
            ref={passwordRef}
            type="password"
            autoComplete="current-password"
            value={s.password}
            onChange={(e) => onPassword(e.target.value)}
            aria-invalid={s.passwordError ? true : undefined}
            aria-describedby={s.passwordError ? `${mode}-password-error` : undefined}
            className={cn(s.passwordError && badField)}
          />
          {s.passwordError && (
            <FieldError id={`${mode}-password-error`}>{s.passwordError}</FieldError>
          )}
        </div>
        <div>
          <label htmlFor={`${mode}-code`} className={fieldLabel}>
            Code
          </label>
          <Input
            id={`${mode}-code`}
            ref={codeRef}
            type="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            value={s.code}
            onChange={(e) => onCode(e.target.value.toUpperCase())}
            aria-invalid={s.codeError ? true : undefined}
            aria-describedby={[s.codeError ? `${mode}-code-error` : "", `${mode}-code-hint`]
              .filter(Boolean)
              .join(" ")}
            className={cn(dialogCodeInput, s.codeError && badField)}
          />
          {s.codeError && <FieldError id={`${mode}-code-error`}>{s.codeError}</FieldError>}
          <p id={`${mode}-code-hint`} className="mt-1.5 text-xs text-fg-muted">
            From your app, or a recovery code.
          </p>
        </div>
      </div>
      {s.blockError && <BlockError>{s.blockError}</BlockError>}
      <div className="mt-5 flex">
        <div className="ml-auto flex w-full gap-2 sm:w-auto">
          <DialogClose asChild>
            <Button type="button" variant="ghost" className="flex-1 sm:flex-none">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            variant={mode === "off" ? "destructive" : "default"}
            className="flex-1 sm:flex-none"
            disabled={!ready}
          >
            {w.action}
          </Button>
        </div>
      </div>
    </form>
  );
}

function CheckContent({
  mode,
  email,
  onChanged,
  onClose,
}: {
  mode: CheckMode;
  email: string;
  /** After the server said yes: "off" closes at once, "codes" after Done. */
  onChanged: (mode: CheckMode) => void;
  onClose: () => void;
}) {
  const [s, set] = React.useState<CheckState>(CHECK_START);
  const [madeAt, setMadeAt] = React.useState(0);
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const closable = s.codes === null || s.saved;

  React.useEffect(() => {
    if (s.passwordError) passwordRef.current?.focus();
    else if (s.codeError) codeRef.current?.focus();
  }, [s.passwordError, s.codeError]);
  const hasCodes = s.codes !== null;
  React.useEffect(() => {
    if (hasCodes) headingRef.current?.focus();
  }, [hasCodes]);

  async function submit() {
    set((p) => ({ ...p, busy: true, passwordError: null, codeError: null, blockError: null }));
    const out =
      mode === "off"
        ? await turnOff(s.password, s.code)
        : await newRecoveryCodes(s.password, s.code);
    if (!out.ok) {
      if (out.kind === "session") return endSession();
      set((p) => checkFailed(p, out.kind, out.message));
      return;
    }
    onChanged(mode);
    if (mode === "off") return onClose();
    const codes = (out.data as { recovery_codes?: string[] }).recovery_codes ?? [];
    setMadeAt(Date.now());
    set((p) => ({ ...p, busy: false, password: "", code: "", codes }));
  }

  return (
    <DialogContent
      hideClose
      aria-describedby={undefined}
      className="max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[448px] overflow-y-auto"
      onOpenAutoFocus={(e) => {
        // The portal mounts after the first effects: focus the password here.
        e.preventDefault();
        passwordRef.current?.focus();
      }}
      onEscapeKeyDown={(e) => {
        if (!closable) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (!closable) e.preventDefault();
      }}
    >
      <CodeCheckBody
        mode={mode}
        state={s}
        email={email}
        madeAt={madeAt}
        onPassword={(v) => set((p) => ({ ...p, password: v, passwordError: null }))}
        onCode={(v) => set((p) => ({ ...p, code: v, codeError: null }))}
        onSubmit={() => void submit()}
        onSaved={(v) => set((p) => ({ ...p, saved: v }))}
        onDone={onClose}
        passwordRef={passwordRef}
        codeRef={codeRef}
        headingRef={headingRef}
      />
    </DialogContent>
  );
}

export function CodeCheckDialog({
  mode,
  open,
  onOpenChange,
  email,
  onChanged,
}: {
  mode: CheckMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  onChanged: (mode: CheckMode) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <CheckContent
          mode={mode}
          email={email}
          onChanged={onChanged}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}
