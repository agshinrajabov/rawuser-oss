"use client";

/**
 * Visitors (design/mock/dashboard-v2/app.html, section 02). Reads like any
 * analytics tool. Click a row (a source, a country, a page, a version) and
 * every number, the chart, the sentence and the other panels follow: the
 * filters go to the server (docs/specs/visitors-page.md §2), which leaves
 * each panel's own dimension out so its other rows stay clickable. The
 * period and filters live in the address, so a link lands filtered.
 */

import { buttonVariants } from "@/components/ui/Button";
import { ApiError, apiFetch } from "@/lib/api";
import { pageName, sourceRow } from "@/lib/kinds";
import { num } from "@/lib/proof";
import { withCustomer } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  NOT_RECORDED,
  NO_COUNTRY,
  NO_FILTERS,
  REFUSED_LINE,
  type VDim,
  type VFilters,
  type VWindow,
  V_WINDOWS,
  type VisitorsAnswer,
  activeFilters,
  chartBuckets,
  countryMatrix,
  countryName,
  deviceName,
  directFilters,
  filterLabel,
  filtersFromQuery,
  pctText,
  readVisitors,
  summaryFor,
  toggle,
  versionLabel,
  versionSub,
  viewName,
  visitorsPath,
} from "@/lib/visitors";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardHead,
  How,
  PageHead,
  SectionHead,
  Seg,
  StateLine,
  updatedAgo,
  useJson,
} from "./parts";

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Kpis({ a }: { a: VisitorsAnswer }) {
  const t = a.totals;
  const items: [string, string, string][] = [
    ["Visits", num(t.visits), "stays on your site"],
    [
      "Page views",
      num(t.page_views),
      `${t.visits ? (t.page_views / t.visits).toFixed(1) : "0"} a visit`,
    ],
    ["Clicked a button that counts", num(t.conversions), "visits"],
    ["Click rate", pctText(t.conversions, t.visits), "of visits"],
  ];
  return (
    <div className="mt-4 grid grid-cols-2 rounded-t-md border border-border bg-surface lg:grid-cols-4">
      {items.map(([k, v, d], i) => (
        <div
          key={k}
          className={cn(
            "px-4 py-3",
            i % 2 === 1 && "border-l border-border",
            i >= 2 && "border-t border-border lg:border-t-0",
            i === 2 && "lg:border-l",
          )}
        >
          <div className="text-xs font-medium text-fg-muted">{k}</div>
          <div className="mt-0.5 font-mono text-[19px] font-semibold tracking-[-0.01em] lg:text-[22px]">
            {v}
          </div>
          <div className="font-mono text-[11.5px] text-fg-muted">{d}</div>
        </div>
      ))}
    </div>
  );
}

