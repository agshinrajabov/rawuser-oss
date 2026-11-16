"use client";

/**
 * The frozen audit report (docs/specs/ai-traffic-audit.md §5; mock sections
 * 05 to 09). One view for the public page, the signed-in page and the
 * founder's review. Every number is the snapshot's own: counts with their
 * floors, shares only where the API gave one. No contact, no row, no marker.
 *
 * Print: white paper, the three disclosures open, no button (a line in its
 * place), bars kept with print-color-adjust, each block whole across a page
 * break, and a footer with the domain, the window and the page number.
 */

import {
  type Answer,
  GROUP_LABEL,
  GROUP_SWATCH,
  LANDING_LABEL,
  aiAnswer,
  barWidth,
  cannotSee,
  countCell,
  dayMonth,
  groupSub,
  howSure,
  howWeCount,
  inAppAnswer,
  lastLine,
  noReferrerAnswer,
  num,
  pilotMailto,
  printFooter,
  rangeLabel,
  resultAxis,
  resultRange,
  sampleTitle,
  shareWord,
  signed,
  testLineView,
  versionsAtStartLine,
  versionsNote,
} from "@/lib/audit";
import { cn } from "@/lib/utils";
import type { AuditLandingList, AuditReport, AuditSample, AuditSamplePart } from "@rawuser/shared";
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { LedgerMarked, greenButton } from "./ledger";

