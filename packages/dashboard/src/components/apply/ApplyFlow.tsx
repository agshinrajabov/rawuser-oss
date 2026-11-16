"use client";

/**
 * The pilot apply flow (docs/specs/pilot-apply.md, mock approved 2026-10-01).
 *
 * invite -> read my site -> correct -> send -> "You're in." with the tag.
 *
 * Quiet-ledger look, local to this page: the landing's whitish grey (#f5f5f5), hairline fields, ink,
 * one green. Nothing here asks about the applicant's visitors; the only data
 * is the company's own answers and a contact, given by explicit action.
 */

import { Codey } from "@/components/onboard/Codey";
import { MailLinked } from "@/components/ui/MailLinked";
import { APPLY_PRIVACY_NOTICE } from "@/hosted/notices";
import { API_ORIGIN } from "@/lib/api";
import {
  APPLY_SOURCES,
  READ_SLOW_MS,
  READ_STILL_MS,
  isEmailShape,
  normalizeSiteUrl,
  readRefusal,
  readingLine,
  siteHost,
} from "@/lib/apply";
import { OPERATOR_EMAIL, PRIVACY_EMAIL, inviter } from "@/lib/identity";
import {
  HIDE_STYLE_HASH,
  NONCE_PLACEHOLDER,
  doneLede,
  donePolicy,
  donePolicyStep,
  doneTagStep,
  linesLabel,
} from "@/lib/install";
import {
  ANSWER_FIRST,
  HIDE,
  NO,
  QUESTION,
  TAG_WITH_NOTE,
  WHY_LINES,
  WHY_WE_ASK,
  YES,
  YES_HELD_LINE,
} from "@/lib/readiness";
import { EDGE_MARK, buildSnippet, isTag } from "@/lib/snippet-tag";
import { cn } from "@/lib/utils";
import type {
  ApplyInviteResponse,
  ApplyReadErrorCode,
  ApplyReadResponse,
  ApplySubmitResponse,
  InstallFacts,
} from "@/types/api";
import { useCallback, useEffect, useId, useRef, useState } from "react";

// ── Palette (local; see ADR 0027 for the system it borrows from) ─────────
const PAPER = "#f5f5f5";

// ── Public fetch: no session header, no /login redirect ─────────────────
async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: T | null }> {
  const resp = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let data: T | null = null;
  try {
    data = (await resp.json()) as T;
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

export interface Done {
  customer_id: string;
  tag: string;
  /** What the read of the site said about installing the tag; absent after a reload. */
  install?: InstallFacts | null;
  /**
   * The tag withheld (readiness-check.md, the privacy review's condition 2): the
   * applicant answered Yes to the special-category question, or the API
   * says so; the done screen then shows no tag.
   */
  withheld?: boolean;
}

/**
 * The invite token rides in the fragment (`/apply/#t=<token>`), which the
 * browser never sends to a server or in a Referer, and is only ever sent in
 * a POST body. No link was ever minted with `?t=`, so none is read.
 * Nothing is written to localStorage, sessionStorage or cookies.
 */
function readToken(): string {
  return (new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "").trim();
}

type Screen =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "unreachable" }
  | { kind: "form"; invite: ApplyInviteResponse }
  | { kind: "done"; done: Done };

// ── Layout pieces ───────────────────────────────────────────────────────

function Page({ kicker, children }: { kicker: string; children: React.ReactNode }) {
  // The paper reaches the overscroll edges too, not only the column.
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = prev;
    };
  }, []);

  return (
    <main className="min-h-dvh bg-[#f5f5f5] text-[#171717] antialiased selection:bg-[#1E4737] selection:text-[#f5f5f5]">
      <div className="mx-auto w-full max-w-[36rem] px-4 pb-24 pt-10 sm:px-6 sm:pt-20">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#666666]">
          {kicker}
        </p>
        {children}
      </div>
    </main>
  );
}

