"use client";

import { num, signed } from "@/lib/proof";
import {
  type ResultsWindow,
  clickedLabel,
  groupRows,
  intentLabel,
  rateOf,
  seriesFor,
  sourcePhrase,
} from "@/lib/results";
import { cn } from "@/lib/utils";
import type {
  AnalyticsOverview,
  LiftReport,
  TimeSeriesPoint,
  VariantBreakdownItem,
} from "@/types/api";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { InfoToggle } from "./InfoToggle";

/**
 * Advanced, closed by default (results-page mock): visits by day, by group
 * and by version, and natural lift under a plain title, in ink, without
 * green and without "Significant".
 */
export function ResultsAdvanced({
  window,
  overview,
  series,
  byTuple,
  report,
  superadmin,
}: {
  window: ResultsWindow;
  overview: AnalyticsOverview | null;
  series: TimeSeriesPoint[];
  byTuple: VariantBreakdownItem[];
  report: LiftReport | null;
  superadmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!overview) return null;
  return (
    <section className="mt-8 border-t border-border-strong sm:mt-10">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="advanced-body"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-3 py-3.5 text-left"
      >
        <span className="text-[15px] font-semibold text-fg">Advanced</span>
        <span className="flex-1 text-[12.5px] text-fg-muted">By day, by group, by version</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "self-center text-fg-muted transition-transform duration-medium ease-smooth",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div id="advanced-body" className="flex flex-col gap-3 pb-2">
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="rounded-md border border-border bg-surface p-4">
              <p className="text-[13px] font-semibold text-fg">Visits and clicks by day</p>
              <DayChart
                points={seriesFor(series, window)}
                testStart={report?.test?.first_day ?? null}
                clicked={clickedLabel(report)}
              />
            </div>
            <Groups overview={overview} report={report} />
          </div>
          <Natural overview={overview} />
          <Versions items={byTuple} superadmin={superadmin} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// By day
// ---------------------------------------------------------------------------

/** 437 -> 500, 38 -> 40: a round top for the scale. */
export function niceTop(x: number): number {
  if (x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayTick(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

function DayChart({
  points,
  testStart,
  clicked,
}: {
  points: TimeSeriesPoint[];
  testStart: string | null;
  clicked: string;
}) {
  if (points.length === 0) {
    return (
      <p className="mt-2 text-xs text-fg-muted">By day needs 7 or 30 days, and one closed day.</p>
    );
  }
  const X0 = 30;
  const X1 = 454;
  const Y0 = 12;
  const Y1 = 178;
  const n = points.length;
  const slot = (X1 - X0) / n;
  const bw = Math.max(2, slot * 0.72);
  const vTop = niceTop(Math.max(...points.map((p) => p.visits)));
  const cTop = niceTop(Math.max(...points.map((p) => p.conversions)));
  const yv = (v: number) => Y1 - (v / vTop) * (Y1 - Y0);
  const yc = (c: number) => Y1 - (c / cTop) * (Y1 - Y0);
  const cx = (i: number) => X0 + slot * i + slot / 2;
  const tickEvery = Math.max(1, Math.ceil(n / 5));
  const start = testStart ? points.findIndex((p) => p.date === testStart) : -1;
  return (
    <>
      <svg
        viewBox="0 0 480 200"
        role="img"
        aria-label={`Visits and ${clicked.toLowerCase()} by day`}
        className="mt-3 h-auto w-full"
      >
        <g className="fill-fg-faint font-mono" fontSize="9.5">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={X0}
                x2={X1}
                y1={Y1 - f * (Y1 - Y0)}
                y2={Y1 - f * (Y1 - Y0)}
                stroke="#f4f4f5"
              />
              <text x={X0 - 6} y={Y1 - f * (Y1 - Y0) + 3} textAnchor="end">
                {num(vTop * f)}
              </text>
              <text x={X1 + 6} y={Y1 - f * (Y1 - Y0) + 3}>
                {num(cTop * f)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % tickEvery === 0 ? (
              <text key={p.date} x={cx(i)} y={194} textAnchor="middle">
                {dayTick(p.date)}
              </text>
            ) : null,
          )}
        </g>
        {points.map((p, i) => (
          <rect
            key={p.date}
            x={cx(i) - bw / 2}
            y={yv(p.visits)}
            width={bw}
            height={Math.max(0, Y1 - yv(p.visits))}
            rx={1.5}
            fill="#e4e4e7"
          />
        ))}
        {start >= 0 && (
          <g>
            <line
              x1={cx(start) - slot / 2}
              x2={cx(start) - slot / 2}
              y1={Y0}
              y2={Y1}
              stroke="#a1a1aa"
              strokeDasharray="2 3"
            />
            <text x={cx(start) - slot / 2 + 4} y={Y0 + 9} fontSize="9.5" className="fill-fg-muted">
              test starts
            </text>
          </g>
        )}
        <polyline
          points={points.map((p, i) => `${cx(i)},${yc(p.conversions)}`).join(" ")}
          fill="none"
          stroke="var(--fg)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-[2px] bg-border" />
          Visits, left
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-3 bg-fg" />
          {clicked}, right
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// By group, natural lift, each version
// ---------------------------------------------------------------------------

const TABLE_ROW =
  "grid gap-2 border-t border-border px-4 py-2 text-[12.5px] sm:gap-3 sm:px-5 sm:text-[13px]";
const NUM = "text-right font-mono tabular-nums";

function Groups({ overview, report }: { overview: AnalyticsOverview; report: LiftReport | null }) {
  const cols =
    "grid-cols-[minmax(0,1fr)_54px_48px_48px] sm:grid-cols-[minmax(0,1fr)_64px_56px_52px]";
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-1.5 px-4 pb-3 pt-4 sm:px-5">
        <p className="text-[13px] font-semibold text-fg">Visits by group</p>
        <InfoToggle label="Why these differ from the test card" align="right">
          {report?.test
            ? "What each visit saw in this period. The test card counts each visit by the group it was put in since the test started, so the two do not match."
            : "What each visit saw in this period."}
        </InfoToggle>
      </div>
      <div
        className={cn(TABLE_ROW, cols, "text-[11.5px] font-medium text-fg-muted sm:text-[11.5px]")}
      >
        <span />
        <span className="text-right">Visits</span>
        <span className="text-right">Clicked</span>
        <span className="text-right">Rate</span>
      </div>
      {groupRows(overview).map((g) => (
        <div
          key={g.label}
          className={cn(
            TABLE_ROW,
            cols,
            g.total && "bg-[color-mix(in_srgb,var(--surface-muted)_45%,transparent)] font-medium",
            g.total && "rounded-b-md",
          )}
        >
          <span className="min-w-0 text-fg">{g.label}</span>
          <span className={NUM}>{num(g.visits)}</span>
          <span className={NUM}>{num(g.conversions)}</span>
          <span className={NUM}>{rateOf(g.conversions, g.visits)}</span>
        </div>
      ))}
    </div>
  );
}

function Natural({ overview }: { overview: AnalyticsOverview }) {
  const n = overview.hero.natural_lift;
  const c = overview.cohorts;
  const a = rateOf(c.personalized.conversions, c.personalized.visits);
  const b = rateOf(c.no_signal.conversions, c.no_signal.visits);
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <p className="text-[13px] font-semibold text-fg">
          Visits with a version against unknown visits
        </p>
        <p className="mt-1 text-[12.5px] text-fg-muted">
          Different visitors. The test above shows what the versions did.
        </p>
      </div>
      {n.value !== null ? (
        <p className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 font-mono tabular-nums">
          <span className="text-xl font-semibold text-fg">{signed(n.value)}</span>
          {n.ci_lower !== null && n.ci_upper !== null && (
            <span className="text-xs text-fg-muted">
              range {signed(n.ci_lower)} to {signed(n.ci_upper)}
            </span>
          )}
          {a && b && (
            <span className="text-xs text-fg-muted">
              {a} against {b}
            </span>
          )}
        </p>
      ) : (
        <p className="text-[12.5px] text-fg-muted">Not enough visits yet.</p>
      )}
    </div>
  );
}

function Versions({ items, superadmin }: { items: VariantBreakdownItem[]; superadmin: boolean }) {
  const [all, setAll] = useState(false);
  const sorted = [...items].sort((x, y) => y.visits - x.visits);
  const shown = all ? sorted : sorted.slice(0, 8);
  const cols =
    "grid-cols-[minmax(0,1fr)_50px_44px_46px] sm:grid-cols-[minmax(0,1fr)_72px_64px_60px]";
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <p className="text-[13px] font-semibold text-fg">
          Each version
          {sorted.length > 0 && (
            <span className="ml-2 font-normal text-fg-muted">
              {shown.length} of {sorted.length}
            </span>
          )}
        </p>
        {sorted.length > 8 && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="text-xs text-fg underline decoration-dotted underline-offset-[3px]"
          >
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-[12.5px] text-fg-muted sm:px-5">
          No version was seen in this period.
        </p>
      ) : (
        <>
          <div
            className={cn(
              TABLE_ROW,
              cols,
              "text-[11.5px] font-medium text-fg-muted sm:text-[11.5px]",
            )}
          >
            <span>Version</span>
            <span className="text-right">Visits</span>
            <span className="text-right">Clicked</span>
            <span className="text-right">Rate</span>
          </div>
          {shown.map((v) => (
            <div key={`${v.intent_dim}:${v.source_dim}`} className={cn(TABLE_ROW, cols)}>
              <span className="min-w-0">
                <span className="font-medium text-fg">{intentLabel(v.intent_dim)}</span>{" "}
                <span className="text-fg-muted">{sourcePhrase(v.source_dim)}</span>
                {superadmin && (
                  <span className="ml-1.5 font-mono text-[11px] text-fg-faint">
                    {v.intent_dim}:{v.source_dim}
                  </span>
                )}
              </span>
              <span className={NUM}>{num(v.visits)}</span>
              <span className={NUM}>{num(v.conversions)}</span>
              <span className={NUM}>{rateOf(v.conversions, v.visits)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
