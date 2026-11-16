"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import { num, rate1 } from "@/lib/proof";
import {
  changeText,
  clickedLabel,
  leadLine,
  seesFor,
  share0,
  shareBar,
  showsChange,
  sourceLabel,
  sourceTone,
} from "@/lib/results";
import { cn } from "@/lib/utils";
import type {
  AnalyticsBreakdown,
  AnalyticsOverview,
  LiftReport,
  ResultsLead,
  SourceBreakdownRow,
  TaggedLinks,
  UnknownRow,
} from "@/types/api";
import { InfoToggle } from "./InfoToggle";

/**
 * "Who comes to your site, and why?" (results-page mock): one line, the
 * share bar, one row per source and the Unknown row. Named sources (N1) and
 * the tagged-links row (N3) show only when the API sends them.
 */

const HATCH = "repeating-linear-gradient(135deg,#d4d4d8 0 2px,transparent 2px 5px)";
const HATCH_DARK = "repeating-linear-gradient(135deg,#a1a1aa 0 2px,transparent 2px 4px)";

export function WhoComes({
  breakdown,
  overview,
  loading,
  report,
  first = false,
}: {
  breakdown: AnalyticsBreakdown | null;
  overview: AnalyticsOverview | null;
  loading: boolean;
  report: LiftReport | null;
  /** Leads the page (too little traffic for a test, measure-at-go-live mock 06 D). */
  first?: boolean;
}) {
  const ready = breakdown?.unknown && breakdown.lead && breakdown.by_source;
  return (
    <section aria-labelledby="who-h" className={first ? "mt-5 sm:mt-6" : "mt-8 sm:mt-10"}>
      <h2 id="who-h" className="text-[15px] font-semibold tracking-[-0.005em] text-fg">
        Who comes to your site, and why?
      </h2>
      {loading && !breakdown ? (
        <div className="mt-3 space-y-3" aria-hidden>
          <Skeleton className="h-5 w-full max-w-[520px]" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : ready ? (
        <Body
          lead={breakdown.lead as ResultsLead}
          bySource={breakdown.by_source as SourceBreakdownRow[]}
          unknown={breakdown.unknown as UnknownRow}
          tagged={breakdown.tagged}
          byTuple={breakdown.by_tuple}
          change={showsChange(breakdown.comparison)}
          report={report}
        />
      ) : overview && overview.hero.total_visits > 0 ? (
        <Fallback overview={overview} />
      ) : (
        <p className="mt-2.5 text-[13px] text-fg-muted">No visits in this period yet.</p>
      )}
    </section>
  );
}

/** A row from before the per-source reads: the share only, until the next hourly run. */
function Fallback({ overview }: { overview: AnalyticsOverview }) {
  const c = overview.cohorts;
  const known = c.personalized.visits + c.holdout.visits + (c.skipped?.visits ?? 0);
  const unknown = c.no_signal.visits;
  const total = known + unknown;
  const bar = shareBar([{ source_dim: "known", visits: known }], {
    visits: unknown,
    dark_social_probable: c.no_signal.dark_social_probable ?? 0,
  });
  return (
    <>
      <p className="mt-2.5 max-w-[68ch] text-[15px] font-medium leading-normal tracking-[-0.005em] text-fg">
        {total ? `${share0(known / total)} of visits told us where they came from.` : ""}
      </p>
      <ShareBar bar={bar} />
      <p className="mt-3 text-xs text-fg-muted">
        Each source gets its row after the next hourly count.
      </p>
    </>
  );
}

function Body({
  lead,
  bySource,
  unknown,
  tagged,
  byTuple,
  change,
  report,
}: {
  lead: ResultsLead;
  bySource: SourceBreakdownRow[];
  unknown: UnknownRow;
  tagged: TaggedLinks | undefined;
  byTuple: AnalyticsBreakdown["by_tuple"];
  change: boolean;
  report: LiftReport | null;
}) {
  const total = lead.total_visits || bySource.reduce((s, r) => s + r.visits, 0) + unknown.visits;
  const bar = shareBar(bySource, unknown);
  const cols = change ? COLS_CHANGE : COLS;
  return (
    <>
      <p className="mt-2.5 max-w-[68ch] text-pretty text-[15px] font-medium leading-normal tracking-[-0.005em] text-fg sm:text-base">
        {leadLine(lead, report)}
      </p>
      {total > 0 && <ShareBar bar={bar} />}
      <div className="mt-4 rounded-md border border-border bg-surface">
        <div
          className={cn(
            "hidden items-center gap-x-3.5 px-5 py-2 text-[11.5px] font-medium text-fg-muted sm:grid",
            cols,
          )}
        >
          <span aria-hidden>Where from</span>
          <span aria-hidden className="text-right">
            Visits
          </span>
          <span aria-hidden className="text-right">
            Share
          </span>
          {change && (
            <span aria-hidden className="text-right">
              Change
            </span>
          )}
          <span className="flex items-center justify-end gap-1 text-right">
            <span aria-hidden>{clickedLabel(report)}</span>
            <InfoToggle label="About these click rates" align="right">
              Different visitors in each row, so a rate shows who clicks. The test above shows what
              the versions did.
            </InfoToggle>
          </span>
          <span aria-hidden>What they see</span>
        </div>
        {bySource.map((r) => (
          <SourceRow
            key={r.source_dim}
            cols={cols}
            change={change}
            swatch={
              <span
                className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: sourceTone(r.source_dim) }}
              />
            }
            name={sourceLabel(r.source_dim)}
            sub={namesLine(r)}
            visits={r.visits}
            share={total ? r.visits / total : 0}
            delta={r.visits_change}
            rate={r.rate}
            conversions={r.conversions}
            sees={seesText(seesFor(byTuple, r.source_dim))}
          />
        ))}
        <SourceRow
          cols={cols}
          change={change}
          tint
          swatch={
            <span
              className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-[2px] border border-border-strong"
              style={{ background: HATCH }}
            />
          }
          name="Unknown"
          sub={
            unknown.dark_social_probable > 0
              ? `${num(unknown.dark_social_probable)} look like chat-app links`
              : null
          }
          visits={unknown.visits}
          share={total ? unknown.visits / total : 0}
          delta={unknown.visits_change}
          rate={unknown.rate}
          conversions={unknown.conversions}
          sees="Your original page"
        />
        {tagged && (
          <SourceRow
            cols={cols}
            change={change}
            dashed
            swatch={
              <span className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-fg" />
            }
            name="Your tagged links"
            sub="Also counted above"
            visits={tagged.visits}
            share={total ? tagged.visits / total : 0}
            delta={tagged.visits_change}
            rate={tagged.rate}
            conversions={tagged.conversions}
            sees="The version for their source"
          />
        )}
      </div>
    </>
  );
}

