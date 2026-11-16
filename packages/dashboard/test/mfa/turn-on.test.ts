/**
 * Turn on's four steps as a reducer (lib/turn-on.ts), shared by the dialog
 * on Account and the required set-up page (two-step mock §04, §05), and the
 * small helpers the screens use (lib/mfa.ts).
 */
import { describe, expect, it } from "vitest";
import {
  CODES_FILE_NAME,
  codesFileText,
  isFullCode,
  isFullRecovery,
  keyLines,
  normalizeCode,
  normalizeRecovery,
  recoveryNotice,
  recoveryTone,
  resetDoneLine,
  shortDate,
  signOutQuestion,
  signedOutLine,
} from "../../src/lib/mfa";
import {
  TURN_ON_START,
  type TurnOnAction,
  type TurnOnState,
  canClose,
  canSend,
  turnOnReducer,
} from "../../src/lib/turn-on";

function run(...actions: TurnOnAction[]): TurnOnState {
  return actions.reduce(turnOnReducer, TURN_ON_START);
}

const STARTED: TurnOnAction = { type: "started", secret: "MEVXRVCQ", uri: "otpauth://x" };
const CODES = ["HQ8D-5HFR-SWVK-182V", "YZ04-SXWF-6E99-6X52"];

describe("Turn on, the steps", () => {
  it("password, scan, code, codes", () => {
    let s = run({ type: "password", value: "pw" });
    expect(s.step).toBe(1);
    expect(canSend(s)).toBe(true);
    s = turnOnReducer(s, { type: "send" });
    expect(s.busy).toBe(true);
    expect(canSend(s)).toBe(false);
    s = turnOnReducer(s, STARTED);
    expect(s).toMatchObject({ step: 2, busy: false, password: "", secret: "MEVXRVCQ" });
    s = turnOnReducer(s, { type: "next" });
    expect(s.step).toBe(3);
    s = turnOnReducer(s, { type: "code", value: "48 29 13" });
    expect(s.code).toBe("482913");
    expect(canSend(s)).toBe(true);
    s = turnOnReducer(s, { type: "confirmed", codes: CODES });
    expect(s).toMatchObject({ step: 4, codes: CODES, saved: false });
  });

  it("step 1 needs a password; step 3 needs six digits", () => {
    expect(canSend(TURN_ON_START)).toBe(false);
    const s3 = run({ type: "password", value: "pw" }, STARTED, { type: "next" });
    expect(canSend(turnOnReducer(s3, { type: "code", value: "4821" }))).toBe(false);
  });

  it("Back on step 3 goes to the scan; on step 2 to the password", () => {
    const s3 = run({ type: "password", value: "pw" }, STARTED, { type: "next" });
    const s2 = turnOnReducer(s3, { type: "back" });
    expect(s2.step).toBe(2);
    expect(s2.secret).toBe("MEVXRVCQ");
    expect(turnOnReducer(s2, { type: "back" })).toEqual(TURN_ON_START);
  });

  it("step 4 cannot close until I saved them is ticked", () => {
    const s4 = run(
      { type: "password", value: "pw" },
      STARTED,
      { type: "next" },
      {
        type: "confirmed",
        codes: CODES,
      },
    );
    expect(canClose(TURN_ON_START)).toBe(true);
    expect(canClose(s4)).toBe(false);
    expect(canClose(turnOnReducer(s4, { type: "saved", value: true }))).toBe(true);
    expect(canClose(turnOnReducer(s4, { type: "saved", value: false }))).toBe(false);
  });
});

