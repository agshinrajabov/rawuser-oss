"use client";

import { TrafficLine } from "@/components/readiness/TrafficLine";
import { TINT } from "@/components/start/tones";
import {
  CARD_SUB_COUNTED,
  type CountedLine,
  HIDE,
  ON_VERSIONED_LEAD,
  WHY_LINES,
  WHY_TWO_LINES,
  secondLine,
  showsCountedList,
  showsSecondLine,
} from "@/lib/page-groups";
import {
  type Figure,
  type Ink,
  SOURCE_DOMAIN,
  type Strip,
  afterLine,
  armRows,
  axisPos,
  axisTicks,
  bySourceOpen,
  cardSub,
  closedDaysLine,
  figureFor,
  heldBackBox,
  howItWorks,
  num,
  pillFor,
  rate1,
  signed,
  sourceName,
  timelineFor,
} from "@/lib/proof";
import type { ReadinessCheck } from "@/lib/readiness";
import { limitsShort, numbersLine } from "@/lib/results";
import { cn } from "@/lib/utils";
import type { LiftReport, SourceRow } from "@/types/api";
import { Check, ChevronDown, TriangleAlert } from "lucide-react";
import { useState } from "react";

/**
 * "What the versions did" (docs/specs/proof-engine.md D and G; mock
 * design/mock/sales-readiness/proof-engine.html, approved 2026-10-04).
 * First on /analytics, under the page's headline (results-page.html,
 * approved 2026-10-04): the headline carries the answer, so the card keeps
 * only its numbers line on the left and the number behind it on the right.
 * The first limit sits under the card in every state; the rest of the
 * method is under How this works.
 */

const INK: Record<Ink, string> = {
  ok: "color-mix(in srgb, var(--state-success) 70%, black)",
  err: "color-mix(in srgb, var(--state-err) 85%, black)",
  muted: "var(--fg-muted)",
  fg: "var(--fg)",
};

const DOT: Record<Ink, string> = {
  ok: "var(--state-success)",
  err: "var(--state-err)",
  muted: "var(--fg-muted)",
  fg: "var(--fg)",
};

const BAND: Record<Strip["band"], React.CSSProperties> = {
  solid: { background: "color-mix(in srgb, var(--fg) 16%, transparent)" },
  ok: { background: "color-mix(in srgb, var(--state-success) 30%, transparent)" },
  err: { background: "color-mix(in srgb, var(--state-err) 28%, transparent)" },
  moving: {
    background:
      "repeating-linear-gradient(135deg, color-mix(in srgb, var(--fg) 14%, transparent) 0 3px, transparent 3px 6px)",
    border: "1px dashed var(--border-strong)",
  },
};

interface ProofCardProps {
  report: LiftReport;
  superadmin: boolean;
  /**
   * The counted buttons, one row each under the title (page-groups mock,
   * A16). Absent or empty: the card is as it was.
   */
  counted?: CountedLine[];
  /**
   * The day-3 traffic line under the counted buttons (readiness-check mock,
   * A14 and A15): the readiness check `traffic` once it says something.
   * Absent: the card is as it was.
   */
  traffic?: ReadinessCheck | null;
  /** The screen's own handler for the traffic line's action, else the API's href. */
  onTrafficAction?: (() => void) | null;
}

/**
 * The operator rows (holdout, checks, the draft, the rebuilds) live in the
 * Admin section at the page's foot since the measure-setup mock; the card
 * is the same for a customer and a superadmin.
 */