const COLS = "sm:grid-cols-[minmax(0,1fr)_64px_48px_128px_minmax(0,250px)]";
const COLS_CHANGE = "sm:grid-cols-[minmax(0,1fr)_64px_48px_60px_128px_minmax(0,250px)]";

function namesLine(r: SourceBreakdownRow): string | null {
  if (!r.names?.length) return null;
  return r.names
    .slice(0, 4)
    .map((n) => `${n.label ?? n.name} ${num(n.visits)}`)
    .join(" · ");
}

function seesText(sees: { name: string; share: number }[]): React.ReactNode {
  if (!sees.length) return <span className="text-fg-muted">Your original page</span>;
  return sees.map((s, i) => (
    <span key={s.name}>
      {i > 0 && ", "}
      {s.name} <span className="font-mono text-[11.5px] text-fg-muted">{share0(s.share)}</span>
    </span>
  ));
}

function SourceRow({
  cols,
  change,
  swatch,
  name,
  sub,
  visits,
  share,
  delta,
  rate,
  conversions,
  sees,
  tint,
  dashed,
}: {
  cols: string;
  change: boolean;
  swatch: React.ReactNode;
  name: string;
  sub: string | null;
  visits: number;
  share: number;
  delta: number | null;
  rate: number | null;
  conversions: number;
  sees: React.ReactNode;
  tint?: boolean;
  dashed?: boolean;
}) {
  const d = changeText(delta);
  return (
    <div
      className={cn(
        "grid grid-cols-3 gap-x-2.5 gap-y-1.5 border-t px-4 py-3 text-[13px] sm:items-start sm:leading-5 sm:gap-x-3.5 sm:gap-y-0 sm:px-5 sm:py-[11px]",
        change && "grid-cols-4",
        cols,
        dashed ? "border-dashed border-border-strong" : "border-border",
        tint && "bg-[color-mix(in_srgb,var(--surface-muted)_45%,transparent)]",
      )}
    >
      <div className="col-span-full flex min-w-0 gap-2.5 sm:col-span-1">
        {swatch}
        <span className="min-w-0">
          <span className="font-medium text-fg">{name}</span>
          {sub && <span className="mt-0.5 block text-xs leading-snug text-fg-muted">{sub}</span>}
        </span>
      </div>
      <Num label="Visits" value={num(visits)} />
      <Num label="Share" value={share0(share)} />
      {change && <Num label="Change" value={d ?? ""} empty={d === null} />}
      <Num
        label="Clicked"
        value={rate1(rate)}
        extra={conversions > 0 ? ` · ${num(conversions)}` : null}
      />
      <div className="col-span-full text-[12.5px] leading-snug text-fg sm:col-span-1">
        <span className="mr-1.5 text-[10.5px] text-fg-faint sm:sr-only">Sees</span>
        {sees}
      </div>
    </div>
  );
}

