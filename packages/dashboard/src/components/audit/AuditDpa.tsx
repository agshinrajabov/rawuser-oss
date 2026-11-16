"use client";

/**
 * /audit/dpa/: the data processing agreement the audit terms' term 2 makes
 * part of the audit (docs/specs/ai-traffic-audit.md §8, the privacy review's
 * condition before audit invites go on). The words are the operator's
 * (src/hosted/dpa-text.ts); while they still hold a "[" placeholder the page
 * says so at the top.
 */

import { DPA } from "@/hosted/dpa-text";
import { cn } from "@/lib/utils";
import { Kicker, LedgerInline, usePaper } from "./ledger";
import { type DpaBlock, isDraft } from "./legal-blocks";

export const DRAFT_NOTICE = "Draft. Not yet in force.";

const body = "text-[14.5px] leading-[1.65] text-[#525252]";

const listStyle = {
  bullet: "list-disc",
  number: "list-decimal",
  alpha: "list-[lower-alpha]",
} as const;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function Block({ b, afterRule }: { b: DpaBlock; afterRule: boolean }) {
  switch (b.kind) {
    case "title":
      return (
        <h1 className="mt-5 text-[2rem] font-medium leading-[1.06] tracking-[-0.025em] text-[#171717] [text-wrap:balance] sm:text-[2.5rem]">
          {b.text}
        </h1>
      );
    case "note":
      return (
        <p className={cn(body, "mt-6 border-l-2 border-[#d4d4d4] pl-4")}>
          <LedgerInline text={b.text} />
        </p>
      );
    case "h2":
      return (
        <h2
          id={slug(b.text)}
          className={cn(
            "scroll-mt-6 pt-5 text-[16px] font-medium tracking-[-0.01em] text-[#171717]",
            afterRule ? "mt-14 border-t-2 border-[#171717]" : "mt-10 border-t border-[#d4d4d4]",
          )}
        >
          {b.text}
        </h2>
      );
    case "h3":
      return <h3 className="mt-6 text-[14.5px] font-medium text-[#171717]">{b.text}</h3>;
    case "p":
      return (
        <p className={cn(body, "mt-3")}>
          <LedgerInline text={b.text} />
        </p>
      );
    case "clause":
      return (
        <p className={cn(body, "mt-3 grid grid-cols-[2.75rem_1fr] gap-x-1")}>
          <span className="pt-[0.2em] font-mono text-[12px] tabular-nums text-[#666666]">
            {b.num}
          </span>
          <span>
            <LedgerInline text={b.text} />
          </span>
        </p>
      );
    case "list":
      return (
        <ol
          className={cn(
            body,
            listStyle[b.style],
            "mt-2 space-y-1.5 pl-5 marker:text-[#666666]",
            b.style === "alpha" && "ml-[2.75rem]",
          )}
        >
          {b.items.map((it) => (
            <li key={it.text} className="pl-1">
              <LedgerInline text={it.text} />
              {it.sub && (
                <ul className="mt-1.5 list-disc space-y-1.5 pl-5 marker:text-[#666666]">
                  {it.sub.map((s) => (
                    <li key={s} className="pl-1">
                      <LedgerInline text={s} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13.5px] leading-[1.55]">
            <thead>
              <tr className="border-b border-[#171717]/70">
                {b.head.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed header row
                  <th key={i} className="py-2 pr-4 font-medium text-[#171717]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows of a document
                <tr key={ri} className="border-b border-[#d4d4d4] align-top">
                  {r.map((c, ci) => (
                    <td
                      key={b.head[ci] || "row"}
                      className={cn(
                        "py-2.5 pr-4 text-[#525252]",
                        ci === 0 && "text-[#171717]",
                        !c && "h-11",
                      )}
                    >
                      <LedgerInline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      // The annexes start under a heavier rule, drawn by the heading below.
      return null;
  }
}

export function AuditDpaView({ blocks = DPA }: { blocks?: DpaBlock[] }) {
  usePaper();
  return (
    <main className="min-h-dvh bg-[#f5f5f5] text-[#171717] antialiased selection:bg-[#1E4737] selection:text-[#f5f5f5]">
      <article className="mx-auto w-full max-w-[40rem] px-4 pb-24 pt-9 sm:px-6 sm:pt-14">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Kicker>Rawuser · free audit</Kicker>
          {isDraft(blocks) && (
            <p
              data-draft-notice
              className="rounded-full border border-[#9A3A22]/35 px-2.5 py-0.5 text-[12px] font-medium text-[#9A3A22]"
            >
              {DRAFT_NOTICE}
            </p>
          )}
        </div>
        {blocks.map((b, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the document's fixed order
          <Block key={i} b={b} afterRule={blocks[i - 1]?.kind === "hr"} />
        ))}
      </article>
    </main>
  );
}