export function ProofCard({
  report,
  superadmin,
  counted = [],
  traffic = null,
  onTrafficAction = null,
}: ProofCardProps) {
  const [howOpen, setHowOpen] = useState(false);
  const pill = pillFor(report);
  const numbers = numbersLine(report);
  const arms = armRows(report);
  const figure = figureFor(report);
  const timeline = timelineFor(report);
  const after = afterLine(report, superadmin);
  const held = heldBackBox(report);
  const closed = closedDaysLine(report);
  const list = showsCountedList(counted);
  // Sign-off note 3, as drawn: the second line shows only once a group or a
  // site-wide button counts (the rehearsal on measure-lab showed it before).
  const second = showsSecondLine(counted) ? secondLine(report) : null;

  return (
    <section aria-labelledby="proof-title">
      <div className="rounded-md border border-border bg-surface">
        <div className="flex flex-col-reverse items-start gap-2.5 px-4 pt-4 sm:flex-row sm:justify-between sm:gap-4 sm:px-5">
          <div className="min-w-0">
            <h3 id="proof-title" className="text-[13px] font-semibold text-fg">
              {report.title}
            </h3>
            <p className="mt-0.5 text-xs text-fg-muted">
              {list ? CARD_SUB_COUNTED : cardSub(report)}
            </p>
            {list && (
              <ul
                className="mt-2 flex flex-col gap-[3px] text-xs text-fg-muted"
                data-list="counted"
              >
                {counted.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-2">
                    <span
                      aria-hidden
                      className="relative -top-0.5 h-[5px] w-[5px] flex-none rounded-full bg-fg-faint"
                    />
                    <span>
                      <b className="font-medium text-fg">“{c.label}”</b> {c.where}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <StatePill tone={pill.tone} text={pill.text} live={pill.live} icon={pill.icon} />
        </div>

        {traffic && (
          <TrafficLine
            check={traffic}
            onAction={onTrafficAction}
            className="mx-4 mt-3.5 border-t border-border pt-3 sm:mx-5"
          />
        )}

        <div
          className={cn(
            "grid grid-cols-1 gap-6 px-4 pb-[18px] pt-3.5 sm:px-5",
            figure && "min-[1100px]:grid-cols-[minmax(0,1fr)_300px] min-[1100px]:gap-10",
          )}
        >
          <div className="min-w-0">
            {/* The bars and the figure carry these numbers; the line stands in only without them. */}
            {numbers && !arms && (
              <p className="font-mono text-[12.5px] tabular-nums text-fg-muted">{numbers}</p>
            )}

            {held && (
              <>
                <div
                  className={cn(
                    "max-w-[70ch] rounded-sm px-3 py-2.5 text-[13px] leading-normal",
                    TINT.warn,
                  )}
                >
                  {held.text}
                </div>
                <dl className="mt-3.5 grid w-max grid-cols-[auto_auto] gap-x-[18px] gap-y-1 font-mono text-xs text-fg-muted">
                  {held.rows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt>{k}</dt>
                      <dd className="m-0">{v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {arms && (
              <div className="flex max-w-[620px] flex-col gap-2">
                {arms.map((a) => (
                  <div
                    key={a.name}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[104px_minmax(0,1fr)_56px_120px]"
                  >
                    <span className="col-start-1 row-start-1 text-[12.5px] text-fg">{a.name}</span>
                    <span className="relative col-span-3 col-start-1 row-start-2 h-1.5 overflow-hidden rounded-full bg-surface-muted sm:col-span-1 sm:col-start-2 sm:row-start-1">
                      <i
                        className={cn(
                          "absolute inset-y-0 left-0 rounded-full",
                          a.original ? "bg-fg-faint" : "bg-fg",
                        )}
                        style={{ width: `${a.width}%` }}
                      />
                    </span>
                    <span className="col-start-2 row-start-1 text-right font-mono text-[12.5px] tabular-nums text-fg sm:col-start-3">
                      {a.value}
                    </span>
                    <span className="col-start-3 row-start-1 font-mono text-xs tabular-nums text-fg-muted sm:col-start-4">
                      {a.counts}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {timeline && (
              <div className="mt-[18px] max-w-[620px]" aria-hidden>
                <div className="relative h-3.5">
                  <span className="absolute inset-x-0 top-1.5 h-0.5 bg-border" />
                  <span
                    className="absolute left-0 top-1.5 h-0.5 bg-fg"
                    style={{ width: `${timeline.done}%` }}
                  />
                  <span
                    className="absolute top-0.5 -ml-[5px] h-2.5 w-2.5 rounded-full bg-fg"
                    style={{ left: `${timeline.done}%` }}
                  />
                  <span
                    className={cn(
                      "absolute right-0 top-0.5 h-2.5 w-2.5 rounded-full border-[1.5px] bg-surface",
                      timeline.ring === "fixed" && "border-fg",
                      timeline.ring === "estimate" && "border-dashed border-fg-muted",
                      timeline.ring === "none" && "border-border-strong",
                    )}
                  />
                </div>
                <div className="relative mt-1.5 flex h-4 justify-between gap-3 font-mono text-[11px] text-fg-muted">
                  <span className="truncate">{timeline.start}</span>
                  {timeline.mid && (
                    <span
                      className="absolute hidden -translate-x-1/2 whitespace-nowrap sm:block"
                      style={{ left: `${timeline.done}%` }}
                    >
                      {timeline.mid}
                    </span>
                  )}
                  <span className="truncate text-right">{timeline.end}</span>
                </div>
              </div>
            )}

            {after && (
              <p className="mt-2 max-w-[64ch] text-[13px] leading-relaxed text-fg-muted">{after}</p>
            )}

            {/* The second result line (page-groups mock, A17 and A18): only when the report carries it. */}
            {second && (
              <details
                className="group mt-3.5 max-w-[64ch] border-t border-border pt-3 text-[13px] leading-normal text-fg-muted"
                data-line="on-versioned"
              >
                <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <b className="font-medium text-fg">{ON_VERSIONED_LEAD}</b> {second.text}
                  {second.range && (
                    <>
                      <span className="font-mono text-[12.5px]">{second.range}</span>.
                    </>
                  )}{" "}
                  <span className="whitespace-nowrap text-xs underline decoration-dotted underline-offset-[3px]">
                    <span className="group-open:hidden">{WHY_TWO_LINES}</span>
                    <span className="hidden group-open:inline">{HIDE}</span>
                  </span>
                </summary>
                <ul className="mt-2 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px]">
                  {WHY_LINES.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {figure && <FigureColumn figure={figure} />}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-border px-4 py-[9px] text-[11.5px] text-fg-muted sm:px-5">
          {closed ? <span className="font-mono text-[11px]">{closed}</span> : <span />}
          <button
            type="button"
            aria-expanded={howOpen}
            onClick={() => setHowOpen((v) => !v)}
            className="inline-flex items-center gap-1 whitespace-nowrap text-fg underline decoration-dotted underline-offset-[3px]"
          >
            How this works
            <ChevronDown
              size={12}
              className={cn(
                "transition-transform duration-medium ease-smooth",
                howOpen && "rotate-180",
              )}
            />
          </button>
        </div>

        {howOpen && (
          <div className="grid grid-cols-1 gap-x-10 gap-y-2.5 border-t border-border px-4 pb-[18px] pt-3.5 text-[13px] leading-relaxed text-fg sm:px-5 md:grid-cols-2">
            {howItWorks(report).map((h) => (
              <p key={h.k} className="max-w-[58ch]">
                <span className="mb-0.5 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-fg-muted">
                  {h.k}
                </span>
                {h.text}
              </p>
            ))}
          </div>
        )}
      </div>
      <p className="mt-2 max-w-[110ch] text-xs leading-normal text-fg-muted">
        {limitsShort(report.limits)}
      </p>

      {report.by_source.length > 0 && <BySource report={report} />}
    </section>
  );
}

function StatePill({
  tone,
  text,
  live,
  icon,
}: {
  tone: "muted" | "ok" | "warn" | "err";
  text: string;
  live: boolean;
  icon: "check" | "alert" | null;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[5px] text-[11px] leading-none",
        tone === "muted" && "border border-border text-fg-muted",
        tone === "ok" && TINT.ok,
        tone === "warn" && TINT.warn,
        tone === "err" && TINT.err,
      )}
    >
      {live && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none"
        />
      )}
      {icon === "check" && <Check size={12} aria-hidden />}
      {icon === "alert" && <TriangleAlert size={12} aria-hidden />}
      {text}
    </span>
  );
}

function FigureColumn({ figure }: { figure: Figure }) {
  return (
    <div className="min-w-0">
      <p className="text-[11.5px] text-fg-muted">{figure.key}</p>
      {figure.big === null ? (
        <p className="mt-1 text-xl font-medium tracking-[-0.01em] text-fg-muted">Not yet</p>
      ) : (
        <p
          className="mt-1 font-mono text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums"
          style={{ color: INK[figure.ink] }}
        >
          {figure.big}
          {figure.small && (
            <small className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-fg-muted">
              {figure.small}
            </small>
          )}
        </p>
      )}
      <p className="mt-1 font-mono text-xs text-fg-muted">{figure.range}</p>
      {figure.strip && <RangeStrip strip={figure.strip} />}
      {figure.earn && (
        <p className="mt-3.5 border-t border-border pt-3 text-[13px] leading-normal text-fg">
          {figure.earn.strong && (
            <span className="font-mono text-[12.5px]">{figure.earn.strong}</span>
          )}
          {figure.earn.rest}
          {figure.earn.em && (
            <span className="mt-0.5 block text-xs text-fg-muted">{figure.earn.em}</span>
          )}
        </p>
      )}
    </div>
  );
}

function RangeStrip({ strip }: { strip: Strip }) {
  const d = { min: strip.min, max: strip.max };
  const left = axisPos(strip.low, d);
  const right = axisPos(strip.high, d);
  const zero = axisPos(0, d);
  const ticks = axisTicks(d);
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-[18px]">
        <span className="absolute inset-x-0 top-2 h-0.5 bg-surface-muted" />
        <span
          className="absolute top-[5px] h-2 rounded-[2px]"
          style={{
            left: `${left}%`,
            width: `${Math.max(0.5, right - left)}%`,
            ...BAND[strip.band],
          }}
        />
        <span className="absolute inset-y-0.5 w-px bg-border-strong" style={{ left: `${zero}%` }} />
        <span
          className="absolute inset-y-0.5 -ml-px w-0.5 rounded-[2px]"
          style={{ left: `${axisPos(strip.value, d)}%`, background: DOT[strip.ink] }}
        />
      </div>
      <div className="relative h-3.5 font-mono text-[10px] text-fg-faint">
        {ticks.map((t, i) => (
          <span
            key={t}
            className={cn("absolute", t === 0 && "text-fg-muted")}
            style={
              i === 0
                ? { left: 0 }
                : i === ticks.length - 1
                  ? { right: 0 }
                  : { left: `${axisPos(t / 100, d)}%`, transform: "translateX(-50%)" }
            }
          >
            {t > 0 ? `+${t}%` : t === 0 ? "0" : `${t}%`}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// By source: a look, not a result
// ---------------------------------------------------------------------------

function BySource({ report }: { report: LiftReport }) {
  const [open, setOpen] = useState(bySourceOpen(report));
  const totalT = report.by_source.reduce((s, r) => s + r.treat.visits, 0);
  const totalH = report.by_source.reduce((s, r) => s + r.holdout.visits, 0);
  return (
    <div className="mt-6 rounded-md border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-4 px-4 pb-3 pt-4 text-left sm:px-5"
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-fg">
            By source: a look, not a result
          </span>
          <span className="mt-0.5 block max-w-[90ch] text-xs text-fg-muted">
            {chancesLine(report.by_source.length)}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "mt-0.5 shrink-0 text-fg-muted transition-transform duration-medium ease-smooth",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <>
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead>
                <tr className="text-[11.5px] text-fg-muted">
                  <th className="whitespace-nowrap py-2 pl-5 pr-3 text-left font-medium">Source</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    Visits · versions / original
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    Clicked · versions / original
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    Rate · versions / original
                  </th>
                  <th className="whitespace-nowrap py-2 pl-3 pr-5 text-right font-medium">
                    Difference, likely range
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.by_source.map((r) => (
                  <SourceTr key={r.source_dim} row={r} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-[9px] text-[11.5px] text-fg-muted sm:px-5">
            <span className="font-mono text-[11px]">
              Range bars from -40% to +100%, the line is zero
            </span>
            <span>
              {report.arms &&
              report.arms.treat.visits === totalT &&
              report.arms.holdout.visits === totalH
                ? `The rows add up to the card: ${num(totalT)} and ${num(totalH)} visits`
                : `The rows: ${num(totalT)} and ${num(totalH)} visits`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function chancesLine(n: number): string {
  if (n <= 1) return "A smaller group, so a wider range.";
  const w = WORDS[n] ?? String(n);
  return `Smaller groups, wider ranges, ${w} chances of a lucky number.`;
}

function SourceTr({ row }: { row: SourceRow }) {
  const d = SOURCE_DOMAIN;
  const fewest = Math.min(row.treat.converting_visits, row.holdout.converting_visits);
  const value =
    row.treat.rate !== null && row.holdout.rate !== null && row.holdout.rate > 0
      ? row.treat.rate / row.holdout.rate - 1
      : null;
  return (
    <tr className="border-t border-border">
      <td className="h-10 whitespace-nowrap py-0 pl-5 pr-3 text-left">
        {sourceName(row.source_dim)}
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-[12.5px] tabular-nums">
        {num(row.treat.visits)} <span className="text-fg-muted">/ {num(row.holdout.visits)}</span>
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-[12.5px] tabular-nums">
        {num(row.treat.converting_visits)}{" "}
        <span className="text-fg-muted">/ {num(row.holdout.converting_visits)}</span>
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-[12.5px] tabular-nums">
        {rate1(row.treat.rate)} <span className="text-fg-muted">/ {rate1(row.holdout.rate)}</span>
      </td>
      {row.range ? (
        <td className="w-[300px] whitespace-nowrap py-0 pl-3 pr-5">
          <div className="grid grid-cols-[150px_auto] items-center justify-end gap-3">
            <div className="relative h-3.5" aria-hidden>
              <span className="absolute inset-x-0 top-1.5 h-0.5 bg-surface-muted" />
              <span
                className="absolute top-[3px] h-2 rounded-[2px]"
                style={{
                  left: `${axisPos(row.range.low, d)}%`,
                  width: `${Math.max(0.5, axisPos(row.range.high, d) - axisPos(row.range.low, d))}%`,
                  ...BAND.solid,
                }}
              />
              <span
                className="absolute inset-y-0 w-px bg-border-strong"
                style={{ left: `${axisPos(0, d)}%` }}
              />
              {value !== null && (
                <span
                  className="absolute inset-y-0 -ml-px w-0.5 rounded-[2px] bg-fg-muted"
                  style={{ left: `${axisPos(value, d)}%` }}
                />
              )}
            </div>
            <span className="min-w-24 text-right font-mono text-[11.5px] text-fg-muted">
              {signed(row.range.low)} to {signed(row.range.high)}
            </span>
          </div>
        </td>
      ) : (
        <td className="whitespace-nowrap py-0 pl-3 pr-5 text-right text-xs text-fg-muted">
          Too few clicks to say ({num(fewest)} of 10)
        </td>
      )}
    </tr>
  );
}
