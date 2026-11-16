/**
 * The four steps of Turn on (two-step mock §04 and §05): password, scan,
 * code, recovery codes. One reducer for the dialog on Account and for the
 * required set-up page at /login/two-step, so both behave alike and every
 * state is testable without a browser.
 */

import { type Failure, START_AGAIN, normalizeCode } from "./mfa";

export type TurnOnStep = 1 | 2 | 3 | 4;

export type TurnOnState = {
  step: TurnOnStep;
  busy: boolean;
  password: string;
  code: string;
  secret: string | null;
  uri: string | null;
  codes: string[] | null;
  saved: boolean;
  /** Under the field: a wrong password or a wrong code. */
  fieldError: string | null;
  /** Under the step, red with an icon: locked, expired, a server sentence. */
  blockError: string | null;
  /** What stops the step: the set-up expired, the account locked, the session ended. */
  stop: "expired" | "locked" | "session" | null;
};

export const TURN_ON_START: TurnOnState = {
  step: 1,
  busy: false,
  password: "",
  code: "",
  secret: null,
  uri: null,
  codes: null,
  saved: false,
  fieldError: null,
  blockError: null,
  stop: null,
};

export type TurnOnAction =
  | { type: "password"; value: string }
  | { type: "code"; value: string }
  | { type: "send" }
  | { type: "started"; secret: string; uri: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "confirmed"; codes: string[] }
  | { type: "failed"; kind: Failure; message: string }
  | { type: "saved"; value: boolean }
  | { type: "restart" };

export function turnOnReducer(s: TurnOnState, a: TurnOnAction): TurnOnState {
  switch (a.type) {
    case "password":
      return { ...s, password: a.value, fieldError: null };
    case "code":
      return { ...s, code: normalizeCode(a.value), fieldError: null };
    case "send":
      return { ...s, busy: true, fieldError: null, blockError: null };
    case "started":
      return { ...s, busy: false, step: 2, password: "", secret: a.secret, uri: a.uri };
    case "next":
      return s.step === 2 ? { ...s, step: 3, code: "" } : s;
    case "back":
      if (s.step === 2) return { ...TURN_ON_START };
      if (s.step === 3) return { ...s, step: 2, code: "", fieldError: null, blockError: null };
      return s;
    case "confirmed":
      return { ...s, busy: false, step: 4, code: "", codes: a.codes, saved: false };
    case "failed":
      return failed(s, a.kind, a.message);
    case "saved":
      return { ...s, saved: a.value };
    case "restart":
      return { ...TURN_ON_START };
  }
}

function failed(s: TurnOnState, kind: Failure, message: string): TurnOnState {
  const base = { ...s, busy: false };
  switch (kind) {
    case "wrong-password":
      return { ...base, password: "", fieldError: message };
    case "wrong-code":
      return { ...base, code: "", fieldError: message };
    case "expired":
      return { ...base, stop: "expired", blockError: START_AGAIN };
    case "locked":
      return { ...base, stop: "locked", blockError: message };
    case "session":
      return { ...base, stop: "session", blockError: message };
    default:
      return { ...base, blockError: message };
  }
}

/** Step 4 cannot close until "I saved them" is ticked (mock §11, call 6). */
export function canClose(s: TurnOnState): boolean {
  return s.step !== 4 || s.saved;
}

/** The primary button's state on steps 1 and 3. */
export function canSend(s: TurnOnState): boolean {
  if (s.busy || s.stop) return false;
  if (s.step === 1) return s.password.length > 0;
  if (s.step === 3) return s.code.length === 6;
  return false;
}

export const STEP_NAMES: Record<TurnOnStep, string> = {
  1: "Password",
  2: "Scan",
  3: "Code",
  4: "Codes",
};