const HATCH = "repeating-linear-gradient(135deg,#8a8a8a 0 2px,transparent 2px 4px)";
const HATCH_LIGHT = "repeating-linear-gradient(135deg,#a3a3a3 0 2px,transparent 2px 4px)";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SectionHead({ n, title, would }: { n: number; title: string; would?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 border-t border-[#d4d4d4] pt-3.5">
      <b className="font-mono text-[11px] font-medium tracking-[0.14em] text-[#666666]">{two(n)}</b>
      <h2 className="text-[16px] font-medium tracking-[-0.01em] text-[#171717]">
        {title}
        {would && (
          <span className="ml-2.5 inline-flex h-5 items-center rounded-full border border-dashed border-[#666666] px-2 align-[2px] font-mono text-[10.5px] tracking-[0.06em] text-[#525252]">
            would see
          </span>
        )}
      </h2>
    </div>
  );
}

function Bar({ parts }: { parts: NonNullable<Answer["bar"]> }) {
  return (
    <div
      className="mt-3.5 flex h-1.5 max-w-[520px] overflow-hidden rounded-full bg-[#e7e7e7] [print-color-adjust:exact]"
      aria-hidden
    >
      {parts.map((p, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of one or two parts
          key={i}
          className="block h-full"
          style={{ width: `${p.width}%`, background: p.hatched ? HATCH : "#171717" }}
        />
      ))}
    </div>
  );
}

function AnswerRow({ n, a }: { n: number; a: Answer }) {
  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-2 border-b border-[#d4d4d4] pb-[22px] pt-5 break-inside-avoid sm:grid-cols-[44px_minmax(0,1fr)] print:py-3.5">
      <span className="pt-[7px] font-mono text-[11px] text-[#666666]">{two(n)}</span>
      <div>
        <p className="text-[19px] font-medium leading-[1.28] tracking-[-0.018em] [text-wrap:balance] sm:text-[23px] print:text-[18px]">
          {a.title}
        </p>
        {a.sub && (
          <p className="mt-1.5 text-[14px] tabular-nums text-[#525252] sm:text-[15px]">{a.sub}</p>
        )}
        {a.bar && <Bar parts={a.bar} />}
        {a.key && (
          <p className="mt-1.5 flex flex-wrap gap-3.5 text-[12px] text-[#666666]">
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block h-1.5 w-2.5 rounded-[2px] bg-[#171717]" />
              we could name
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i
                className="inline-block h-1.5 w-2.5 rounded-[2px] border border-[#8a8a8a]"
                style={{ background: HATCH }}
              />
              probably
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function partText(p: AuditSamplePart, side: "page" | "version"): string | null {
  if (side === "page") return p.template ?? p.page;
  return p.version;
}

function SampleCard({ sample, side }: { sample: AuditSample; side: "page" | "version" }) {
  const ver = side === "version";
  const h = partText(sample.headline, side);
  const b = partText(sample.body, side);
  const c = partText(sample.cta, side);
  return (
    <div
      className={cn(
        "min-w-0 rounded-[8px] border px-[18px] pb-5 pt-[18px] sm:px-[22px] sm:pb-6 sm:pt-[22px]",
        ver
          ? "border-[#1E4737] bg-white shadow-[inset_0_3px_0_#1E4737] print:border-[1.5px] print:shadow-none"
          : "border-[#d4d4d4]",
      )}
    >
      <p
        className={cn(
          "mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.14em]",
          ver ? "text-[#1E4737]" : "text-[#666666]",
        )}
      >
        {ver ? "Their version" : "Your page"}
      </p>
      {h && (
        <p className="text-[21px] font-semibold leading-[1.2] tracking-[-0.02em] [text-wrap:balance] sm:text-[24px] print:text-[19px]">
          <LedgerMarked text={h} />
        </p>
      )}
      {b && (
        <p className="mt-2.5 text-[14.5px] leading-[1.55] text-[#525252]">
          <LedgerMarked text={b} />
        </p>
      )}
      {c && (
        <span className="mt-4 inline-block rounded-full bg-[#171717] px-3.5 py-2 text-[13px] font-medium text-[#f5f5f5] [print-color-adjust:exact]">
          <LedgerMarked text={c} />
        </span>
      )}
    </div>
  );
}

function Sample({ n, sample }: { n: number; sample: AuditSample }) {
  return (
    <section className="mt-10 sm:mt-[52px] break-inside-avoid print:mt-8">
      <SectionHead n={n} title={sampleTitle(sample)} would={sample.form === "would_see"} />
      <div className="mt-[18px] grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SampleCard sample={sample} side="page" />
        <SampleCard sample={sample} side="version" />
      </div>
      <p className="mt-3 text-[13.5px] text-[#666666]">{versionsNote(sample.versions_total)}</p>
    </section>
  );
}

function Groups({ n, report }: { n: number; report: AuditReport }) {
  const full = report.state === "full";
  const cols = full
    ? "grid-cols-[minmax(0,1fr)_56px_44px] gap-2.5 sm:grid-cols-[minmax(0,1fr)_84px_64px] sm:gap-4"
    : "grid-cols-[minmax(0,1fr)_92px] gap-2.5 sm:grid-cols-[minmax(0,1fr)_120px] sm:gap-4";
  const barParts = full ? report.groups.filter((g) => g.share) : [];
  return (
    <section className="mt-10 sm:mt-[52px] break-inside-avoid print:mt-8">
      <SectionHead n={n} title="Where every visit came from" />
      {barParts.length > 0 && (
        <div className="mt-5 flex h-3 gap-[2px] [print-color-adjust:exact]" aria-hidden>
          {barParts.map((g) => (
            <i
              key={g.key}
              className="block h-full first:rounded-l-[2px] last:rounded-r-[2px]"
              style={{
                flex: g.share ? barWidth(g.share) : 0,
                background: GROUP_SWATCH[g.key] ?? HATCH_LIGHT,
                border: GROUP_SWATCH[g.key] ? undefined : "1px solid #a3a3a3",
              }}
            />
          ))}
        </div>
      )}
      <div className="mt-4 border-t border-[#d4d4d4]">
        <div
          className={cn(
            "grid py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#666666]",
            cols,
          )}
        >
          <span>Group</span>
          <span className="text-right">Visits</span>
          {full && <span className="text-right">Share</span>}
        </div>
        {report.groups.map((g) => {
          const sub = groupSub(g);
          const cell = countCell(g.visits);
          return (
            <div
              key={g.key}
              className={cn(
                "grid items-start border-t border-[#d4d4d4] py-3 text-[14px] sm:text-[14.5px] print:py-2 print:text-[13px]",
                cols,
              )}
            >
              <span className="flex min-w-0 items-start gap-3">
                {full && (
                  <span
                    aria-hidden
                    className="mt-1.5 size-2.5 flex-none rounded-[2px] [print-color-adjust:exact]"
                    style={{
                      background: GROUP_SWATCH[g.key] ?? HATCH_LIGHT,
                      border: GROUP_SWATCH[g.key] ? undefined : "1px solid #a3a3a3",
                    }}
                  />
                )}
                <span className="min-w-0">
                  <b className="font-medium">{GROUP_LABEL[g.key]}</b>
                  {sub && (
                    <span className="mt-0.5 block text-[13px] tabular-nums text-[#666666]">
                      {sub}
                    </span>
                  )}
                </span>
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-right tabular-nums",
                  typeof g.visits === "number" && g.visits > 0
                    ? "font-mono text-[13.5px]"
                    : "text-[13px] text-[#525252]",
                )}
              >
                {cell}
              </span>
              {full && (
                <span className="whitespace-nowrap text-right font-mono text-[13.5px] tabular-nums">
                  {g.share ? shareWord(g.share) : ""}
                </span>
              )}
            </div>
          );
        })}
        <div className={cn("grid border-t border-[#171717] py-3 font-medium", cols)}>
          <span>All visits</span>
          <span className="text-right font-mono text-[13.5px] tabular-nums">
            {num(report.visits)}
          </span>
          {full && <span className="text-right font-mono text-[13.5px]">100%</span>}
        </div>
      </div>
    </section>
  );
}

function LandingList({ title, list }: { title: string; list: AuditLandingList }) {
  const empty = list.pages.length === 0 && list.other === 0;
  return (
    <div className="min-w-0">
      <h3 className="border-b border-[#171717] pb-2 text-[14px] font-medium">
        {title}
        <span className="ml-1.5 font-mono text-[12px] font-normal text-[#666666]">
          {countCell(list.visits)}
        </span>
      </h3>
      <ul>
        {list.pages.map((p) => (
          <li
            key={p.path}
            className="flex justify-between gap-3 border-b border-[#d4d4d4] py-[7px] text-[13px]"
          >
            <span className="min-w-0 truncate font-mono text-[12.5px]">{p.path}</span>
            <span className="font-mono text-[12.5px] text-[#525252]">{num(p.visits)}</span>
          </li>
        ))}
        {list.other !== 0 && (
          <li className="flex justify-between gap-3 border-b border-[#d4d4d4] py-[7px] text-[13px]">
            <span className="text-[#666666]">other pages</span>
            <span className="font-mono text-[12.5px] text-[#525252]">{countCell(list.other)}</span>
          </li>
        )}
        {empty && (
          <li className="border-b border-[#d4d4d4] py-[7px] text-[13px] text-[#666666]">
            None seen
          </li>
        )}
      </ul>
    </div>
  );
}

function Landing({ n, landing }: { n: number; landing: NonNullable<AuditReport["landing"]> }) {
  return (
    <section className="mt-10 sm:mt-[52px] break-inside-avoid print:mt-8">
      <SectionHead n={n} title="Where they landed" />
      <div className="mt-[18px] grid grid-cols-1 gap-[22px] sm:grid-cols-3 sm:gap-6">
        <LandingList title={LANDING_LABEL.ai} list={landing.ai} />
        <LandingList title={LANDING_LABEL.no_referrer} list={landing.no_referrer} />
        <LandingList title={LANDING_LABEL.all} list={landing.all} />
      </div>
      <p className="mt-3 text-[13.5px] text-[#666666]">
        A page shows with 5 visits or more in its group.
      </p>
    </section>
  );
}

function VersionsDid({ n, report }: { n: number; report: AuditReport }) {
  const line = report.versions_did;
  const v = testLineView(line);
  const atStart = versionsAtStartLine(report);
  return (
    <section className="mt-10 sm:mt-[52px] break-inside-avoid print:mt-8">
      <SectionHead n={n} title="What the versions did" />
      {line.state === "result" ? (
        <ResultBlock line={line} />
      ) : (
        <>
          <p className="mt-4 max-w-[40em] text-[16px] font-medium leading-[1.45] tracking-[-0.01em] [text-wrap:pretty] sm:text-[18px] print:text-[15px]">
            {v.lead}
            {v.rest && <span className="font-normal text-[#525252]"> {v.rest}</span>}
          </p>
          {v.weeks !== null && (
            <div className="mt-4 max-w-[520px] print:hidden" aria-hidden>
              <div
                className="grid gap-[3px]"
                style={{ gridTemplateColumns: `repeat(${v.weeks}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: v.weeks }, (_, i) => (
                  <i
                    // biome-ignore lint/suspicious/noArrayIndexKey: one cell per week
                    key={i}
                    className={cn(
                      "block h-1.5 rounded-[1px]",
                      i === 0 ? "bg-[#171717]" : "bg-[#e2e2e2]",
                    )}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex justify-between font-mono text-[11px] text-[#666666]">
                <span>this week</span>
                <span>about week {v.weeks}</span>
              </div>
            </div>
          )}
        </>
      )}
      {atStart && <p className="mt-3 text-[13.5px] text-[#666666]">{atStart}</p>}
    </section>
  );
}

function ResultBlock({
  line,
}: { line: Extract<AuditReport["versions_did"], { state: "result" }> }) {
  const r = resultRange(line.lift);
  const ax = resultAxis(line.lift);
  return (
    <div className="mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:gap-7">
      <div>
        <p className="text-[16px] font-medium leading-[1.45] tracking-[-0.01em] sm:text-[18px]">
          {line.sentence}
        </p>
        <p className="mt-1.5 text-[13.5px] text-[#666666]">{r.note}</p>
      </div>
      <div>
        <p className="font-mono text-[34px] font-semibold leading-none tracking-[-0.02em] text-[#1E4737]">
          {signed(line.lift.value)}
        </p>
        <p className="mt-1.5 font-mono text-[12px] text-[#525252]">{r.range}</p>
        <div className="relative mt-3 h-[18px] [print-color-adjust:exact]" aria-hidden>
          <span className="absolute inset-x-0 top-2 h-0.5 bg-[#e2e2e2]" />
          <span
            className="absolute top-[5px] h-2 rounded-[2px] bg-[color-mix(in_srgb,#1E4737_25%,transparent)]"
            style={{
              left: `${ax.at(line.lift.low)}%`,
              width: `${ax.at(line.lift.high) - ax.at(line.lift.low)}%`,
            }}
          />
          <span
            className="absolute bottom-0.5 top-0.5 w-px bg-[#666666]"
            style={{ left: `${ax.at(0)}%` }}
          />
          <span
            className="absolute bottom-0.5 top-0.5 -ml-px w-0.5 bg-[#1E4737]"
            style={{ left: `${ax.at(line.lift.value)}%` }}
          />
        </div>
        <div className="relative h-3.5 font-mono text-[10px] text-[#666666]" aria-hidden>
          <span className="absolute left-0">{signed(ax.min)}</span>
          <span className="absolute -translate-x-1/2" style={{ left: `${ax.at(0)}%` }}>
            0
          </span>
          <span className="absolute right-0">{signed(ax.max)}</span>
        </div>
      </div>
    </div>
  );
}

/** A disclosure that prints open: a button and a region, never a native <details>. */
function Disclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-b border-[#d4d4d4] first:border-t break-inside-avoid">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 py-3.5 text-left text-[15px] font-medium text-[#171717] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E4737] print:pb-1 print:pt-2.5 print:text-[14px]"
      >
        {title}
        <Plus
          size={16}
          aria-hidden
          className={cn(
            "flex-none text-[#666666] transition-transform duration-200 ease-smooth motion-reduce:transition-none print:hidden",
            open && "rotate-45",
          )}
        />
      </button>
      <div id={id} className={cn("pb-3.5", open ? "block" : "hidden print:block")}>
        {children}
      </div>
    </div>
  );
}

function Bullets({ items }: { items: { text: React.ReactNode; strong?: boolean; key: string }[] }) {
  return (
    <ul>
      {items.map((it) => (
        <li
          key={it.key}
          className={cn(
            "relative py-[5px] pl-[18px] text-[14px] leading-[1.55] before:absolute before:left-0.5 before:top-[14px] before:h-px before:w-1.5 before:bg-[#666666] print:py-[3px] print:text-[12.5px] print:before:top-[11px]",
            it.strong ? "text-[#171717]" : "text-[#525252]",
          )}
        >
          {it.text}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportViewProps {
  report: AuditReport;
  /** Open every disclosure (the fixtures; print opens them by itself). */
  openAll?: boolean;
  /** Outside the founder's review: the page's own print footer. */
  standalone?: boolean;
}

export function ReportView({ report, openAll = false, standalone = true }: ReportViewProps) {
  const tooFew = report.state === "too_few";
  const answers = report.answers;
  let n = 0;
  const next = () => {
    n += 1;
    return n;
  };
  const last = lastLine(report);
  const pilot = pilotMailto(report.domain);
  const sure = howSure(report);
  const footer = printFooter(report);

  return (
    <article className="mx-auto max-w-[48rem] px-4 pb-11 pt-9 text-[#171717] sm:px-8 sm:pb-16 sm:pt-14 print:max-w-none print:p-0">
      {standalone && (
        <style>{`@media print{@page{size:auto;margin:18mm 18mm 20mm;@bottom-left{content:${JSON.stringify(footer)};font:10px ui-monospace,Menlo,monospace;color:#666}@bottom-right{content:counter(page) " of " counter(pages);font:10px ui-monospace,Menlo,monospace;color:#666}}html,body{background:#fff!important}}`}</style>
      )}
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[#666666]">
        Rawuser · audit report
      </p>
      <h1 className="mt-[18px] text-[31px] font-medium leading-[1.05] tracking-[-0.028em] [text-wrap:balance] sm:text-[42px] print:text-[32px]">
        Where your visits came from
      </h1>
      <p className="mt-3.5 flex flex-wrap gap-y-1 font-mono text-[12px] text-[#525252] sm:text-[12.5px]">
        <span>{report.domain}</span>
        <span className="before:px-2.5 before:text-[#d4d4d4] before:content-['·']">
          {rangeLabel(report.window.start, report.window.end)}
        </span>
        <span className="before:px-2.5 before:text-[#d4d4d4] before:content-['·']">
          {num(report.visits)} visits
        </span>
      </p>
      {report.state === "counts" && (
        <p className="mt-5 text-[16px] leading-[1.5]">
          Too few visits for shares. Here is what we saw.
        </p>
      )}

      <div className="mt-9 border-t border-[#171717] print:mt-6">
        {tooFew || !answers ? (
          <AnswerRow
            n={next()}
            a={{
              title: `We saw ${num(report.visits)} visits. Too few to say anything.`,
              sub: null,
              bar: null,
            }}
          />
        ) : (
          <>
            <AnswerRow n={next()} a={aiAnswer(answers.ai)} />
            <AnswerRow n={next()} a={inAppAnswer(answers.in_app)} />
            <AnswerRow n={next()} a={noReferrerAnswer(answers.no_referrer)} />
          </>
        )}
      </div>

      {report.sample && <Sample n={next()} sample={report.sample} />}
      {!tooFew && report.groups.length > 0 && <Groups n={next()} report={report} />}
      {!tooFew && report.landing && <Landing n={next()} landing={report.landing} />}
      <VersionsDid n={next()} report={report} />

      <div className="mt-10 sm:mt-[52px] print:mt-8">
        <Disclosure title="What this cannot see" defaultOpen={openAll}>
          <Bullets
            items={cannotSee(report).map((l) => ({ key: l.text, text: l.text, strong: l.banner }))}
          />
        </Disclosure>
        <Disclosure title="How we count" defaultOpen={openAll}>
          <Bullets items={howWeCount(report).map((t) => ({ key: t, text: t }))} />
        </Disclosure>
        {sure.length > 0 && (
          <Disclosure title="How sure" defaultOpen={openAll}>
            <p className="pb-1 text-[13.5px] text-[#666666]">
              Each share could be a little higher or lower. These are the 95% ranges.
            </p>
            <Bullets
              items={sure.map((s) => ({
                key: s.label,
                text: (
                  <>
                    {s.label}: between{" "}
                    <span className="font-mono text-[13px] text-[#171717]">{s.low}%</span> and{" "}
                    <span className="font-mono text-[13px] text-[#171717]">{s.high}%</span>.
                  </>
                ),
              }))}
            />
          </Disclosure>
        )}
      </div>

      <div className="mt-10 border-t border-[#171717] pt-7 break-inside-avoid sm:mt-[52px] print:mt-8 print:pt-[18px]">
        <p className="max-w-[30em] text-[19px] font-medium leading-[1.35] tracking-[-0.015em] [text-wrap:balance] sm:text-[22px] print:text-[17px]">
          {last.lead} <span className="font-normal text-[#525252]">{last.rest}</span>
        </p>
        {pilot && (
          <a
            href={pilot}
            className={cn(greenButton, "mt-5 flex w-full sm:inline-flex sm:w-auto print:hidden")}
          >
            Talk about a pilot
          </a>
        )}
        <p
          className={
            pilot
              ? "mt-2.5 hidden text-[13px] text-[#525252] print:block"
              : "mt-2.5 text-[13px] text-[#525252]"
          }
        >
          To talk about a pilot, reply to the email this report came with.
        </p>
      </div>
      <p className="mt-10 font-mono text-[11px] leading-[1.6] text-[#666666] print:hidden">
        Counted by the Rawuser tag on pages that carry it. Built {dayMonth(report.built_at)}.
      </p>
    </article>
  );
}