function Num({
  label,
  value,
  extra,
  empty,
}: {
  label: string;
  value: string;
  extra?: string | null;
  empty?: boolean;
}) {
  return (
    <div className="flex flex-col gap-px whitespace-nowrap font-mono text-xs tabular-nums text-fg sm:block sm:text-right sm:text-[12.5px]">
      <span className="font-sans text-[10.5px] text-fg-faint sm:sr-only">{label}</span>
      {empty ? <span className="sr-only">no change to show</span> : value}
      {extra && <span className="hidden text-fg-muted sm:inline">{extra}</span>}
    </div>
  );
}

function ShareBar({ bar }: { bar: ReturnType<typeof shareBar> }) {
  return (
    <div className="mt-[18px]">
      <div className="mb-1.5 flex justify-between text-xs text-fg-muted">
        <span>
          Known source · <b className="font-mono font-medium text-fg">{share0(bar.knownShare)}</b>
        </span>
        <span>
          Unknown · <b className="font-mono font-medium text-fg">{share0(bar.unknownShare)}</b>
        </span>
      </div>
      <div className="flex h-3 gap-[3px]" aria-hidden>
        {bar.known.length > 0 && (
          <div
            className="flex h-full gap-0.5"
            style={{ flex: bar.known.reduce((s, r) => s + r.visits, 0) }}
          >
            {bar.known.map((r, i) => (
              <i
                key={r.dim}
                className={cn(
                  "block h-full min-w-[2px]",
                  i === 0 && "rounded-l-[2px]",
                  i === bar.known.length - 1 && "rounded-r-[2px]",
                )}
                style={{
                  flex: r.visits,
                  background: r.dim === "known" ? "#3f3f46" : sourceTone(r.dim),
                }}
              />
            ))}
          </div>
        )}
        {bar.dark + bar.rest > 0 && (
          <div className="flex h-full gap-0.5" style={{ flex: bar.dark + bar.rest }}>
            {bar.dark > 0 && (
              <i
                className="block h-full min-w-[2px] rounded-l-[2px] border border-fg-faint"
                style={{ flex: bar.dark, background: HATCH_DARK }}
              />
            )}
            {bar.rest > 0 && (
              <i
                className={cn(
                  "block h-full min-w-[2px] rounded-r-[2px] border border-border-strong",
                  bar.dark === 0 && "rounded-l-[2px]",
                )}
                style={{ flex: bar.rest, background: HATCH }}
              />
            )}
          </div>
        )}
      </div>
      {bar.dark > 0 && (
        <div className="mt-1.5 flex justify-end text-[11.5px] text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-2.5 rounded-[2px] border border-fg-faint"
              style={{ background: HATCH_DARK }}
            />
            Likely chat-app links
          </span>
        </div>
      )}
    </div>
  );
}
