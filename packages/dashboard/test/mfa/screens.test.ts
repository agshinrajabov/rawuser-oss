/**
 * Every state of the two-step screens (mock
 * design/mock/sales-readiness/two-step-sign-in.html, approved 2026-10-06),
 * rendered to markup: the second step (§01), Account (§03), the Turn on
 * dialog (§04), Turn off and New codes (§03 foot), the required set-up
 * (§05), the users list and the reset (§06), the recovery line (§07) and
 * the account menu (§03, call 4).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccountSignInView,
  OTHERS_START,
  TURNED_OFF_LINE,
} from "../../src/components/account/AccountSignIn";
import {
  CHECK_START,
  CodeCheckBody,
  checkFailed,
} from "../../src/components/account/CodeCheckDialog";
import { TurnOnBody } from "../../src/components/account/TurnOnDialog";
import { RequiredSetupView } from "../../src/components/auth/RequiredSetup";
import { type SecondPhase, SecondStepView, phaseFor } from "../../src/components/auth/SecondStep";
import { CustomerUsersView, ResetBody } from "../../src/components/customers/CustomerUsers";
import { AccountMenuView } from "../../src/components/shell/AccountMenu";
import { NEW_CODES_HREF, RecoveryLineView } from "../../src/components/shell/RecoveryLine";
import { Dialog } from "../../src/components/ui/Dialog";
import type { MfaStatus } from "../../src/lib/mfa";
import { TURN_ON_START, type TurnOnState } from "../../src/lib/turn-on";

const noop = () => undefined;
/** The attribute, not the `disabled:` utility classes. */
const DISABLED = /\sdisabled=""/;
const EMAIL = "sam@brisk.test";
const CODES = [
  "HQ8D-5HFR-SWVK-182V",
  "YZ04-SXWF-6E99-6X52",
  "08E2-K8GV-764K-CRGE",
  "00KX-HMFY-FF1T-K31C",
  "ZT5G-EVQE-Z2NT-QSC0",
  "J4DZ-CKCE-XEGJ-6ZBE",
  "ZT39-S3D1-9T33-BSWM",
  "75AN-CBX2-KRQN-WA60",
  "5H5P-T7DR-PKV5-3YCQ",
  "WCMQ-Y1TF-S2R2-X43G",
];

