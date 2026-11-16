"use client";

/**
 * /audit/#t=<token>: the free audit's sign-up (docs/specs/ai-traffic-audit.md
 * §3.2; mock section 02). Four fields, the banner tick, the terms tick, Send,
 * the Art. 13 line under it as the API words it, then "You're in." and "Set
 * your password", which sets the password here with the setup token held in
 * memory and opens /start.
 *
 * Tokens (privacy review): the invite token is read from the
 * fragment once and the fragment is dropped from the address bar; both
 * tokens travel only in POST bodies; nothing goes to storage.
 */

import { MailLinked } from "@/components/ui/MailLinked";
import { ENROL_PATH } from "@/lib/api";
import { isEmailShape, normalizeSiteUrl, siteHost } from "@/lib/apply";
import { TERMS_HREF, cap } from "@/lib/audit";
import {
  type AuditOpenAnswer,
  openAuditInvite,
  setAuditPassword,
  submitAudit,
  takeHashToken,
} from "@/lib/audit-api";
import { setSession } from "@/lib/auth";
import { NOTICE_PARAGRAPH } from "@/lib/golive";
import { PRIVACY_EMAIL, inviter } from "@/lib/identity";
import { type LoginAnswer, readLoginAnswer } from "@/lib/mfa";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import {
  LedgerColumn,
  LedgerHeadline,
  LedgerLede,
  LedgerMessage,
  greenButton,
  ledgerLink,
} from "./ledger";

const KICKER = "Rawuser · free audit";

export type SignupScreen =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "unreachable" }
  | { kind: "form"; invite: AuditOpenAnswer }
  | { kind: "done"; domain: string; setupToken: string };

/** The static shell the export prerenders, so the paper paints before JS. */
export function AuditSignupLoading() {
  return (
    <LedgerColumn kicker={KICKER}>
      <LedgerHeadline>See where your visits come from.</LedgerHeadline>
      <p className="mt-6 font-mono text-[12px] text-[#666666]" aria-live="polite">
        Opening your invite…
      </p>
    </LedgerColumn>
  );
}

/** What the open answer means for the page. */
export function screenForOpen(status: number, data: AuditOpenAnswer | null): SignupScreen {
  if (status === 404 || status === 410 || data?.status === "expired") return { kind: "expired" };
  if (status === 409 || data?.status === "used") return { kind: "used" };
  if (status >= 200 && status < 300 && data?.ok && data.status === "invited") {
    return { kind: "form", invite: data };
  }
  return status === 400 ? { kind: "expired" } : { kind: "unreachable" };
}