function Headline({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mt-5 text-[2.125rem] font-medium leading-[1.06] tracking-[-0.025em] text-[#171717] [text-wrap:balance] sm:text-[2.75rem]">
      {children}
    </h1>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 max-w-[32rem] text-[1rem] leading-[1.6] text-[#525252] sm:text-[1.0625rem]">
      {children}
    </p>
  );
}

function Message({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <Page kicker={kicker}>
      <div className="animate-fade-in">
        <Headline>{title}</Headline>
        <Lede>{body}</Lede>
      </div>
    </Page>
  );
}

/** The static shell the export prerenders, so the paper paints before JS. */
/** The four screens that are one message: no link, an old one, a used one, or no answer. */
export function InviteMessage({
  kind,
  kicker,
}: {
  kind: "missing" | "expired" | "used" | "unreachable";
  kicker: string;
}) {
  switch (kind) {
    case "missing":
      return (
        <Message
          kicker={kicker}
          title="This page opens from an invite link."
          body={`Ask ${inviter()} for one, and it will bring you straight here.`}
        />
      );
    case "expired":
      return (
        <Message
          kicker={kicker}
          title="This link has expired."
          body={`Ask ${inviter()} for a new one.`}
        />
      );
    case "used":
      return (
        <Message
          kicker={kicker}
          title="This invite was already used."
          body={`If you need your tag again, ${inviter()} can send it to you.`}
        />
      );
    case "unreachable":
      return (
        <Message
          kicker={kicker}
          title="We couldn't open your invite."
          body="Rawuser did not answer. Reload the page in a minute."
        />
      );
  }
}

export function ApplyLoading() {
  return (
    <Page kicker="Rawuser · pilot">
      <Headline>Tell us about your site.</Headline>
      <p className="mt-6 font-mono text-[12px] text-[#666666]" aria-live="polite">
        Opening your invite…
      </p>
    </Page>
  );
}

function kickerFor(invite?: ApplyInviteResponse | null): string {
  const who = invite?.invited_name?.trim() || siteHost(invite?.invited_site);
  return who ? `Rawuser · pilot for ${who}` : "Rawuser · pilot";
}

// ── Entry ───────────────────────────────────────────────────────────────

export function ApplyFlow() {
  const [token, setToken] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [kicker, setKicker] = useState("Rawuser · pilot");

  useEffect(() => {
    setToken(readToken());
  }, []);

  // The invite answer is the only source of the done screen after a reload:
  // status "applied" with its customer_id.
  const checkInvite = useCallback(async (t: string): Promise<Screen> => {
    try {
      const { status, data } = await call<ApplyInviteResponse>("/admin/apply/invite", {
        method: "POST",
        body: JSON.stringify({ t }),
      });
      if (data?.ok) setKicker(kickerFor(data));
      if (status === 404 || status === 410 || data?.status === "expired")
        return { kind: "expired" };
      if (status === 409 || data?.status === "applied") {
        return data?.customer_id
          ? {
              kind: "done",
              done: {
                customer_id: data.customer_id,
                tag: buildSnippet(data.customer_id),
                withheld: data.tag_withheld === true,
              },
            }
          : { kind: "used" };
      }
      if (status >= 200 && status < 300 && data?.ok) return { kind: "form", invite: data };
      // A 400 means the token is malformed: the same calm answer as expired.
      return status === 400 ? { kind: "expired" } : { kind: "unreachable" };
    } catch {
      return { kind: "unreachable" };
    }
  }, []);

  useEffect(() => {
    if (token === null) return;
    if (!token) {
      setScreen({ kind: "missing" });
      return;
    }
    let cancelled = false;
    void checkInvite(token).then((next) => {
      if (!cancelled) setScreen(next);
    });
    return () => {
      cancelled = true;
    };
  }, [token, checkInvite]);

  switch (screen.kind) {
    case "loading":
      return <ApplyLoading />;
    case "missing":
    case "expired":
    case "used":
    case "unreachable":
      return <InviteMessage kind={screen.kind} kicker={kicker} />;
    case "done":
      return <DoneScreen kicker={kicker} done={screen.done} />;
    case "form":
      return (
        <ApplyForm
          token={token ?? ""}
          kicker={kicker}
          invite={screen.invite}
          onDone={(done) => {
            setScreen({ kind: "done", done });
            window.scrollTo({ top: 0 });
          }}
          onExpired={() => setScreen({ kind: "expired" })}
          onUsed={() => {
            if (token) void checkInvite(token).then(setScreen);
          }}
        />
      );
  }
}

// ── The form ────────────────────────────────────────────────────────────

type Prefillable = "product" | "icp" | "differentiator";
type FieldName = "url" | Prefillable | "numbers" | "name" | "email";
type Errors = Partial<Record<FieldName, string>>;

/**
 * The server's limits (packages/generation/src/admin/apply.ts LIMITS), so the
 * page never lets an answer grow past what the submit accepts (2026-10-02:
 * an applicant wrote long answers and saw only "something is missing").
 */
const LIMITS: Record<Exclude<FieldName, "url">, number> = {
  product: 300,
  icp: 300,
  differentiator: 300,
  numbers: 500,
  name: 100,
  email: 320,
};

/** What the page says when the submit refused one field. */
function serverFieldMessage(field: FieldName, error: string): string {
  if (field === "url") return "That doesn't look like a public web address.";
  if (field === "email") return "That email doesn't look right.";
  if (/required/.test(error)) return "This one is needed.";
  if (/chars/.test(error)) return `Keep it under ${LIMITS[field]} characters.`;
  return "Check this answer.";
}

const SERVER_FIELDS: FieldName[] = [
  "url",
  "product",
  "icp",
  "differentiator",
  "numbers",
  "name",
  "email",
];

const fieldBase =
  "block w-full rounded-[6px] border bg-[#ffffff] px-3.5 text-[16px] leading-[1.45] text-[#171717] " +
  "placeholder:text-[#8a8a8a] outline-none transition-[border-color,box-shadow] duration-150 " +
  "focus:border-[#1E4737] focus:shadow-[0_0_0_3px_rgba(30,71,55,0.14)]";

function fieldTone(error?: string) {
  return error ? "border-[#9A3A22]" : "border-[#d4d4d4]";
}

function FromSiteTag() {
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] lowercase text-[#1E4737] animate-fade-in">
      <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-[#1E4737]" />
      from your site
    </span>
  );
}

function Field({
  id,
  label,
  optional,
  helper,
  error,
  fromSite,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  helper?: string;
  error?: string;
  fromSite?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-3">
        <label htmlFor={id} className="text-[15px] font-medium leading-snug text-[#171717]">
          {label}
          {optional && <span className="font-normal text-[#666666]"> (optional)</span>}
        </label>
        {fromSite && <FromSiteTag />}
      </div>
      {helper && <p className="-mt-1 mb-2 text-[13.5px] leading-[1.5] text-[#666666]">{helper}</p>}
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-[13.5px] leading-[1.45] text-[#9A3A22]">
          {error}
        </p>
      )}
    </div>
  );
}

function validate(v: {
  url: string;
  product: string;
  icp: string;
  name: string;
  email: string;
}): Errors {
  const e: Errors = {};
  if (!v.url.trim()) e.url = "Your site's address, please.";
  else if (!normalizeSiteUrl(v.url)) e.url = "That doesn't look like a web address.";
  if (!v.product.trim()) e.product = "Tell us what you sell, in a line.";
  if (!v.icp.trim()) e.icp = "Tell us who buys it most.";
  if (!v.name.trim()) e.name = "Your name, please.";
  if (!v.email.trim()) e.email = "Your email, please.";
  else if (!isEmailShape(v.email)) e.email = "That email doesn't look right.";
  return e;
}

const FIELD_ORDER: FieldName[] = [
  "url",
  "product",
  "icp",
  "differentiator",
  "numbers",
  "name",
  "email",
];

function ApplyForm({
  token,
  kicker,
  invite,
  onDone,
  onExpired,
  onUsed,
}: {
  token: string;
  kicker: string;
  invite: ApplyInviteResponse;
  onDone: (done: Done) => void;
  onExpired: () => void;
  onUsed: () => void;
}) {
  const uid = useId();
  const ids = Object.fromEntries(FIELD_ORDER.map((f) => [f, `${uid}-${f}`])) as Record<
    FieldName,
    string
  >;

  const [url, setUrl] = useState(invite.invited_site ?? "");
  const [text, setText] = useState<Record<Prefillable | "numbers", string>>({
    product: "",
    icp: "",
    differentiator: "",
    numbers: "",
  });
  const [sources, setSources] = useState<string[]>([]);
  // The special-category question on the door's first screen, before any
  // tag (readiness-check.md check 3; the privacy review's condition 2). Null
  // until answered; the form does not send without an answer.
  const [category, setCategory] = useState<boolean | null>(null);
  const categoryRef = useRef<HTMLFieldSetElement>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fromSite, setFromSite] = useState<Set<Prefillable>>(new Set());
  // The read is async; it must see what the applicant typed meanwhile.
  const textRef = useRef(text);
  textRef.current = text;
  const fromSiteRef = useRef(fromSite);
  fromSiteRef.current = fromSite;

  const [read, setRead] = useState<
    | { state: "idle" }
    | { state: "reading" }
    | { state: "ok"; line: string }
    | { state: "error"; line: string }
  >({ state: "idle" });
  // A site built in the browser is rendered first (install-friction A), and
  // the writing model can be slow: the line says so instead of looking
  // stuck. 0 to 8 s, then up to 30 s, then after.
  const [readPhase, setReadPhase] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    if (read.state !== "reading") {
      setReadPhase(0);
      return;
    }
    const t1 = setTimeout(() => setReadPhase(1), READ_SLOW_MS);
    const t2 = setTimeout(() => setReadPhase(2), READ_STILL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [read.state]);

  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // A field the submit refused, shown under that field until it changes.
  const [serverErrors, setServerErrors] = useState<Errors>({});

  const values = { url, product: text.product, icp: text.icp, name, email };
  const errors: Errors = { ...(attempted ? validate(values) : {}), ...serverErrors };
  const clearServer = (f: FieldName) =>
    setServerErrors((e) => {
      if (!e[f]) return e;
      const next = { ...e };
      delete next[f];
      return next;
    });

  function setPrefillable(key: Prefillable | "numbers", value: string) {
    clearServer(key);
    setText((t) => ({ ...t, [key]: value }));
    if (key !== "numbers" && fromSite.has(key)) {
      setFromSite((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async function readSite() {
    const normalized = normalizeSiteUrl(url);
    if (!normalized) {
      setRead({ state: "error", line: "Type your site's address first, like yourproduct.com." });
      return;
    }
    setRead({ state: "reading" });
    try {
      const { status, data } = await call<ApplyReadResponse>("/admin/apply/read", {
        method: "POST",
        body: JSON.stringify({ t: token, url: normalized }),
      });
      if (status === 429) {
        setRead({
          state: "error",
          line: "You've read the site three times. Fill in the rest by hand.",
        });
        return;
      }
      if (status === 410) return onExpired();
      if (status === 409) return onUsed();
      if (status === 422) {
        // Each 422 gives the read back (generation admin/apply.ts).
        const code = (data as { error?: ApplyReadErrorCode } | null)?.error;
        setRead({ state: "error", line: readRefusal(code) });
        return;
      }
      if (status === 400) {
        setRead({
          state: "error",
          line: "That address isn't a public website we can open. Check it and try again.",
        });
        return;
      }
      if (status === 502 || !data?.ok) {
        setRead({
          state: "error",
          line: "We couldn't read that page just now. Check the address, or fill in the rest by hand.",
        });
        return;
      }

      const s = data.suggestions ?? {};
      const found: Record<Prefillable, string> = {
        product: s.product?.trim() ?? "",
        icp: s.icp?.trim() ?? "",
        differentiator: s.differentiators?.find((d) => d.trim())?.trim() ?? "",
      };
      // Fill only what is empty or still the site's own words; never
      // overwrite something the applicant typed.
      const current = textRef.current;
      const siteOwned = fromSiteRef.current;
      const filled = new Set<Prefillable>();
      for (const key of Object.keys(found) as Prefillable[]) {
        if (found[key] && (!current[key].trim() || siteOwned.has(key))) filled.add(key);
      }
      setText((t) => {
        const next = { ...t };
        for (const key of filled) next[key] = found[key];
        return next;
      });
      setFromSite((prev) => {
        const next = new Set(prev);
        for (const key of filled) next.add(key);
        return next;
      });
      const pages = data.pages && data.pages > 0 ? data.pages : 1;
      setRead({
        state: "ok",
        line: `Read ${pages} page${pages === 1 ? "" : "s"} · filled ${filled.size} of 6 answers`,
      });
    } catch {
      setRead({ state: "error", line: "Rawuser did not answer. Try again in a moment." });
    }
  }

  function toggleSource(value: string) {
    setSources((s) => (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setAttempted(true);
    setSendError(null);
    const found = validate(values);
    const first = FIELD_ORDER.find((f) => found[f]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    if (category === null) {
      categoryRef.current?.querySelector("button")?.focus();
      return;
    }

    setSending(true);
    try {
      const { status, data } = await call<ApplySubmitResponse & { error?: string }>(
        "/admin/apply/submit",
        {
          method: "POST",
          body: JSON.stringify({
            t: token,
            url: normalizeSiteUrl(url),
            product: text.product.trim(),
            icp: text.icp.trim(),
            differentiator: text.differentiator.trim(),
            numbers: text.numbers.trim(),
            sources,
            special_category: category,
            name: name.trim(),
            email: email.trim(),
          }),
        },
      );
      if (status >= 200 && status < 300 && data?.ok && data.customer_id) {
        onDone({
          customer_id: data.customer_id,
          tag: data.tag || buildSnippet(data.customer_id),
          install: data.install ?? null,
          // A Yes holds the tag until the site is marked by hand, whatever
          // an older worker answers.
          withheld: category === true || data.tag_withheld === true,
        });
        return;
      }
      if (status === 410) return onExpired();
      if (status === 409) return onUsed();
      if (status === 400) {
        const field = (data as { field?: string } | null)?.field as FieldName | undefined;
        if (field && SERVER_FIELDS.includes(field)) {
          const error = (data as { error?: string } | null)?.error ?? "";
          setServerErrors({ [field]: serverFieldMessage(field, error) });
          setSendError("One answer needs a change. It is marked above.");
          document.getElementById(ids[field])?.focus();
          return;
        }
        setSendError(
          "Something is missing or doesn't look right. Check the answers above and send again.",
        );
      } else {
        setSendError("That didn't go through on our side. Send again in a minute.");
      }
    } catch {
      setSendError("Rawuser did not answer. Check your connection and send again.");
    } finally {
      setSending(false);
    }
  }

  const describedBy = (f: FieldName) => (errors[f] ? `${ids[f]}-error` : undefined);

  return (
    <Page kicker={kicker}>
      <Headline>Tell us about your site.</Headline>
      <Lede>
        Three minutes. We read your page first, so most of this is already filled in. You correct
        it, we write the versions.
      </Lede>

      <form
        onSubmit={submit}
        noValidate
        className="mt-10 flex flex-col gap-7 border-t border-[#d4d4d4] pt-8 sm:mt-12"
      >
        {/* 1. Site + read */}
        <Field id={ids.url} label="Your site" error={errors.url}>
          <div className="flex gap-2">
            <input
              id={ids.url}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="yourproduct.com"
              value={url}
              onChange={(e) => {
                clearServer("url");
                setUrl(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void readSite();
                }
              }}
              aria-invalid={!!errors.url}
              aria-describedby={describedBy("url")}
              className={cn(fieldBase, fieldTone(errors.url), "h-12 min-w-0 flex-1")}
            />
            <button
              type="button"
              onClick={() => void readSite()}
              disabled={read.state === "reading"}
              className="h-12 shrink-0 rounded-full border border-[#171717] px-4 text-[14px] font-medium text-[#171717] transition-[background-color,color,transform] duration-150 hover:bg-[#171717] hover:text-[#f5f5f5] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737] sm:px-5"
            >
              {read.state === "reading" ? "Reading…" : "Read my site"}
            </button>
          </div>
          <div aria-live="polite">
            {read.state === "ok" && (
              <p className="mt-2 flex items-center gap-2 font-mono text-[12px] text-[#1E4737] animate-fade-in">
                <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-[#1E4737]" />
                {read.line}
              </p>
            )}
            {read.state === "reading" && (
              <p className="mt-2 font-mono text-[12px] text-[#666666]" aria-live="polite">
                {readingLine(readPhase)}
              </p>
            )}
            {read.state === "error" && (
              <p className="mt-2 text-[13.5px] leading-[1.45] text-[#9A3A22] animate-fade-in">
                {read.line}
              </p>
            )}
          </div>
        </Field>

        {/* 2. What you sell */}
        <Field
          id={ids.product}
          label="What you sell, in one line"
          error={errors.product}
          fromSite={fromSite.has("product")}
        >
          <input
            id={ids.product}
            type="text"
            value={text.product}
            maxLength={LIMITS.product}
            onChange={(e) => setPrefillable("product", e.target.value)}
            aria-invalid={!!errors.product}
            aria-describedby={describedBy("product")}
            className={cn(fieldBase, fieldTone(errors.product), "h-12")}
          />
        </Field>

        {/* 3. Best customer */}
        <Field
          id={ids.icp}
          label="Who is your best customer?"
          error={errors.icp}
          fromSite={fromSite.has("icp")}
        >
          <textarea
            id={ids.icp}
            rows={2}
            value={text.icp}
            maxLength={LIMITS.icp}
            onChange={(e) => setPrefillable("icp", e.target.value)}
            aria-invalid={!!errors.icp}
            aria-describedby={describedBy("icp")}
            className={cn(fieldBase, fieldTone(errors.icp), "min-h-[5rem] resize-y py-3")}
          />
        </Field>

        {/* 4. Sets apart */}
        <Field
          id={ids.differentiator}
          label="What sets you apart from the alternatives?"
          error={errors.differentiator}
          fromSite={fromSite.has("differentiator")}
        >
          <textarea
            id={ids.differentiator}
            rows={2}
            value={text.differentiator}
            maxLength={LIMITS.differentiator}
            onChange={(e) => setPrefillable("differentiator", e.target.value)}
            aria-invalid={!!errors.differentiator}
            aria-describedby={describedBy("differentiator")}
            className={cn(
              fieldBase,
              fieldTone(errors.differentiator),
              "min-h-[5rem] resize-y py-3",
            )}
          />
        </Field>

        {/* 5. Numbers */}
        <Field
          id={ids.numbers}
          label="Numbers we may use"
          optional
          helper="Prices, customers, results. We never write a number you didn't give us."
          error={errors.numbers}
        >
          <textarea
            id={ids.numbers}
            rows={3}
            placeholder={"$29 a month\n1,200 teams\nSetup in 10 minutes"}
            value={text.numbers}
            maxLength={LIMITS.numbers}
            onChange={(e) => setPrefillable("numbers", e.target.value)}
            aria-invalid={!!errors.numbers}
            aria-describedby={describedBy("numbers")}
            className={cn(fieldBase, fieldTone(errors.numbers), "min-h-[6rem] resize-y py-3")}
          />
        </Field>

        {/* 6. Sources */}
        <fieldset>
          <legend className="mb-3 text-[15px] font-medium leading-snug text-[#171717]">
            Where do your visitors come from?
          </legend>
          <div className="flex flex-wrap gap-2">
            {APPLY_SOURCES.map((s) => {
              const on = sources.includes(s.value);
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSource(s.value)}
                  className={cn(
                    "h-9 rounded-full border px-3.5 font-mono text-[12.5px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737]",
                    on
                      ? "border-[#1E4737] bg-[#1E4737] text-[#f5f5f5]"
                      : "border-[#d4d4d4] bg-transparent text-[#525252] hover:border-[#171717] hover:text-[#171717]",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* 6b. The special-category question, before any tag (readiness-check mock, section 03) */}
        <fieldset ref={categoryRef} data-block="special-category">
          <legend className="mb-3 text-[15px] font-medium leading-snug text-[#171717]">
            {QUESTION}
          </legend>
          <div className="flex flex-wrap items-center gap-2">
            {[
              { value: false, label: NO },
              { value: true, label: YES },
            ].map((o) => {
              const on = category === o.value;
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setCategory(o.value)}
                  className={cn(
                    "h-9 rounded-full border px-4 font-mono text-[12.5px] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737]",
                    on
                      ? "border-[#1E4737] bg-[#1E4737] text-[#f5f5f5]"
                      : "border-[#d4d4d4] bg-transparent text-[#525252] hover:border-[#171717] hover:text-[#171717]",
                  )}
                >
                  {o.label}
                </button>
              );
            })}
            <details className="group ml-1 text-[13px]">
              <summary className="cursor-pointer list-none text-[#666666] underline decoration-dotted underline-offset-[3px] hover:text-[#171717] [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">{WHY_WE_ASK}</span>
                <span className="hidden group-open:inline">{HIDE}</span>
              </summary>
              <ul className="mt-2 rounded-[6px] border border-[#d4d4d4] bg-[#ffffff] px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-[#525252]">
                {WHY_LINES.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          </div>
          {attempted && category === null && (
            <p className="mt-1.5 text-[13.5px] leading-[1.45] text-[#9A3A22]">{ANSWER_FIRST}</p>
          )}
        </fieldset>

        {/* 7. Name + email */}
        <div className="grid gap-7 sm:grid-cols-2 sm:gap-4">
          <Field id={ids.name} label="Your name" error={errors.name}>
            <input
              id={ids.name}
              type="text"
              autoComplete="name"
              value={name}
              maxLength={LIMITS.name}
              onChange={(e) => {
                clearServer("name");
                setName(e.target.value);
              }}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy("name")}
              className={cn(fieldBase, fieldTone(errors.name), "h-12")}
            />
          </Field>
          <Field id={ids.email} label="Email" error={errors.email}>
            <input
              id={ids.email}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              maxLength={LIMITS.email}
              onChange={(e) => {
                clearServer("email");
                setEmail(e.target.value);
              }}
              aria-invalid={!!errors.email}
              aria-describedby={describedBy("email")}
              className={cn(fieldBase, fieldTone(errors.email), "h-12")}
            />
          </Field>
        </div>

        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
          <button
            type="submit"
            disabled={sending}
            className="h-12 w-full rounded-full bg-[#1E4737] px-7 text-[15px] font-medium text-[#f5f5f5] transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737] sm:w-auto"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <p className="text-[13px] leading-[1.45] text-[#666666]">
            Nothing about your visitors is asked or stored.
          </p>
        </div>
        {sendError && (
          <p role="alert" className="-mt-3 text-[13.5px] leading-[1.45] text-[#9A3A22]">
            {sendError}
          </p>
        )}
        <ApplyPrivacyNotice />
      </form>
    </Page>
  );
}

/** Under Send: what is done with the answers. The words are the operator's (src/hosted/). */
export function ApplyPrivacyNotice() {
  return (
    <p className="-mt-3 max-w-[34rem] text-[13px] leading-[1.55] text-[#666666]">
      <MailLinked
        text={APPLY_PRIVACY_NOTICE}
        address={PRIVACY_EMAIL}
        className="text-[#171717] underline decoration-[#d4d4d4] underline-offset-2 transition-colors duration-150 hover:decoration-[#171717]"
      />
    </p>
  );
}

// ── Done ────────────────────────────────────────────────────────────────

/**
 * "You're in." with the tag. The read already saw the platform and the
 * policy (install-friction G6), so the step names that platform and, when
 * the policy would block the tag, adds the lines as a second step. After a
 * reload the install facts are gone and the general step shows.
 */
export function DoneScreen({ kicker, done }: { kicker: string; done: Done }) {
  const install = done.install ?? null;
  const policy = donePolicy(install);

  // The tag withheld (readiness-check mock, A9): the mock's two sentences
  // where the tag would be, nothing else.
  if (done.withheld) {
    return (
      <Page kicker={kicker}>
        <div className="animate-fade-in" data-block="tag-held">
          <Headline>You&rsquo;re in.</Headline>
          <Lede>{YES_HELD_LINE}</Lede>
          <StepKicker n="01" title="The tag" />
          <p className="mt-3.5 rounded-[8px] border border-dashed border-[#d4d4d4] px-4 py-3.5 text-[14.5px] leading-[1.6] text-[#666666]">
            {TAG_WITH_NOTE}
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page kicker={kicker}>
      <div className="animate-fade-in">
        <Headline>You&rsquo;re in.</Headline>
        <Lede>{doneLede(install)}</Lede>

        {policy && install ? (
          <>
            <StepKicker n="01" title="The tag" />
            <StepText text={doneTagStep(install)} />
            <YourTag tag={done.tag} />

            <StepKicker n="02" title="Your security policy" />
            <StepText text={donePolicyStep(install)} />
            {policy === "write" ? (
              OPERATOR_EMAIL && (
                <p className="mt-2.5 text-[14.5px]">
                  <a
                    href={`mailto:${OPERATOR_EMAIL}`}
                    className="text-[#171717] underline decoration-dotted underline-offset-[3px]"
                  >
                    {OPERATOR_EMAIL}
                  </a>
                </p>
              )
            ) : (
              <>
                <DarkBlock
                  label={linesLabel(install.csp.lines.length, "")}
                  content={install.csp.lines.join("\n")}
                  highlight={[EDGE_MARK, HIDE_STYLE_HASH, `nonce="${NONCE_PLACEHOLDER}"`]}
                />
                {install.csp.where === "next_config" && (
                  <p className="mt-2.5 text-[13.5px] leading-[1.5] text-[#666666]">
                    If your policy lives in middleware.ts, change it there.
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="mt-5">
              <StepText text={doneTagStep(install)} />
            </div>
            <YourTag tag={done.tag} />
          </>
        )}
      </div>
    </Page>
  );
}

function StepKicker({ n, title }: { n: string; title: string }) {
  return (
    <div className="mt-8 flex items-baseline gap-2.5 border-t border-[#d4d4d4] pt-3.5">
      <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-[#666666]">
        {n}
      </span>
      <span className="text-[15px] font-medium text-[#171717]">{title}</span>
    </div>
  );
}

function StepText({ text }: { text: string }) {
  return (
    <p className="mt-1.5 text-[14.5px] leading-[1.6] text-[#525252]">
      <Codey text={text} />
    </p>
  );
}

/** The tag to copy; on a build without an edge address, the line that says so. */
function YourTag({ tag }: { tag: string }) {
  if (!isTag(tag)) {
    return (
      <p
        data-tag-unset
        className="mt-3.5 rounded-[8px] border border-dashed border-[#d4d4d4] px-4 py-3.5 text-[14.5px] leading-[1.6] text-[#666666]"
      >
        {tag}
      </p>
    );
  }
  return <DarkBlock label="Your tag" content={tag} />;
}

function DarkBlock({
  label,
  content,
  highlight = [],
}: {
  label: string;
  content: string;
  highlight?: string[];
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // non-secure context: the text stays selectable in the block
    }
  }

  // The added part of each line in a soft green, the rest as written.
  const parts: { add: boolean; text: string }[] = [];
  let rest = content;
  while (rest) {
    const hits = highlight
      .map((h) => ({ h, i: h ? rest.indexOf(h) : -1 }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i);
    const first = hits[0];
    if (!first) {
      parts.push({ add: false, text: rest });
      break;
    }
    if (first.i > 0) parts.push({ add: false, text: rest.slice(0, first.i) });
    parts.push({ add: true, text: first.h });
    rest = rest.slice(first.i + first.h.length);
  }

  return (
    <div className="mt-3.5 overflow-hidden rounded-[8px] bg-[#171717]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#a3a3a3]">
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="h-8 rounded-full border border-[#f5f5f5]/30 px-3.5 font-mono text-[12px] text-[#f5f5f5] transition-colors duration-150 hover:border-[#f5f5f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f5f5f5]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all px-4 py-4 font-mono text-[13px] leading-[1.6] text-[#f5f5f5]">
        {parts.map((p, i) =>
          p.add ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of one fixed string
            <span key={i} className="text-[#9fd3b5]">
              {p.text}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of one fixed string
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