/** Text only, tags dropped, whitespace folded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The open tag of the first element matching an attribute. */
function tag(html: string, attr: string): string {
  const i = html.indexOf(attr);
  if (i < 0) return "";
  return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

function buttonTag(html: string, label: string): string {
  const re = new RegExp(`<button[^>]*>(?:(?!</button>).)*?${label}`, "s");
  const m = html.match(re);
  return m ? (m[0].match(/^<button[^>]*>/)?.[0] ?? "") : "";
}

// ---------------------------------------------------------------------------
// §01 Second step
// ---------------------------------------------------------------------------

function second(
  phase: SecondPhase,
  extra: Partial<{ mode: "code" | "recovery"; value: string; message: string | null }> = {},
) {
  return renderToStaticMarkup(
    h(SecondStepView, {
      email: EMAIL,
      mode: extra.mode ?? "code",
      value: extra.value ?? "",
      phase,
      message: extra.message ?? null,
      onChange: noop,
      onSubmit: noop,
      onSwitch: noop,
      onBack: noop,
    }),
  );
}

describe("§01 second step", () => {
  it("code: one field, numeric, one-time-code, Continue off until six digits", () => {
    const html = second("idle", { value: "48" });
    expect(text(html)).toContain("One more step.");
    expect(text(html)).toContain("Enter the 6-digit code from your authenticator app.");
    const field = tag(html, 'id="second-code"');
    expect(field).toContain('autoComplete="one-time-code"');
    expect(field).toContain('inputMode="numeric"');
    expect(field).toContain('pattern="[0-9]*"');
    expect(field).not.toContain("maxLength");
    expect(buttonTag(html, "Continue")).toMatch(DISABLED);
    expect(text(html)).toContain("Use a recovery code instead");
    expect(text(html)).toContain(`${EMAIL} · Back to sign in`);
    // Exactly one input: one field, not six boxes (call 1).
    expect(html.match(/<input/g)).toHaveLength(1);
  });

  it("six digits: Continue is live; sending reads Checking…", () => {
    expect(buttonTag(second("idle", { value: "482913" }), "Continue")).not.toMatch(DISABLED);
    const sending = second("sending", { value: "482913" });
    expect(text(sending)).toContain("Checking…");
    expect(tag(sending, 'id="second-code"')).toContain("readOnly");
  });

  it("A: recovery code, its placeholder and the way back to the app code", () => {
    const html = second("idle", { mode: "recovery" });
    expect(text(html)).toContain("Enter one of your recovery codes.");
    expect(text(html)).toContain("Recovery code");
    const field = tag(html, 'id="second-recovery"');
    expect(field).toContain('placeholder="XXXX-XXXX-XXXX-XXXX"');
    expect(field).toContain('autoComplete="off"');
    expect(text(html)).toContain("Use the app code instead");
    expect(
      buttonTag(second("idle", { mode: "recovery", value: "HQ8D-5HFR-SWVK-182V" }), "Continue"),
    ).not.toContain(DISABLED);
  });

  it("B: wrong code: the sentence as an alert tied to the field", () => {
    const html = second("wrong", { message: "That code did not work. Try again." });
    expect(text(html)).toContain("That code did not work. Try again.");
    expect(tag(html, 'role="alert"')).toContain('id="second-error"');
    const field = tag(html, 'id="second-code"');
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('aria-describedby="second-error"');
    expect(field).not.toMatch(DISABLED);
  });

  it("C: step expired: the field is off, the button is Back to sign in, no switch", () => {
    const html = second("expired", { value: "482", message: "Sign in again." });
    expect(tag(html, 'id="second-code"')).toMatch(DISABLED);
    expect(tag(html, 'id="second-code"')).toContain('value="482"');
    expect(text(html)).toContain("Sign in again.");
    expect(buttonTag(html, "Back to sign in")).not.toMatch(DISABLED);
    expect(text(html)).not.toContain("Continue");
    expect(text(html)).not.toContain("Use a recovery code instead");
    expect(text(html)).toMatch(new RegExp(`${EMAIL}$`));
  });

  it("D: locked: the server's minutes, the field empty and off, Continue off", () => {
    const html = second("locked", {
      value: "482913",
      message: "Too many failed sign-ins. Try again in 14 minutes.",
    });
    expect(text(html)).toContain("Too many failed sign-ins. Try again in 14 minutes.");
    const field = tag(html, 'id="second-code"');
    expect(field).toMatch(DISABLED);
    expect(field).toContain('value=""');
    expect(buttonTag(html, "Continue")).toMatch(DISABLED);
  });

  it("refusals map to phases", () => {
    expect(phaseFor("wrong-code")).toBe("wrong");
    expect(phaseFor("expired")).toBe("expired");
    expect(phaseFor("locked")).toBe("locked");
    expect(phaseFor("error")).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// §03 Account
// ---------------------------------------------------------------------------

const OFF: MfaStatus = {
  enabled: false,
  pending: false,
  required: false,
  recovery_codes_left: 0,
  enabled_at: null,
  other_sessions: 2,
};
const ON: MfaStatus = {
  enabled: true,
  pending: false,
  required: false,
  recovery_codes_left: 10,
  enabled_at: new Date(2026, 9, 6, 12).getTime(),
  other_sessions: 0,
};

function account(status: MfaStatus, extra: Partial<Parameters<typeof AccountSignInView>[0]> = {}) {
  return renderToStaticMarkup(
    h(AccountSignInView, {
      status,
      turnedOff: false,
      others: OTHERS_START,
      onTurnOn: noop,
      onTurnOff: noop,
      onNewCodes: noop,
      onAskSignOut: noop,
      onCancelSignOut: noop,
      onSignOut: noop,
      ...extra,
    }),
  );
}

describe("§03 Account, Sign-in", () => {
  it("customer, off: Off, the line, Turn on; no recovery row; 2 signed in elsewhere", () => {
    const t = text(account(OFF));
    expect(t).toContain("Two-step sign-in Off A code from your phone at each sign-in. Turn on");
    expect(t).not.toContain("Recovery codes");
    expect(t).toContain("Other sessions 2 signed in elsewhere");
    expect(t).toContain("Sign out everywhere else");
  });

  it("superadmin, on and required: Since the date, Required, no Turn off; None and the button off", () => {
    const html = account({ ...ON, required: true });
    const t = text(html);
    expect(t).toContain("On Since 6 Oct 2026 Required for your account");
    expect(t).not.toContain("Turn off");
    expect(t).toContain("Recovery codes 10 of 10 left");
    expect(t).toContain("New recovery codes");
    expect(t).toContain("Other sessions None");
    expect(buttonTag(html, "Sign out everywhere else")).toMatch(DISABLED);
  });

  it("customer, on: Turn off; two codes left read amber; the phone's short labels exist", () => {
    const html = account({ ...ON, recovery_codes_left: 2, other_sessions: 2 });
    expect(text(html)).toContain("Turn off");
    expect(html).toMatch(/state-warn\)_62%,black\)\]"><b[^>]*>2<\/b>/);
    expect(text(html)).toContain("New codes");
    expect(account({ ...ON, recovery_codes_left: 3 })).not.toContain("state-warn)_62%");
  });

  it("A1 not deployed: no count, the line says what the button does", () => {
    const { other_sessions: _, ...older } = OFF;
    const html = account(older);
    expect(text(html)).toContain("Other sessions Ends every other session.");
    expect(buttonTag(html, "Sign out everywhere else")).not.toMatch(DISABLED);
  });

  it("the confirm: the count, the line, Cancel and Sign out; without a count it asks for all", () => {
    const t = text(account(OFF, { others: { ...OTHERS_START, confirming: true } }));
    expect(t).toContain("Sign out 2 other sessions?");
    expect(t).toContain("Those devices need your password again.");
    expect(t).toContain("Cancel Sign out");
    const { other_sessions: _, ...older } = OFF;
    expect(text(account(older, { others: { ...OTHERS_START, confirming: true } }))).toContain(
      "Sign out every other session?",
    );
  });

  it("done: the count from the answer, focusable, the button off", () => {
    const html = account(OFF, { others: { ...OTHERS_START, revoked: 2 } });
    expect(text(html)).toContain("Signed out 2 other sessions.");
    expect(tag(html, 'tabindex="-1"')).toContain("<span");
    expect(buttonTag(html, "Sign out everywhere else")).toMatch(DISABLED);
  });

  it("after Turn off: Off, with the green line under it", () => {
    expect(text(account(OFF, { turnedOff: true }))).toContain(TURNED_OFF_LINE);
  });
});

// ---------------------------------------------------------------------------
// §04 Turn on dialog
// ---------------------------------------------------------------------------

function turnOn(state: Partial<TurnOnState>) {
  return renderToStaticMarkup(
    h(
      Dialog,
      { open: true },
      h(TurnOnBody, {
        state: { ...TURN_ON_START, ...state },
        email: EMAIL,
        madeAt: 0,
        onPassword: noop,
        onCode: noop,
        onSendPassword: noop,
        onSendCode: noop,
        onNext: noop,
        onBack: noop,
        onSaved: noop,
        onRestart: noop,
        onDone: noop,
      }),
    ),
  );
}

const SCAN = {
  step: 2 as const,
  secret: "MEVXRVCQURTAEBOG65YQ37I7LATJPUU5",
  uri: "otpauth://totp/x",
};

describe("§04 Turn on", () => {
  it("A: password: Step 1 of 4, Close first, Cancel and Continue", () => {
    const html = turnOn({});
    const t = text(html);
    expect(t).toMatch(/^Close Step 1 of 4 Turn on two-step sign-in First, your password\./);
    expect(t).toContain("Password");
    expect(tag(html, 'id="turn-on-password"')).toContain('type="password"');
    expect(buttonTag(html, "Continue")).toMatch(DISABLED);
    expect(buttonTag(turnOn({ password: "x" }), "Continue")).not.toMatch(DISABLED);
    expect(t).toMatch(/Cancel Continue$/);
  });

  it("B: scan: the QR box drawn locally, the key in two lines, Copy key, Back and Next", () => {
    const html = turnOn(SCAN);
    const t = text(html);
    expect(t).toContain("Step 2 of 4 Scan this code Use your authenticator app.");
    expect(t).toContain("Can't scan? Type this key.");
    expect(t).toContain("MEVX RVCQ URTA EBOG 65YQ 37I7 LATJ PUU5");
    expect(t).toContain("Copy key");
    expect(t).toMatch(/Back Next$/);
    // No image URL, no QR service: the URI is never in the markup.
    expect(html).not.toContain("otpauth://");
    expect(html).not.toMatch(/<img/);
  });

  it("C: code: numeric, one-time-code, Turn on off until six digits", () => {
    const html = turnOn({ ...SCAN, step: 3, code: "4821" });
    expect(text(html)).toContain("Step 3 of 4 Enter the code The 6-digit code your app shows now.");
    const field = tag(html, 'id="turn-on-code"');
    expect(field).toContain('autoComplete="one-time-code"');
    expect(field).toContain('inputMode="numeric"');
    expect(buttonTag(html, "Turn on")).toMatch(DISABLED);
    expect(buttonTag(turnOn({ ...SCAN, step: 3, code: "482913" }), "Turn on")).not.toContain(
      DISABLED,
    );
  });

  it("D: codes once: no close until ticked, Copy and Download, Done off", () => {
    const html = turnOn({ ...SCAN, step: 4, codes: CODES });
    const t = text(html);
    expect(t).not.toContain("Close");
    expect(t).toContain("Step 4 of 4 Two-step sign-in is on Other devices were signed out.");
    expect(t).toContain("Recovery codes Use one if you lose your phone. They show only now.");
    for (const c of CODES) expect(t).toContain(c);
    expect(t).toContain("Copy Download I saved them");
    expect(buttonTag(html, "Done")).toMatch(DISABLED);
    expect(tag(html, 'tabindex="-1"')).toMatch(/^<h2/);
  });

  it("D, ticked: Close comes back and Done is live", () => {
    const html = turnOn({ ...SCAN, step: 4, codes: CODES, saved: true });
    expect(text(html)).toMatch(/^Close/);
    expect(buttonTag(html, "Done")).not.toMatch(DISABLED);
    expect(tag(html, 'type="checkbox"')).toContain("checked");
  });

  it("E: wrong password under the field, red, tied to it", () => {
    const html = turnOn({ fieldError: "That password is not right." });
    expect(text(html)).toContain("That password is not right.");
    const field = tag(html, 'id="turn-on-password"');
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('aria-describedby="turn-on-password-error"');
    expect(tag(html, 'id="turn-on-password-error"')).toContain('role="alert"');
  });

  it("F: wrong code, the field empty", () => {
    const html = turnOn({ ...SCAN, step: 3, fieldError: "That code did not work. Try again." });
    expect(text(html)).toContain("That code did not work. Try again.");
    expect(tag(html, 'id="turn-on-code"')).toContain('value=""');
  });

  it("G: expired: the sentence, no field, Cancel and Start again", () => {
    const html = turnOn({
      ...SCAN,
      step: 3,
      stop: "expired",
      blockError: "Start setting up two-step sign-in again.",
    });
    const t = text(html);
    expect(t).toContain("Start setting up two-step sign-in again.");
    expect(html).not.toContain('id="turn-on-code"');
    expect(t).toMatch(/Cancel Start again$/);
  });

  it("H: locked: the field off, the sentence, Continue off", () => {
    const html = turnOn({
      password: "x",
      stop: "locked",
      blockError: "Too many failed sign-ins. Try again in 15 minutes.",
    });
    expect(text(html)).toContain("Too many failed sign-ins. Try again in 15 minutes.");
    expect(tag(html, 'id="turn-on-password"')).toMatch(DISABLED);
    expect(buttonTag(html, "Continue")).toMatch(DISABLED);
  });
});

// ---------------------------------------------------------------------------
// §03 foot: Turn off and New codes
// ---------------------------------------------------------------------------

function check(mode: "off" | "codes", state: Partial<typeof CHECK_START>) {
  return renderToStaticMarkup(
    h(
      Dialog,
      { open: true },
      h(CodeCheckBody, {
        mode,
        state: { ...CHECK_START, ...state },
        email: EMAIL,
        madeAt: 0,
        onPassword: noop,
        onCode: noop,
        onSubmit: noop,
        onSaved: noop,
        onDone: noop,
      }),
    ),
  );
}

describe("§03 Turn off and New recovery codes", () => {
  it("Turn off: the question, password and code with its hint, the red button", () => {
    const html = check("off", { password: "x", code: "913204" });
    const t = text(html);
    expect(t).toContain("Turn off two-step sign-in? Your password alone will sign you in.");
    expect(t).toContain("From your app, or a recovery code.");
    expect(buttonTag(html, "Turn off")).toContain("bg-state-err");
    expect(buttonTag(html, "Turn off")).not.toMatch(DISABLED);
    expect(buttonTag(check("off", { password: "x" }), "Turn off")).toMatch(DISABLED);
  });

  it("a wrong code keeps the value and shows under the code; a wrong password empties its field", () => {
    const wrongCode = checkFailed(
      { ...CHECK_START, password: "x", code: "913204", busy: true },
      "wrong-code",
      "That code did not work. Try again.",
    );
    expect(wrongCode).toMatchObject({
      code: "913204",
      codeError: "That code did not work. Try again.",
    });
    const html = check("off", wrongCode);
    expect(tag(html, 'id="off-code"')).toContain('aria-invalid="true"');
    expect(tag(html, 'id="off-code"')).toContain('aria-describedby="off-code-error off-code-hint"');
    const wrongPw = checkFailed(CHECK_START, "wrong-password", "That password is not right.");
    expect(wrongPw).toMatchObject({ password: "", passwordError: "That password is not right." });
  });

  it("a required role: the API's sentence under the fields", () => {
    const s = checkFailed(CHECK_START, "required", "Your account must keep two-step sign-in.");
    expect(text(check("off", s))).toContain("Your account must keep two-step sign-in.");
  });

  it("New codes: the words, then the codes as step 4 under their own title", () => {
    const ask = text(check("codes", {}));
    expect(ask).toContain("New recovery codes Your old codes stop working.");
    expect(ask).toContain("Make new codes");
    const shown = check("codes", { codes: CODES });
    const t = text(shown);
    expect(t).not.toContain("Close");
    expect(t).toContain("Your new recovery codes Other devices were signed out.");
    for (const c of CODES) expect(t).toContain(c);
    expect(buttonTag(shown, "Done")).toMatch(DISABLED);
    expect(buttonTag(check("codes", { codes: CODES, saved: true }), "Done")).not.toContain(
      DISABLED,
    );
  });
});

// ---------------------------------------------------------------------------
// §05 Required set-up
// ---------------------------------------------------------------------------

function setup(state: Partial<TurnOnState>) {
  return renderToStaticMarkup(
    h(RequiredSetupView, {
      email: EMAIL,
      state: { ...TURN_ON_START, ...state },
      madeAt: 0,
      onPassword: noop,
      onCode: noop,
      onSendPassword: noop,
      onSendCode: noop,
      onNext: noop,
      onBack: noop,
      onSaved: noop,
      onRestart: noop,
      onDone: noop,
      onSignOut: noop,
    }),
  );
}

describe("§05 required set-up", () => {
  it("step 1: the why, Step 1 of 4 · Password read out, Sign out at the foot", () => {
    const html = setup({});
    const t = text(html);
    expect(t).toContain("Secure your account. Your account needs two-step sign-in.");
    expect(t).toContain("Step 1 of 4 · Password");
    expect(tag(html, 'aria-live="polite"')).toContain("<span");
    expect(tag(html, 'id="setup-password"')).toContain('placeholder="Your password again"');
    expect(t).toMatch(new RegExp(`${EMAIL} · Sign out$`));
    // No sidebar, no dashboard frame: the login's own page (call 9).
    expect(html).not.toContain("<nav");
  });

  it("step 2: the QR and the page's key line, Next, Back", () => {
    const t = text(setup(SCAN));
    expect(t).toContain("Step 2 of 4 · Scan");
    expect(t).toContain("Scan it with your authenticator app. Or type this key.");
    expect(t).toContain("Next Back");
  });

  it("step 3: the code field, Turn on off until six digits", () => {
    const html = setup({ ...SCAN, step: 3, code: "913" });
    expect(text(html)).toContain("Step 3 of 4 · Code");
    expect(tag(html, 'id="setup-code"')).toContain('autoComplete="one-time-code"');
    expect(buttonTag(html, "Turn on")).toMatch(DISABLED);
  });

  it("step 4: All set, two columns of codes, Done off until ticked, no Sign out", () => {
    const html = setup({ ...SCAN, step: 4, codes: CODES });
    const t = text(html);
    expect(t).toContain("All set. Two-step sign-in is on. Save these codes now.");
    expect(t).toContain("Step 4 of 4 · Codes");
    expect(tag(html, 'aria-label="Recovery codes"')).toContain("grid-cols-2");
    expect(buttonTag(html, "Done")).toMatch(DISABLED);
    expect(t).not.toContain("Sign out");
  });

  it("the set-up session ended: Sign in again, the field off, Back to sign in", () => {
    const html = setup({
      ...SCAN,
      step: 3,
      code: "913",
      stop: "session",
      blockError: "Sign in again.",
    });
    const t = text(html);
    expect(t).toContain("Sign in again.");
    expect(tag(html, 'id="setup-code"')).toMatch(DISABLED);
    expect(buttonTag(html, "Back to sign in")).not.toMatch(DISABLED);
    // No Back link and no foot: one way out.
    expect(t.match(/Back/g)).toHaveLength(1);
    expect(t).toMatch(/Back to sign in$/);
  });

  it("expired set-up: Start again", () => {
    const t = text(
      setup({
        ...SCAN,
        step: 3,
        stop: "expired",
        blockError: "Start setting up two-step sign-in again.",
      }),
    );
    expect(t).toContain("Start setting up two-step sign-in again. Start again");
  });
});

// ---------------------------------------------------------------------------
// §06 Users and the reset
// ---------------------------------------------------------------------------

const USERS = [
  { id: "u1", email: "sam@brisk.test", two_step: true },
  { id: "u2", email: "dev@brisk.test", two_step: false },
];

describe("§06 users and reset", () => {
  it("closed: Users · 2, nothing else", () => {
    const html = renderToStaticMarkup(
      h(CustomerUsersView, {
        customerId: "brisk",
        users: USERS,
        open: false,
        done: {},
        onToggle: noop,
        onReset: noop,
      }),
    );
    expect(text(html)).toBe("Users · 2");
    expect(tag(html, "aria-expanded")).toContain('aria-expanded="false"');
  });

  it("open: Email, Two-step; Reset only on the user with two-step on", () => {
    const html = renderToStaticMarkup(
      h(CustomerUsersView, {
        customerId: "brisk",
        users: USERS,
        open: true,
        done: {},
        onToggle: noop,
        onReset: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain("Email Two-step");
    expect(t).toContain("sam@brisk.test Two-step: On Reset two-step");
    expect(t).toMatch(/dev@brisk\.test Two-step: Off$/);
    expect(html.match(/Reset two-step/g)).toHaveLength(1);
  });

  it("after: the row reads Off with the count from the answer", () => {
    const html = renderToStaticMarkup(
      h(CustomerUsersView, {
        customerId: "brisk",
        users: [{ ...USERS[0], two_step: false }, USERS[1]] as typeof USERS,
        open: true,
        done: { u1: 1 },
        onToggle: noop,
        onReset: noop,
      }),
    );
    expect(text(html)).toContain("sam@brisk.test Two-step: Off Reset. 1 session ended.");
  });

  it("the confirm names the email; Close, Cancel, Reset in that order", () => {
    const html = renderToStaticMarkup(
      h(
        Dialog,
        { open: true },
        h(ResetBody, { email: EMAIL, busy: false, error: null, onReset: noop }),
      ),
    );
    const t = text(html);
    expect(t).toBe(
      "Close Reset two-step sign-in for sam@brisk.test? They sign in with their password and set it up again. Their sessions end. Only on a request you have checked. Cancel Reset",
    );
    expect(buttonTag(html, "Reset<")).toContain("bg-state-err");
  });

  it("refused by the API: its sentence", () => {
    const html = renderToStaticMarkup(
      h(
        Dialog,
        { open: true },
        h(ResetBody, {
          email: EMAIL,
          busy: false,
          error: "Only a customer user can be reset here.",
          onReset: noop,
        }),
      ),
    );
    expect(text(html)).toContain("Only a customer user can be reset here.");
  });
});

// ---------------------------------------------------------------------------
// §07 Recovery line, and the account menu
// ---------------------------------------------------------------------------

describe("§07 the line after a recovery-code sign-in", () => {
  it("7 left: plain, the link to New recovery codes, Dismiss", () => {
    const html = renderToStaticMarkup(h(RecoveryLineView, { left: 7, onDismiss: noop }));
    expect(text(html)).toBe("You signed in with a recovery code. 7 left. New recovery codes");
    expect(html).toMatch(/^<output/);
    expect(html).toContain(`href="${NEW_CODES_HREF}"`);
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain("state-warn");
  });

  it("1 left reads amber; the last one says so and offers Make new codes", () => {
    expect(renderToStaticMarkup(h(RecoveryLineView, { left: 1, onDismiss: noop }))).toContain(
      "state-warn",
    );
    const last = renderToStaticMarkup(h(RecoveryLineView, { left: 0, onDismiss: noop }));
    expect(text(last)).toBe("That was your last recovery code. Make new codes");
    expect(last).toContain("state-warn");
  });
});

describe("the account menu (call 4)", () => {
  it("closed: the label with a chevron, a menu button", () => {
    const html = renderToStaticMarkup(
      h(AccountMenuView, {
        label: "brisk · sam@brisk.test",
        email: EMAIL,
        open: false,
        onToggle: noop,
        onKeyOpen: noop,
        onSignOut: noop,
        onItemKey: noop,
        onNavigate: noop,
      }),
    );
    expect(text(html)).toBe("brisk · sam@brisk.test");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("open: who, Account, Sign out", () => {
    const html = renderToStaticMarkup(
      h(AccountMenuView, {
        label: "brisk · sam@brisk.test",
        email: EMAIL,
        open: true,
        onToggle: noop,
        onKeyOpen: noop,
        onSignOut: noop,
        onItemKey: noop,
        onNavigate: noop,
      }),
    );
    expect(text(html)).toBe("brisk · sam@brisk.test sam@brisk.test Account Sign out");
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('href="/settings?tab=account"');
  });
});

describe("the words (no long dashes, sentence case)", () => {
  it("no screen carries an em or en dash", () => {
    const all = [
      second("idle"),
      second("locked", { message: "x" }),
      account(OFF),
      turnOn({}),
      turnOn(SCAN),
      turnOn({ ...SCAN, step: 4, codes: CODES }),
      check("off", {}),
      setup({}),
    ].join("");
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});