describe("Turn on, the errors (mock §04, E to H)", () => {
  it("E: a wrong password empties the field and shows under it", () => {
    const s = run(
      { type: "password", value: "pw" },
      { type: "send" },
      { type: "failed", kind: "wrong-password", message: "That password is not right." },
    );
    expect(s).toMatchObject({
      step: 1,
      password: "",
      busy: false,
      fieldError: "That password is not right.",
      blockError: null,
    });
    // Typing again clears it.
    expect(turnOnReducer(s, { type: "password", value: "p" }).fieldError).toBeNull();
  });

  it("F: a wrong code empties the field and stays on step 3", () => {
    const s = run(
      { type: "password", value: "pw" },
      STARTED,
      { type: "next" },
      { type: "code", value: "000000" },
      { type: "send" },
      { type: "failed", kind: "wrong-code", message: "That code did not work. Try again." },
    );
    expect(s).toMatchObject({
      step: 3,
      code: "",
      fieldError: "That code did not work. Try again.",
    });
  });

  it("G: an expired set-up stops the step; Start again goes back to step 1", () => {
    const s = run(
      { type: "password", value: "pw" },
      STARTED,
      { type: "next" },
      { type: "failed", kind: "expired", message: "Start setting up two-step sign-in again." },
    );
    expect(s).toMatchObject({
      step: 3,
      stop: "expired",
      blockError: "Start setting up two-step sign-in again.",
    });
    expect(canSend({ ...s, code: "482913" })).toBe(false);
    expect(turnOnReducer(s, { type: "restart" })).toEqual(TURN_ON_START);
  });

  it("H: locked keeps the server's sentence and stops sending", () => {
    const s = run(
      { type: "password", value: "pw" },
      {
        type: "failed",
        kind: "locked",
        message: "Too many failed sign-ins. Try again in 15 minutes.",
      },
    );
    expect(s).toMatchObject({
      stop: "locked",
      blockError: "Too many failed sign-ins. Try again in 15 minutes.",
    });
    expect(canSend(s)).toBe(false);
  });

  it("the set-up session ended: Sign in again", () => {
    const s = run(
      { type: "password", value: "pw" },
      {
        type: "failed",
        kind: "session",
        message: "Sign in again.",
      },
    );
    expect(s).toMatchObject({ stop: "session", blockError: "Sign in again." });
  });

  it("any other refusal shows the server's sentence and lets the person try again", () => {
    const s = run(
      { type: "password", value: "pw" },
      {
        type: "failed",
        kind: "error",
        message: "Two-step sign-in is already on.",
      },
    );
    expect(s).toMatchObject({ stop: null, blockError: "Two-step sign-in is already on." });
    expect(canSend(s)).toBe(true);
  });
});

describe("fields", () => {
  it("one code field: digits only, six at most, a pasted '482 913' works", () => {
    expect(normalizeCode("482 913")).toBe("482913");
    expect(normalizeCode("48-29-13-77")).toBe("482913");
    expect(normalizeCode("abc")).toBe("");
    expect(isFullCode("482913")).toBe(true);
    expect(isFullCode("48291")).toBe(false);
  });

  it("recovery codes: upper case, Continue at 16 letters or digits", () => {
    expect(normalizeRecovery("hq8d-5hfr swvk_182v")).toBe("HQ8D-5HFR SWVK182V");
    expect(isFullRecovery("HQ8D-5HFR-SWVK-182")).toBe(false);
    expect(isFullRecovery("HQ8D-5HFR-SWVK-182V")).toBe(true);
    expect(isFullRecovery("hq8d5hfrswvk182v")).toBe(true);
  });

  it("the key reads in groups of four, two lines for a 32-character secret", () => {
    expect(keyLines("MEVXRVCQURTAEBOG65YQ37I7LATJPUU5")).toEqual([
      "MEVX RVCQ URTA EBOG",
      "65YQ 37I7 LATJ PUU5",
    ]);
  });
});

describe("words", () => {
  it("sessions, with and without a count", () => {
    expect(signOutQuestion(2)).toBe("Sign out 2 other sessions?");
    expect(signOutQuestion(1)).toBe("Sign out 1 other session?");
    expect(signOutQuestion(null)).toBe("Sign out every other session?");
    expect(signedOutLine(2)).toBe("Signed out 2 other sessions.");
    expect(signedOutLine(1)).toBe("Signed out 1 other session.");
    expect(signedOutLine(0)).toBe("No other sessions were signed in.");
    expect(resetDoneLine(1)).toBe("Reset. 1 session ended.");
    expect(resetDoneLine(3)).toBe("Reset. 3 sessions ended.");
  });

  it("recovery codes turn amber at 2 left (call 7)", () => {
    expect(recoveryTone(10)).toBe("plain");
    expect(recoveryTone(3)).toBe("plain");
    expect(recoveryTone(2)).toBe("warn");
    expect(recoveryNotice(7)).toEqual({
      text: "You signed in with a recovery code. 7 left.",
      link: "New recovery codes",
      tone: "plain",
    });
    expect(recoveryNotice(1).tone).toBe("warn");
    expect(recoveryNotice(0)).toEqual({
      text: "That was your last recovery code.",
      link: "Make new codes",
      tone: "warn",
    });
  });

  it("the Download file", () => {
    const at = new Date(2026, 9, 6, 12).getTime();
    expect(shortDate(at)).toBe("6 Oct 2026");
    expect(CODES_FILE_NAME).toBe("rawuser-recovery-codes.txt");
    expect(codesFileText("sam@brisk.test", CODES, at)).toBe(
      "Rawuser recovery codes for sam@brisk.test, made 6 Oct 2026. Each works once.\n\nHQ8D-5HFR-SWVK-182V\nYZ04-SXWF-6E99-6X52\n",
    );
  });
});