function Chart({ a }: { a: VisitorsAnswer }) {
  const bk = chartBuckets(a);
  const W = 1000;
  const H1 = 110;
  const H2 = 40;
  const G = 18;
  const n = Math.max(1, bk.length);
  const bw = W / n;
  const mv = Math.max(1, ...bk.map((b) => b.visits));
  const mc = Math.max(1, ...bk.map((b) => b.conversions));
  const per = a.window === "24h" ? "hour" : a.window === "90d" ? "week" : "day";
  const ticks = bk.length > 0 ? [0, Math.floor((bk.length - 1) / 2), bk.length - 1] : [];
  return (
    <div className="rounded-b-md border border-t-0 border-border bg-surface px-4 pb-2.5 pt-3">
      <svg
        viewBox={`0 0 ${W} ${H1 + G + H2 + 18}`}
        role="img"
        aria-label={`Visits and clicks per ${per}`}
        className="block h-auto w-full"
      >
        {bk.map((b, i) => {
          const h = Math.max(1, (b.visits / mv) * (H1 - 14));
          const h2 = b.conversions ? Math.max(2, (b.conversions / mc) * (H2 - 4)) : 0;
          return (
            <g key={`${b.label}-${i}`}>
              <rect
                x={i * bw + bw * 0.14}
                y={H1 - h}
                width={bw * 0.72}
                height={h}
                rx={1.5}
                fill="var(--border-strong)"
              >
                <title>{`${b.label}: ${b.visits} visits`}</title>
              </rect>
              {h2 > 0 && (
                <rect
                  x={i * bw + bw * 0.14}
                  y={H1 + G + H2 - h2}
                  width={bw * 0.72}
                  height={h2}
                  rx={1.5}
                  fill="var(--fg)"
                >
                  <title>{`${b.label}: ${b.conversions} clicked`}</title>
                </rect>
              )}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H1 + 0.5} y2={H1 + 0.5} stroke="var(--border)" />
        <line x1={0} x2={W} y1={H1 + G + H2 + 0.5} y2={H1 + G + H2 + 0.5} stroke="var(--border)" />
        <text x={0} y={10} className="fill-fg-muted font-mono text-[10px]">
          {num(mv)}
        </text>
        <text x={0} y={H1 + G - 4} className="fill-fg-muted font-mono text-[10px]">
          clicked
        </text>
        {ticks.map((i, j) => (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: three fixed ticks
            key={`t${j}`}
            x={j === 2 ? W : j === 1 ? i * bw + bw / 2 : 0}
            y={H1 + G + H2 + 15}
            textAnchor={j === 2 ? "end" : j === 1 ? "middle" : "start"}
            className="fill-fg-muted font-mono text-[10px]"
          >
            {bk[i]?.label}
          </text>
        ))}
      </svg>
      <div className="flex gap-4 text-[11.5px] text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-[2px] bg-border-strong" />
          Visits
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-[2px] bg-fg" />
          Clicked a button that counts
        </span>
      </div>
    </div>
  );
}

export interface PanelRow {
  key: string;
  label: string;
  sub?: string | null;
  code?: string | null;
  visits: number;
  conversions: number;
  /** Not clickable (the folded "other pages"). */
  still?: boolean;
}

function RowCells({ r, on, total }: { r: PanelRow; on: boolean; total: number }) {
  return (
    <>
      <span className="flex min-w-0 items-center pb-[9px] pt-[7px]">
        {r.code && (
          <span className="mr-2 inline-block min-w-6 rounded-[3px] border border-border bg-surface-muted px-1 text-center font-mono text-[10px] font-medium leading-4 tracking-[0.04em] text-[#52525b]">
            {r.code}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate">{r.label}</span>
          {r.sub && (
            <small className="block truncate text-[11px] leading-[1.3] text-fg-muted">
              {r.sub}
            </small>
          )}
        </span>
      </span>
      <span className="text-right font-mono text-[12.5px]">{num(r.visits)}</span>
      <span className="text-right font-mono text-[12.5px]">{num(r.conversions)}</span>
      <span className="text-right font-mono text-[12.5px] text-fg-muted">
        {pctText(r.conversions, r.visits)}
      </span>
      <i
        aria-hidden
        className={cn(
          "absolute bottom-1 left-4 h-0.5 max-w-[calc(100%-190px)] rounded-sm sm:max-w-[calc(100%-220px)]",
          on ? "bg-fg" : "bg-border-strong",
        )}
        style={{ width: `${Math.max(1.5, (r.visits / total) * 100)}%` }}
      />
    </>
  );
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_52px_48px_46px] gap-x-2 px-4 sm:grid-cols-[minmax(0,1fr)_64px_58px_52px] sm:gap-x-2.5";

export function Panel({
  title,
  unit,
  rows,
  picked,
  onPick,
  limit,
}: {
  title: string;
  unit: string;
  rows: PanelRow[];
  picked: string | null;
  onPick: (key: string) => void;
  limit: number;
}) {
  const [open, setOpen] = useState(false);
  const total = Math.max(
    1,
    rows.reduce((t, r) => t + r.visits, 0),
  );
  const shown = open ? rows : rows.slice(0, limit);
  const count = rows.filter((r) => !r.still).length;
  return (
    <Card
      className={cn("overflow-hidden", picked !== null && "[&_[aria-pressed=false]]:opacity-45")}
    >
      <CardHead title={title} side={`${count} ${unit}`} />
      <div
        className={cn(
          ROW_GRID,
          "border-b border-border pb-1.5 text-[11px] font-medium text-fg-faint",
        )}
      >
        <span />
        <span className="text-right">Visits</span>
        <span className="text-right">Clicked</span>
        <span className="text-right">Rate</span>
      </div>
      {rows.length === 0 && <p className="px-4 py-3 text-[13px] text-fg-muted">No visits.</p>}
      {shown.map((r) => {
        const on = picked === r.key;
        return r.still ? (
          <div
            key={r.key}
            className={cn(
              ROW_GRID,
              "relative min-h-[38px] items-center border-b border-border text-[13px] text-fg-muted last:border-b-0",
            )}
          >
            <RowCells r={r} on={on} total={total} />
          </div>
        ) : (
          <button
            key={r.key}
            type="button"
            aria-pressed={on}
            data-row={r.key}
            onClick={() => onPick(r.key)}
            className={cn(
              ROW_GRID,
              "relative min-h-[38px] w-full items-center border-b border-border text-left text-[13px] last:border-b-0 hover:bg-surface-muted/60",
              on && "bg-surface-muted !opacity-100 shadow-[inset_2px_0_0_var(--fg)]",
            )}
          >
            <RowCells r={r} on={on} total={total} />
          </button>
        );
      })}
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="block w-full border-t border-border px-4 py-2 text-left text-xs text-fg-muted hover:text-fg"
        >
          {open ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rows for each panel
// ---------------------------------------------------------------------------

const countryKey = (c: string | null) => c ?? NO_COUNTRY;

/**
 * Return visits a source row holds because the browser remembered that
 * source (ADR 0039). Only without top filters: the count is for the period,
 * not for a filtered slice.
 */
export function cameBack(a: VisitorsAnswer, source: string): number {
  const f = a.filters;
  if (f && (f.country || f.source || f.name || f.version || f.page)) return 0;
  return a.people?.givenBack[source] ?? 0;
}

export function sourceRows(a: VisitorsAnswer): PanelRow[] {
  return a.bySource.map((x) => {
    const w = sourceRow(x.source);
    const names = x.names.map((m) => m.label).filter(Boolean);
    const back = cameBack(a, x.source);
    const sub = names.length ? names.slice(0, 3).join(", ") : (w.sub ?? null);
    return {
      key: x.source,
      label: w.label,
      sub: back > 0 ? `${sub ? `${sub} · ` : ""}${num(back)} came back` : sub,
      visits: x.visits,
      conversions: x.conversions,
    };
  });
}

export function countryRows(a: VisitorsAnswer): PanelRow[] {
  return a.byCountry.map((x) => ({
    key: countryKey(x.country),
    label: countryName(x.country),
    code: x.country && x.country !== "other" ? x.country : null,
    visits: x.visits,
    conversions: x.conversions,
  }));
}

export function pageRows(a: VisitorsAnswer): PanelRow[] {
  const rows: PanelRow[] = a.byPage.pages.map((p) => ({
    key: p.page_path,
    label: pageName(p.page_path),
    sub: p.page_path === "/" ? "/" : p.has_versions ? null : "No versions on this page",
    visits: p.visits,
    conversions: p.conversions,
  }));
  const o = a.byPage.other;
  if (o && o.pages > 0) {
    rows.push({
      key: "__other",
      label: `${num(o.pages)} other ${o.pages === 1 ? "page" : "pages"}`,
      sub: "Each with under 5 visits",
      visits: o.visits,
      conversions: o.conversions,
      still: true,
    });
  }
  return rows;
}

/** The direct panel's landing pages, the folded rest last (as pageRows). */
export function landingRows(a: VisitorsAnswer): PanelRow[] {
  const d = a.direct;
  if (!d) return [];
  const rows: PanelRow[] = d.byLanding.pages.map((p) => ({
    key: p.page_path,
    label: pageName(p.page_path),
    sub: p.page_path === "/" ? "/" : p.has_versions ? null : "No versions on this page",
    visits: p.visits,
    conversions: p.conversions,
  }));
  const o = d.byLanding.other;
  if (o && o.visits > 0) {
    rows.push({
      key: "__other",
      label: o.pages > 0 ? `${num(o.pages)} other ${o.pages === 1 ? "page" : "pages"}` : "Other",
      sub: "Each with under 5 visits",
      visits: o.visits,
      conversions: o.conversions,
      still: true,
    });
  }
  return rows;
}

export function directCountryRows(a: VisitorsAnswer): PanelRow[] {
  return (a.direct?.byCountry ?? []).map((x) => ({
    key: countryKey(x.country),
    label: countryName(x.country),
    code: x.country && x.country !== "other" ? x.country : null,
    visits: x.visits,
    conversions: x.conversions,
  }));
}

export function deviceRows(a: VisitorsAnswer): PanelRow[] {
  return (a.direct?.byDevice ?? []).map((x) => ({
    key: x.device ?? NOT_RECORDED,
    label: deviceName(x.device),
    sub: x.device === "other" ? "Mostly crawlers" : null,
    visits: x.visits,
    conversions: x.conversions,
  }));
}

export function viewRows(a: VisitorsAnswer): PanelRow[] {
  return (a.direct?.byView ?? []).map((x) => ({
    key: x.view ?? NOT_RECORDED,
    label: viewName(x.view),
    sub: x.view === "app" ? "Mostly iPhone apps that hide the link" : null,
    visits: x.visits,
    conversions: x.conversions,
  }));
}

/** Came straight to the page (ADR 0038 part 1): the no-signal visits, four ways. */
export function DirectPanels({
  a,
  filters,
  onSet,
  linksHref,
}: {
  a: VisitorsAnswer;
  filters: VFilters;
  onSet: (next: VFilters) => void;
  linksHref: string;
}) {
  const d = a.direct;
  if (!d) return null;
  const own = directFilters(filters);
  const t = d.totals;
  const pick = (dim: VDim, value: string) => onSet(toggle(filters, dim, value));
  // A source, platform or version other than "nothing to go on" leaves no direct visit.
  const excluded =
    (filters.source !== null && filters.source !== "none") ||
    filters.name !== null ||
    (filters.version !== null && filters.version !== "as_built");
  return (
    <>
      <SectionHead
        title="Came straight to the page"
        side={`${num(t.visits)} ${t.visits === 1 ? "visit" : "visits"} with nothing to go on, ${pctText(t.conversions, t.visits)} clicked`}
      />
      {own.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5" aria-live="polite">
          <span className="text-[12.5px] text-fg-muted">In this part</span>
          {own.map((dim) => {
            const label = filterLabel(dim, filters[dim] as string, a);
            return (
              <button
                key={dim}
                type="button"
                data-chip={dim}
                aria-label={`Remove filter ${label}`}
                onClick={() => onSet({ ...filters, [dim]: null })}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-pill border border-fg bg-surface pl-2.5 pr-1.5 text-xs text-fg"
              >
                {label}
                <X size={14} aria-hidden className="opacity-75" />
              </button>
            );
          })}
        </div>
      )}
      {excluded ? (
        <p className="mt-3 text-[13px] text-fg-muted">
          The visits in this filter all had a source, so none came straight.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Panel
            title="Page they landed on"
            unit="pages"
            rows={landingRows(a)}
            picked={filters.landing}
            onPick={(k) => pick("landing", k)}
            limit={6}
          />
          <Panel
            title="Country"
            unit="countries"
            rows={directCountryRows(a)}
            picked={filters.country}
            onPick={(k) => pick("country", k)}
            limit={6}
          />
          <Panel
            title="Device"
            unit="kinds"
            rows={deviceRows(a)}
            picked={filters.device}
            onPick={(k) => pick("device", k)}
            limit={5}
          />
          <Panel
            title="App or browser"
            unit="kinds"
            rows={viewRows(a)}
            picked={filters.view}
            onPick={(k) => pick("view", k)}
            limit={3}
          />
        </div>
      )}
      {d.recording === "off" && (
        <p className="mt-2 text-xs text-fg-muted">
          Device and app are off for your site, so new visits have neither.
        </p>
      )}
      <How summary="What came straight means">
        <p>No link, tag or source on any page of the visit, so they see your page as built.</p>
        <p>
          It is not always a typed address: bookmarks, email apps and iPhone apps that hide the link
          land here too.
        </p>
        <p>
          Country and Page at the top filter this part too. Device, app and landing page filter only
          this part.
        </p>
        <p>
          Links you share yourself can carry a tag.{" "}
          <Link
            href={linksHref}
            className="text-fg underline decoration-dotted underline-offset-[3px]"
          >
            Make a tagged link
          </Link>
        </p>
      </How>
    </>
  );
}

/** The source words as the Visitors rows name them, for "saw it again". */
const BACK_NAMES: Record<string, string> = {
  answer: "their answer",
  ai: "AI assistant",
  social: "social",
  community: "community",
  organic: "search",
  paid: "ads",
};

/** New and returning visitors (ADR 0039): codes counted, never a code shown. */
export function PeoplePanel({ a }: { a: VisitorsAnswer }) {
  const p = a.people;
  if (!p) return null;
  const back = Object.entries(p.givenBack).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const backTotal = back.reduce((t, [, v]) => t + v, 0);
  const items: [string, string, string][] = [
    ["Visitors", num(p.people), "people, not visits"],
    ["New", num(p.new), "first visit in this period"],
    ["Came back", num(p.returning), `${num(p.returningVisits)} return visits`],
    ["Clicked on a later visit", num(p.convertedReturning), `of ${num(p.converted)} who clicked`],
  ];
  return (
    <>
      <SectionHead
        title="New and returning"
        side={
          p.people > 0
            ? `${pctText(p.returning, p.people)} of visitors came back`
            : "Counts start once Remember returning visitors is on"
        }
      />
      <div className="mt-3 grid grid-cols-2 rounded-md border border-border bg-surface lg:grid-cols-4">
        {items.map(([k, v, d], i) => (
          <div
            key={k}
            className={cn(
              "px-4 py-3",
              i % 2 === 1 && "border-l border-border",
              i >= 2 && "border-t border-border lg:border-t-0",
              i === 2 && "lg:border-l",
            )}
          >
            <div className="text-xs font-medium text-fg-muted">{k}</div>
            <div className="mt-0.5 font-mono text-[19px] font-semibold tracking-[-0.01em] lg:text-[22px]">
              {v}
            </div>
            <div className="font-mono text-[11.5px] text-fg-muted">{d}</div>
          </div>
        ))}
      </div>
      {backTotal > 0 && (
        <p className="mt-2 text-[12.5px] text-fg-muted">
          {num(backTotal)} return {backTotal === 1 ? "visit" : "visits"} saw their version again at
          once: {back.map(([k, v]) => `${BACK_NAMES[k] ?? k} ${num(v)}`).join(", ")}.
        </p>
      )}
      <How summary="How returning visitors are counted">
        <p>
          The browser keeps a random code on your site for 13 months from the first visit. It is not
          a name, an account or a device, and no other site sees it.
        </p>
        <p>
          A visitor who came from a source once, or tapped an answer, sees that version again when
          they come back with no link. A new link of their own still wins.
        </p>
        <p>Top filters do not narrow this part. Turn it off on Settings.</p>
      </How>
    </>
  );
}

export function versionRows(a: VisitorsAnswer): PanelRow[] {
  return a.byVersion.map((v) => ({
    key: v.version,
    label: versionLabel(v),
    sub: versionSub(v.kind),
    visits: v.visits,
    conversions: v.conversions,
  }));
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function VisitorsView({
  a,
  window,
  filters,
  onWindow,
  onSet,
  loading,
  testHref,
  linksHref = "/settings?tab=links",
}: {
  a: VisitorsAnswer;
  window: VWindow;
  filters: VFilters;
  onWindow: (w: VWindow) => void;
  /** The filters after a click. */
  onSet: (next: VFilters) => void;
  loading?: boolean;
  testHref: string;
  linksHref?: string;
}) {
  const active = activeFilters(filters);
  const s = summaryFor(a, filters, window);
  const matrix = countryMatrix(a, 9, filters.country);
  const ago = updatedAgo(a.computedAt);
  const onPick = (dim: VDim, value: string) => onSet(toggle(filters, dim, value));
  const onClear = (dim: VDim | "*") =>
    onSet(dim === "*" ? NO_FILTERS : { ...filters, [dim]: null });
  return (
    <div
      className={cn("flex flex-col animate-fade-in", loading && "opacity-70 transition-opacity")}
    >
      <PageHead
        title="Visitors"
        sub={`${ago ? `${ago.charAt(0).toUpperCase()}${ago.slice(1)} · ` : ""}click any row to filter the page`}
        right={<Seg label="Period" values={V_WINDOWS} value={window} onChange={onWindow} />}
      />

      <div className="mt-4 flex min-h-[30px] flex-wrap items-center gap-2.5" aria-live="polite">
        {active.length === 0 ? (
          <span className="text-[12.5px] text-fg-muted">All visitors</span>
        ) : (
          <>
            <span className="text-[12.5px] text-fg-muted">Showing</span>
            {active.map((d) => {
              const label = filterLabel(d, filters[d] as string, a);
              return (
                <button
                  key={d}
                  type="button"
                  data-chip={d}
                  aria-label={`Remove filter ${label}`}
                  onClick={() => onClear(d)}
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-pill bg-fg pl-2.5 pr-1.5 text-xs text-cta-fg"
                >
                  {label}
                  <X size={14} aria-hidden className="opacity-75" />
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => onClear("*")}
              className="text-[12.5px] underline decoration-dotted underline-offset-[3px]"
            >
              Clear
            </button>
          </>
        )}
      </div>
      <p
        aria-live="polite"
        className="mt-3.5 max-w-[46em] text-[17px] font-medium leading-[1.35] tracking-[-0.015em] [text-wrap:pretty] sm:text-xl"
      >
        {s.lead}
        {s.tail && <span className="font-normal text-fg-muted"> {s.tail}</span>}
      </p>

      <Kpis a={a} />
      <Chart a={a} />
      <How summary="What these numbers mean">
        <p>
          A visit is one stay on your site, from the first page until 30 minutes pass without a
          click. Other tools call it a session.
        </p>
        <p>
          Visitors who come back on another day are counted below, under New and returning, while
          Remember returning visitors is on in Settings.
        </p>
        <p>
          Clicked counts a visit once, even if it clicked twice. Which buttons count is set on Test.
        </p>
        <p>Pages counts every page a visit viewed, and a click on the page where it happened.</p>
        <p>Country comes from the connection, never the city.</p>
        <p>
          "Came back" under a source counts return visits that saw that source's version again
          because the browser remembered it. Other analytics tools file those visits as direct.
        </p>
      </How>

      <SectionHead
        title="Where visits came from, and what they did"
        side="Bars show share of visits"
      />
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel
          title="Where they came from"
          unit="sources"
          rows={sourceRows(a)}
          picked={filters.source}
          onPick={(k) => onPick("source", k)}
          limit={7}
        />
        <Panel
          title="Country"
          unit="countries"
          rows={countryRows(a)}
          picked={filters.country}
          onPick={(k) => onPick("country", k)}
          limit={8}
        />
        <Panel
          title="Pages they viewed"
          unit="pages"
          rows={pageRows(a)}
          picked={filters.page}
          onPick={(k) => onPick("page", k)}
          limit={6}
        />
        <Panel
          title="Version they saw"
          unit="versions"
          rows={versionRows(a)}
          picked={filters.version}
          onPick={(k) => onPick("version", k)}
          limit={7}
        />
      </div>

      {a.countryRecording === "off" && (
        <p className="mt-2 text-xs text-fg-muted">
          Country is off for your site, so new visits have none.
        </p>
      )}

      <DirectPanels a={a} filters={filters} onSet={onSet} linksHref={linksHref} />
      <PeoplePanel a={a} />

      {a.byButton !== null && (
        <>
          <SectionHead
            title="Who clicked what"
            side={
              <>
                Buttons that count, set on{" "}
                <Link
                  href={testHref}
                  className="text-fg underline decoration-dotted underline-offset-[3px]"
                >
                  Test
                </Link>
              </>
            }
          />
          <Card className="mt-3 pt-2.5">
            {a.byButton.length === 0 ? (
              <p className="px-4 pb-3 text-[13px] text-fg-muted">
                No clicks on a button that counts yet.
              </p>
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] font-medium text-fg-faint">
                    <th className="border-b border-border px-4 pb-1.5 font-medium">Button</th>
                    <th className="border-b border-border px-4 pb-1.5 text-right font-medium">
                      Clicked
                    </th>
                    <th className="border-b border-border px-4 pb-1.5 font-medium">Most from</th>
                    <th className="hidden border-b border-border px-4 pb-1.5 font-medium sm:table-cell">
                      Most from country
                    </th>
                    <th className="hidden border-b border-border px-4 pb-1.5 font-medium sm:table-cell">
                      Most on version
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.byButton.map((b) => (
                    <tr key={b.label} className="[&:last-child>td]:border-b-0">
                      <td className="border-b border-border px-4 py-2.5 align-top">{b.label}</td>
                      <td className="whitespace-nowrap border-b border-border px-4 py-2.5 text-right align-top font-mono text-[12.5px]">
                        {num(b.clicks)}
                      </td>
                      <td className="border-b border-border px-4 py-2.5 align-top text-[12.5px]">
                        {b.top_source ? (
                          <>
                            {sourceRow(b.top_source.source).label}{" "}
                            <span className="font-mono text-[11.5px] text-fg-muted">
                              {b.top_source.clicks}
                            </span>
                          </>
                        ) : (
                          <span className="text-fg-faint">none yet</span>
                        )}
                      </td>
                      <td className="hidden border-b border-border px-4 py-2.5 align-top text-[12.5px] sm:table-cell">
                        {b.top_country ? (
                          <>
                            {countryName(b.top_country.country)}{" "}
                            <span className="font-mono text-[11.5px] text-fg-muted">
                              {b.top_country.clicks}
                            </span>
                          </>
                        ) : (
                          <span className="text-fg-faint">none yet</span>
                        )}
                      </td>
                      <td className="hidden border-b border-border px-4 py-2.5 align-top text-[12.5px] sm:table-cell">
                        {b.top_version ? (
                          <>
                            {versionLabel(b.top_version)}{" "}
                            <span className="font-mono text-[11.5px] text-fg-muted">
                              {b.top_version.clicks}
                            </span>
                          </>
                        ) : (
                          <span className="text-fg-faint">none yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <SectionHead
        title="Country by version"
        side="Visits, and how many clicked. The dot marks the version with most clicks."
      />
      <Card className="mt-3">
        <div className="overflow-x-auto pt-2.5">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[12.5px]">
            <thead>
              <tr className="text-[11px] font-medium text-fg-faint">
                <th className="whitespace-nowrap border-b border-border pb-1.5 pl-4 pr-2.5 text-left font-medium">
                  Country
                </th>
                {matrix.columns.map((c) => (
                  <th
                    key={c.key}
                    className="whitespace-nowrap border-b border-border px-2.5 pb-1.5 text-right font-medium"
                  >
                    {c.label}
                  </th>
                ))}
                <th className="whitespace-nowrap border-b border-border px-2.5 pb-1.5 text-left font-medium">
                  Most clicks
                </th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => {
                const ck = countryKey(r.country);
                return (
                  <tr key={ck} className="[&:last-child>td]:border-b-0">
                    <td className="sticky left-0 z-[1] whitespace-nowrap border-b border-border bg-surface py-2 pl-4 pr-2.5 text-left">
                      {r.country && r.country !== "other" && (
                        <span className="mr-2 inline-block min-w-6 rounded-[3px] border border-border bg-surface-muted px-1 text-center font-mono text-[10px] font-medium leading-4 text-[#52525b]">
                          {r.country}
                        </span>
                      )}
                      {countryName(r.country)}
                    </td>
                    {matrix.columns.map((c) => {
                      const cell = r.cells[c.key];
                      if (!cell) {
                        return (
                          <td
                            key={c.key}
                            className="border-b border-border px-2.5 py-[7px] text-right font-mono text-xs text-fg-faint"
                          >
                            0
                          </td>
                        );
                      }
                      const on =
                        filters.country === ck &&
                        cell.version !== null &&
                        filters.version === cell.version;
                      const best = r.best === c.key;
                      return (
                        <td key={c.key} className="border-b border-border p-0 text-right">
                          <button
                            type="button"
                            aria-pressed={on}
                            aria-label={`${countryName(r.country)}, ${c.label}: ${cell.visits} visits, ${cell.conversions} clicked`}
                            onClick={() =>
                              onSet(
                                on
                                  ? { ...filters, country: null, version: null }
                                  : {
                                      ...filters,
                                      country: ck,
                                      version: cell.version ?? filters.version,
                                    },
                              )
                            }
                            className={cn(
                              "w-full whitespace-nowrap px-2.5 py-[7px] text-right font-mono text-xs leading-[1.35] hover:bg-surface-muted",
                              on && "bg-surface-muted shadow-[inset_0_-2px_0_var(--fg)]",
                            )}
                          >
                            <b className={cn("block", best ? "font-semibold" : "font-medium")}>
                              {num(cell.visits)}
                            </b>
                            <span
                              className={cn(
                                "block text-[11px]",
                                best ? "text-fg" : "text-fg-muted",
                              )}
                            >
                              {best && (
                                <i
                                  aria-hidden
                                  className="mr-[5px] inline-block h-[5px] w-[5px] rounded-full bg-fg align-[1px]"
                                />
                              )}
                              {cell.conversions} clicked
                            </span>
                          </button>
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap border-b border-border px-2.5 py-2 text-xs text-[#52525b]">
                      {r.best
                        ? (matrix.columns.find((c) => c.key === r.best)?.label ?? "")
                        : "None on a version"}
                    </td>
                  </tr>
                );
              })}
              {matrix.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={matrix.columns.length + 2}
                    className="px-4 py-3 text-[13px] text-fg-muted"
                  >
                    No visits.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-4 py-2 text-[11.5px] text-fg-muted">
          Click a cell to filter the page to that country and version.
        </div>
      </Card>
    </div>
  );
}

/** GET the Visitors answer; a 400 (a filter under its floor) is its own state. */
function useVisitorsRead(path: string): {
  data: unknown;
  loading: boolean;
  failed: boolean;
  refused: boolean;
} {
  const [state, setState] = useState<{ data: unknown; failed: boolean; refused: boolean }>({
    data: null,
    failed: false,
    refused: false,
  });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<unknown>(path)
      .then((data) => !cancelled && setState({ data, failed: false, refused: false }))
      .catch((e) => {
        if (cancelled) return;
        const refused = e instanceof ApiError && e.status === 400;
        setState({ data: null, failed: !refused, refused });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { ...state, loading };
}

/** The screen with its read. */
export function Visitors({ customerId, superadmin }: { customerId: string; superadmin: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { window, filters } = useMemo(() => filtersFromQuery(params), [params]);
  const res = useVisitorsRead(visitorsPath(customerId, window, filters));
  const a = useMemo(() => readVisitors(res.data), [res.data]);
  // The last answer stays on screen while the next one is read (no flash on a click).
  const [last, setLast] = useState<VisitorsAnswer | null>(null);
  if (a && a !== last) setLast(a);
  const shown = a ?? last;

  const go = (w: VWindow, f: VFilters) => {
    const q = new URLSearchParams(params.toString());
    q.set("window", w);
    for (const d of Object.keys(NO_FILTERS) as VDim[]) {
      const v = f[d];
      if (v) q.set(d, v);
      else q.delete(d);
    }
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  if (res.refused) {
    return (
      <div className="flex flex-col">
        <PageHead title="Visitors" sub="Click any row to filter the page" />
        <p className="mt-4 max-w-[60ch] text-[13px] text-fg-muted">{REFUSED_LINE}</p>
        <button
          type="button"
          onClick={() => go(window, NO_FILTERS)}
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "mt-3 self-start bg-surface",
          )}
        >
          Clear filters
        </button>
      </div>
    );
  }
  if (!shown) {
    return (
      <div className="flex flex-col">
        <PageHead title="Visitors" sub="Click any row to filter the page" />
        {res.failed ? (
          <StateLine kind="error">Could not read your visitors. Reload to try again.</StateLine>
        ) : (
          <StateLine kind="loading">Reading your visitors</StateLine>
        )}
      </div>
    );
  }
  return (
    <>
      {res.failed && (
        <StateLine kind="error">That filter could not be read. Clear it to go back.</StateLine>
      )}
      <VisitorsView
        a={shown}
        window={window}
        filters={filters}
        loading={res.loading}
        onWindow={(w) => go(w, filters)}
        onSet={(f) => go(window, f)}
        testHref={superadmin ? withCustomer("/test", customerId) : "/test"}
        linksHref={
          superadmin ? withCustomer("/settings?tab=links", customerId) : "/settings?tab=links"
        }
      />
    </>
  );
}
