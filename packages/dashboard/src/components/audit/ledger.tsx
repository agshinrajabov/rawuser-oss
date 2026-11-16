"use client";

/**
 * The quiet ledger for the audit's public pages (the sign-up and the report),
 * the paper /apply already runs on (ApplyFlow.tsx, ADR 0027 amended): whitish
 * grey ground, ink, hairlines, one green, clay for refusals. Local to these
 * pages; the dashboard keeps its own tokens (ADR 0014).
 */

import { DPA_URL, PRIVACY_EMAIL } from "@/lib/identity";
import { isTemplate, templateParts } from "@/lib/template-view";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

export const PAPER = "#f5f5f5";

export const Q = {
  ground: "bg-[#f5f5f5]",
  ink: "text-[#171717]",
  muted: "text-[#525252]",
  faint: "text-[#666666]",
  line: "border-[#d4d4d4]",
  clay: "text-[#9A3A22]",
} as const;

/** The paper reaches the overscroll edges too, not only the column. */
export function usePaper() {
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = PAPER;
    return () => {
      document.body.style.background = prev;
    };
  }, []);
}

export function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#666666]">
      {children}
    </p>
  );
}

export function LedgerColumn({
  kicker,
  children,
}: {
  kicker: string;
  children: React.ReactNode;
}) {
  usePaper();
  return (
    <main className="min-h-dvh bg-[#f5f5f5] text-[#171717] antialiased selection:bg-[#1E4737] selection:text-[#f5f5f5]">
      <div className="mx-auto w-full max-w-[36rem] px-4 pb-24 pt-9 sm:px-6 sm:pt-14">
        <Kicker>{kicker}</Kicker>
        {children}
      </div>
    </main>
  );
}

export function LedgerHeadline({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mt-5 text-[2rem] font-medium leading-[1.06] tracking-[-0.025em] text-[#171717] [text-wrap:balance] sm:text-[2.5rem]">
      {children}
    </h1>
  );
}

export function LedgerLede({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 max-w-[32rem] text-[15.5px] leading-[1.6] text-[#525252] sm:text-[16.5px]">
      {children}
    </p>
  );
}

/** A whole-page message: used, expired, unreachable. */
export function LedgerMessage({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <LedgerColumn kicker={kicker}>
      <div className="animate-fade-in">
        <LedgerHeadline>{title}</LedgerHeadline>
        <LedgerLede>{body}</LedgerLede>
      </div>
    </LedgerColumn>
  );
}

export const greenButton =
  "inline-flex h-12 items-center justify-center rounded-full bg-[#1E4737] px-7 text-[15px] font-medium text-[#f5f5f5] transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737]";

export const ledgerLink =
  "text-[#171717] underline decoration-[#d4d4d4] underline-offset-[3px] transition-colors duration-150 hover:decoration-[#171717]";

/**
 * The report's words for a part: `*phrase*` in italic as the page shows its
 * emphasis, a word-split template as its words (a ring for an image, styled
 * words faint, the rotating word dotted with its alternatives on hover).
 * Never a token or an asterisk.
 */
export function LedgerMarked({ text }: { text: string }) {
  if (isTemplate(text)) {
    return (
      <>
        {templateParts(text).map((p, i) => {
          // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
          if (p.kind === "br") return <br key={i} />;
          if (p.kind === "glyph")
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
                key={i}
                aria-hidden="true"
                title="an image on the page"
                className="mx-[0.1em] inline-block size-[0.6em] rounded-full border-2 border-current align-[-0.02em] opacity-50"
              />
            );
          if (p.kind === "rot")
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
                key={i}
                title={p.alts.join(" · ")}
                className={cn(
                  "underline decoration-dotted decoration-2 underline-offset-[5px]",
                  p.styled && "text-[#666666]",
                )}
              >
                {p.alts[0]}
              </span>
            );
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parse of one string
            <span key={i} className={p.styled ? "text-[#666666]" : undefined}>
              {p.text}
            </span>
          );
        })}
      </>
    );
  }
  const parts = text.split(/(\*[^*\n]{1,80}\*)/);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <em key={i} className="italic">
            {part.slice(1, -1)}
          </em>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{part.replace(/\*/g, "")}</span>
        ),
      )}
    </>
  );
}

/** A literal as a pattern: every character that means something to one is escaped. */
function literal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * What a legal sentence may hold besides words: `**bold**`, `code`, and the
 * two addresses this install was built with (lib/identity.ts), where set.
 */
const INLINE = new RegExp(
  `(${[
    String.raw`\*\*[^*]+\*\*`,
    "`[^`]+`",
    ...[PRIVACY_EMAIL, DPA_URL].flatMap((a) => (a ? [literal(a)] : [])),
  ].join("|")})`,
);

/**
 * A legal sentence as the documents write it: `**bold**` set in ink,
 * `code` in mono, the privacy address and the DPA's address as links (the
 * DPA's to this host's own /audit/dpa/, so a preview stays on its host).
 */
export function LedgerInline({ text }: { text: string }) {
  return (
    <>
      {text.split(INLINE).map((p, i) => {
        if (!p) return null;
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one sentence
            <strong key={i} className="font-medium text-[#171717]">
              {p.slice(2, -2)}
            </strong>
          );
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one sentence
            <code key={i} className="font-mono text-[0.9em] text-[#171717]">
              {p.slice(1, -1)}
            </code>
          );
        if (PRIVACY_EMAIL && p === PRIVACY_EMAIL)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one sentence
            <a key={i} href={`mailto:${PRIVACY_EMAIL}`} className={ledgerLink}>
              {p}
            </a>
          );
        if (DPA_URL && p === DPA_URL)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one sentence
            <a key={i} href="/audit/dpa/" className={ledgerLink}>
              {p}
            </a>
          );
        // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one sentence
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