export function AuditSignupFlow() {
  const [token, setToken] = useState<string | null>(null);
  const [screen, setScreen] = useState<SignupScreen>({ kind: "loading" });

  useEffect(() => {
    setToken(takeHashToken());
  }, []);

  useEffect(() => {
    if (token === null) return;
    if (!token) {
      setScreen({ kind: "missing" });
      return;
    }
    let cancelled = false;
    openAuditInvite(token)
      .then(({ status, data }) => {
        if (!cancelled) setScreen(screenForOpen(status, data));
      })
      .catch(() => {
        if (!cancelled) setScreen({ kind: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (screen.kind === "form") {
    return (
      <AuditForm
        token={token ?? ""}
        invite={screen.invite}
        onDone={(domain, setupToken) => {
          setScreen({ kind: "done", domain, setupToken });
          window.scrollTo({ top: 0 });
        }}
        onUsed={() => setScreen({ kind: "used" })}
        onExpired={() => setScreen({ kind: "expired" })}
      />
    );
  }
  return <SignupScreenView screen={screen} />;
}

/** Every screen but the form. */
export function SignupScreenView({ screen }: { screen: Exclude<SignupScreen, { kind: "form" }> }) {
  switch (screen.kind) {
    case "loading":
      return <AuditSignupLoading />;
    case "missing":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="This page opens from an invite link."
          body={`Ask ${inviter()} for one, and it will bring you straight here.`}
        />
      );
    case "expired":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="This link has expired."
          body={`Reply to ${inviter()} for a new one.`}
        />
      );
    case "used":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="This link was used."
          body={
            <>
              <Link href="/login/" className={ledgerLink}>
                Sign in
              </Link>{" "}
              to see your audit.
            </>
          }
        />
      );
    case "unreachable":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="We couldn't open your invite."
          body="Rawuser did not answer. Reload the page in a minute."
        />
      );
    case "done":
      return <DoneScreen domain={screen.domain} setupToken={screen.setupToken} />;
  }
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

type Field = "url" | "name" | "email";
type Errors = Partial<Record<Field, string>>;

const fieldBase =
  "block h-12 w-full rounded-[6px] border bg-[#ffffff] px-3.5 text-[16px] leading-[1.45] text-[#171717] " +
  "placeholder:text-[#8a8a8a] outline-none transition-[border-color,box-shadow] duration-150 " +
  "focus:border-[#1E4737] focus:shadow-[0_0_0_3px_rgba(30,71,55,0.14)]";

function tone(error?: string) {
  return error ? "border-[#9A3A22]" : "border-[#d4d4d4]";
}

export const TERMS_LINE =
  "Some headings, texts and buttons on pages you confirm change for your visitors until the audit ends.";
export const BANNER_TICK = "My site shows a cookie or consent banner.";
export const BANNER_HELP =
  "Using a cookie banner? Put the tag in its category your lawyer prefers.";
export const BANNER_MORE = "Visitors who say no see your page as built and are not counted.";
export const TERMS_REQUIRED = "Tick the audit terms to send.";

function validate(v: { url: string; name: string; email: string }): Errors {
  const e: Errors = {};
  if (!v.url.trim()) e.url = "Your site's address, please.";
  else if (!normalizeSiteUrl(v.url)) e.url = "That doesn't look like a web address.";
  if (!v.name.trim()) e.name = "Your name, please.";
  if (!v.email.trim()) e.email = "Your email, please.";
  else if (!isEmailShape(v.email)) e.email = "That email doesn't look right.";
  return e;
}

/** What the page says when the submit refused one field. */
function serverField(field: string, error: string): { field: Field; line: string } | null {
  if (field === "url") return { field, line: "That doesn't look like a public web address." };
  if (field === "email") return { field, line: "That email doesn't look right." };
  if (field === "name")
    return {
      field,
      line: /100/.test(error) ? "Keep it under 100 characters." : "Your name, please.",
    };
  return null;
}

/** What the password step says when its link died meanwhile. */
export function linkGoneLine(): string {
  return `This link no longer works. Reply to ${inviter()} for a new one.`;
}

/** The privacy line as the API wrote it, its address made a link (the words unchanged). */
export function PrivacyLine({ text }: { text: string }) {
  return <MailLinked text={text} address={PRIVACY_EMAIL} className={ledgerLink} />;
}

function Tick({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3">
      <span className="relative mt-px inline-flex size-5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 m-0 size-5 cursor-pointer appearance-none rounded-[4px] border border-[#171717] bg-white transition-colors duration-150 checked:border-[#1E4737] checked:bg-[#1E4737] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737]"
        />
        <Check
          size={13}
          strokeWidth={2.5}
          aria-hidden
          className="pointer-events-none absolute left-[3.5px] top-[3.5px] text-[#f5f5f5] opacity-0 peer-checked:opacity-100"
        />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Disclose({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-1.5 text-[13.5px] text-[#666666]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="text-[#171717] underline decoration-[#d4d4d4] underline-offset-[3px] hover:decoration-[#171717]"
      >
        {summary}
      </button>
      {open && (
        <div id={id} className="mt-2 leading-[1.55]">
          {children}
        </div>
      )}
    </div>
  );
}

function NoticeBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[6px] border border-[#d4d4d4] bg-white px-3.5 py-3 text-[13px] leading-[1.55] text-[#525252]">
      <p className="max-h-[40vh] overflow-y-auto">{NOTICE_PARAGRAPH}</p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              .writeText(NOTICE_PARAGRAPH)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
          className="h-[30px] rounded-full border border-[#171717] px-3 font-mono text-[12px] text-[#171717] hover:bg-[#171717] hover:text-[#f5f5f5]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export interface AuditFormProps {
  token: string;
  invite: AuditOpenAnswer;
  onDone: (domain: string, setupToken: string) => void;
  onUsed: () => void;
  onExpired: () => void;
  /** Fixtures and tests: the state on arrival. */
  initial?: {
    url?: string;
    name?: string;
    email?: string;
    banner?: boolean;
    terms?: boolean;
    errors?: Errors;
    sendError?: string | null;
  };
}

export function AuditForm({ token, invite, onDone, onUsed, onExpired, initial }: AuditFormProps) {
  const uid = useId();
  const ids = { url: `${uid}-url`, name: `${uid}-name`, email: `${uid}-email` };
  const [url, setUrl] = useState(initial?.url ?? invite.invited_site ?? "");
  const [name, setName] = useState(initial?.name ?? invite.invited_name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [banner, setBanner] = useState(initial?.banner ?? false);
  // Unticked on arrival, always (privacy review).
  const [terms, setTerms] = useState(initial?.terms ?? false);
  const [attempted, setAttempted] = useState(Boolean(initial?.errors));
  const [serverErrors, setServerErrors] = useState<Errors>(initial?.errors ?? {});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(initial?.sendError ?? null);

  const errors: Errors = { ...(attempted ? validate({ url, name, email }) : {}), ...serverErrors };
  const clear = (f: Field) =>
    setServerErrors((e) => {
      if (!e[f]) return e;
      const n = { ...e };
      delete n[f];
      return n;
    });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setAttempted(true);
    setSendError(null);
    const found = validate({ url, name, email });
    const first = (["url", "name", "email"] as Field[]).find((f) => found[f]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    if (!terms) {
      setSendError(TERMS_REQUIRED);
      return;
    }
    setSending(true);
    try {
      const { status, data } = await submitAudit(token, {
        url: normalizeSiteUrl(url) ?? url.trim(),
        name: name.trim(),
        email: email.trim(),
        banner,
        terms: true,
      });
      if (status === 201 && data?.ok && data.setup_token) {
        onDone(data.domain ?? siteHost(url), data.setup_token);
        return;
      }
      if (status === 404 || status === 410) return onExpired();
      if (status === 409 && data?.error === "used") return onUsed();
      if (status === 409 && data?.message) {
        setSendError(data.message);
        return;
      }
      if (status === 400 && data?.field) {
        if (data.field === "terms") {
          setSendError(data.error ?? TERMS_REQUIRED);
          return;
        }
        const f = serverField(data.field, data.error ?? "");
        if (f) {
          setServerErrors({ [f.field]: f.line });
          document.getElementById(ids[f.field])?.focus();
          return;
        }
      }
      setSendError("That didn't go through on our side. Send again in a minute.");
    } catch {
      setSendError("Rawuser did not answer. Check your connection and send again.");
    } finally {
      setSending(false);
    }
  }

  const describedBy = (f: Field) => (errors[f] ? `${ids[f]}-error` : undefined);
  const FieldError = ({ f }: { f: Field }) =>
    errors[f] ? (
      <p id={`${ids[f]}-error`} className="mt-1.5 text-[13.5px] leading-[1.45] text-[#9A3A22]">
        {errors[f]}
      </p>
    ) : null;

  return (
    <LedgerColumn kicker={KICKER}>
      <LedgerHeadline>See where your visits come from.</LedgerHeadline>
      <LedgerLede>
        Two weeks free. Your visitors see versions written for why they came, and you get a report a
        week after you go live.
      </LedgerLede>

      <form
        onSubmit={send}
        noValidate
        className="mt-10 flex flex-col gap-[26px] border-t border-[#d4d4d4] pt-8"
      >
        <div>
          <label htmlFor={ids.url} className="mb-2 block text-[15px] font-medium">
            Your site
          </label>
          <input
            id={ids.url}
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="yourproduct.com"
            value={url}
            onChange={(e) => {
              clear("url");
              setUrl(e.target.value);
            }}
            aria-invalid={!!errors.url}
            aria-describedby={describedBy("url")}
            className={cn(fieldBase, tone(errors.url))}
          />
          <FieldError f="url" />
        </div>

        <div className="grid gap-[26px] sm:grid-cols-2 sm:gap-4">
          <div>
            <label htmlFor={ids.name} className="mb-2 block text-[15px] font-medium">
              Your name
            </label>
            <input
              id={ids.name}
              type="text"
              autoComplete="name"
              maxLength={100}
              value={name}
              onChange={(e) => {
                clear("name");
                setName(e.target.value);
              }}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy("name")}
              className={cn(fieldBase, tone(errors.name))}
            />
            <FieldError f="name" />
          </div>
          <div>
            <label htmlFor={ids.email} className="mb-2 block text-[15px] font-medium">
              Your email
            </label>
            <input
              id={ids.email}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={320}
              value={email}
              onChange={(e) => {
                clear("email");
                setEmail(e.target.value);
              }}
              aria-invalid={!!errors.email}
              aria-describedby={describedBy("email")}
              className={cn(fieldBase, tone(errors.email))}
            />
            <FieldError f="email" />
          </div>
        </div>

        <Tick id={`${uid}-banner`} checked={banner} onChange={setBanner}>
          <label
            htmlFor={`${uid}-banner`}
            className="block cursor-pointer text-[15px] font-medium leading-[1.45]"
          >
            {BANNER_TICK}
          </label>
          {/* Only for a site with a banner (privacy review). */}
          {banner && (
            <>
              <p className="mt-1 text-[13.5px] leading-[1.5] text-[#666666]">{BANNER_HELP}</p>
              <Disclose summary="More">{BANNER_MORE}</Disclose>
            </>
          )}
        </Tick>

        <Tick
          id={`${uid}-terms`}
          checked={terms}
          onChange={(v) => {
            setTerms(v);
            if (v && sendError === TERMS_REQUIRED) setSendError(null);
          }}
        >
          <p className="text-[15px] font-medium leading-[1.45]">
            <label htmlFor={`${uid}-terms`} className="cursor-pointer">
              I accept the{" "}
            </label>
            <a href={TERMS_HREF} target="_blank" rel="noreferrer noopener" className={ledgerLink}>
              audit terms
            </a>
          </p>
          <p className="mt-1 text-[13.5px] leading-[1.5] text-[#666666]">{TERMS_LINE}</p>
          <Disclose summary="Text for your privacy notice">
            <NoticeBlock />
          </Disclose>
        </Tick>

        <div className="flex flex-col gap-3">
          <button
            type="submit"
            aria-disabled={!terms || sending}
            className={cn(
              greenButton,
              "w-full sm:w-auto sm:self-start",
              (!terms || sending) && "opacity-45",
              sending && "cursor-wait",
            )}
          >
            {sending ? "Sending…" : "Send"}
          </button>
          {sendError && (
            <p role="alert" className="text-[13.5px] leading-[1.45] text-[#9A3A22]">
              {sendError}
            </p>
          )}
          {invite.privacy_line && (
            <p className="max-w-[34rem] text-[13px] leading-[1.55] text-[#666666]">
              <PrivacyLine text={invite.privacy_line} />
            </p>
          )}
        </div>
      </form>
    </LedgerColumn>
  );
}

// ---------------------------------------------------------------------------
// You're in
// ---------------------------------------------------------------------------

/**
 * "You're in." and "Set your password". The setup token stays in this
 * component's memory and goes out once, in the setup POST's body.
 */
export function DoneScreen({
  domain,
  setupToken,
  initialStep = "done",
}: {
  domain: string;
  setupToken: string;
  initialStep?: "done" | "password";
}) {
  const router = useRouter();
  const [step, setStep] = useState<"done" | "password">(initialStep);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const kicker = `${KICKER} for ${domain}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) return setError("At least 8 characters.");
    if (password !== again) return setError("The two passwords are not the same.");
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await setAuditPassword(setupToken, password);
      if (status === 200 && data) {
        const next = readLoginAnswer(data as LoginAnswer);
        if (next.kind === "done") {
          setSession({ token: next.token, user: next.user });
          router.replace("/start/");
          return;
        }
        if (next.kind === "enrol") {
          setSession({ token: next.token, user: next.user, enrolOnly: true });
          router.replace(ENROL_PATH);
          return;
        }
        if (next.kind === "second-step") {
          router.replace("/login/");
          return;
        }
      }
      if (status === 404) setError(linkGoneLine());
      else if (status === 400) setError("At least 8 characters.");
      else setError("That didn't go through on our side. Try again in a minute.");
    } catch {
      setError("Rawuser did not answer. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <LedgerColumn kicker={kicker}>
        <div className="animate-fade-in">
          <LedgerHeadline>You&rsquo;re in.</LedgerHeadline>
          <LedgerLede>Set a password, then put the tag on your site.</LedgerLede>
          <button
            type="button"
            onClick={() => setStep("password")}
            className={cn(greenButton, "mt-7 w-full sm:w-auto")}
          >
            Set your password
          </button>
        </div>
      </LedgerColumn>
    );
  }

  return (
    <LedgerColumn kicker={kicker}>
      <LedgerHeadline>Set your password.</LedgerHeadline>
      <form
        onSubmit={save}
        noValidate
        className="mt-8 flex flex-col gap-[22px] border-t border-[#d4d4d4] pt-8"
      >
        <div>
          <label htmlFor={`${uid}-pw`} className="mb-2 block text-[15px] font-medium">
            Password
          </label>
          <input
            id={`${uid}-pw`}
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cn(fieldBase, "border-[#d4d4d4]")}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-pw2`} className="mb-2 block text-[15px] font-medium">
            Again
          </label>
          <input
            id={`${uid}-pw2`}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            className={cn(fieldBase, "border-[#d4d4d4]")}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className={cn(greenButton, "w-full sm:w-auto sm:self-start")}
        >
          {busy ? "Saving…" : "Set password"}
        </button>
        {error && (
          <p role="alert" className="text-[13.5px] leading-[1.45] text-[#9A3A22]">
            {cap(error)}
          </p>
        )}
      </form>
    </LedgerColumn>
  );
}
