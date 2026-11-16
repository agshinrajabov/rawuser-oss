"use client";

import { confirmEnrolment, isFullCode, startEnrolment } from "@/lib/mfa";
import { TURN_ON_START, type TurnOnState, turnOnReducer } from "@/lib/turn-on";
import * as React from "react";

export type TurnOn = {
  state: TurnOnState;
  /** When the codes were made, for the Download file. */
  madeAt: number;
  setPassword: (v: string) => void;
  /** Sends itself at the sixth digit. */
  setCode: (v: string) => void;
  sendPassword: () => void;
  sendCode: () => void;
  next: () => void;
  back: () => void;
  setSaved: (v: boolean) => void;
  restart: () => void;
};

/**
 * The four steps' calls. `confirmEnrolment` stores the answer's token in
 * place of the old one before the codes show (lib/mfa.ts).
 */
export function useTurnOn(): TurnOn {
  const [state, dispatch] = React.useReducer(turnOnReducer, TURN_ON_START);
  const busy = React.useRef(false);
  const [madeAt, setMadeAt] = React.useState(0);

  const sendPassword = React.useCallback(async (password: string) => {
    if (busy.current || password === "") return;
    busy.current = true;
    dispatch({ type: "send" });
    const out = await startEnrolment(password);
    busy.current = false;
    if (out.ok) dispatch({ type: "started", secret: out.data.secret, uri: out.data.otpauth_uri });
    else dispatch({ type: "failed", kind: out.kind, message: out.message });
  }, []);

  const sendCode = React.useCallback(async (code: string) => {
    if (busy.current || !isFullCode(code)) return;
    busy.current = true;
    dispatch({ type: "send" });
    const out = await confirmEnrolment(code);
    busy.current = false;
    if (out.ok) {
      setMadeAt(Date.now());
      dispatch({ type: "confirmed", codes: out.data.recovery_codes });
    } else {
      dispatch({ type: "failed", kind: out.kind, message: out.message });
    }
  }, []);

  return {
    state,
    madeAt,
    setPassword: (v) => dispatch({ type: "password", value: v }),
    setCode: (v) => {
      dispatch({ type: "code", value: v });
      const digits = v.replace(/\D/g, "").slice(0, 6);
      if (isFullCode(digits) && !state.stop) void sendCode(digits);
    },
    sendPassword: () => void sendPassword(state.password),
    sendCode: () => void sendCode(state.code),
    next: () => dispatch({ type: "next" }),
    back: () => dispatch({ type: "back" }),
    setSaved: (v) => dispatch({ type: "saved", value: v }),
    restart: () => dispatch({ type: "restart" }),
  };
}
