"use client";

/**
 * "Read what your visitors see" on Live (mock section 03, the privacy review's
 * note): the versions of the biggest sources so far, one source and one page
 * at a time, so the prospect reads what the report will show before it goes
 * out. Names come from the Results breakdown with its own 5-visit floor; the
 * row marked "Likely in your report" is the one the report's sample would
 * pick today (the biggest AI name first, then the biggest name; its most seen
 * intent). With no name over the floor: the ChatGPT link to the homepage,
 * the report's own fallback, classified here by the same shared code.
 */

import { Marked } from "@/components/ui/Marked";
import { apiFetch } from "@/lib/api";
import { auditRefusal } from "@/lib/audit";
import { INTENT_LABEL } from "@/lib/results";
import { cn } from "@/lib/utils";
import type { AnalyticsBreakdown } from "@/types/api";
import { type VariantBody, classify, extractSignals, selectVariantKey } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { useEffect, useMemo, useState } from "react";
import { TINT, WARN_WASH } from "../start/tones";

/** A source dimension's versions; the generation writes no paid or direct ones. */
const VERSION_SOURCE: Record<string, string> = {
  ai: "ai",
  social: "social",
  community: "community",
  organic: "organic",
  paid: "default",
  direct: "default",
};

const INTENT_ORDER = ["problem", "evaluation", "competitor", "feature", "pricing", "brand"];
const WORDS = ["", "One", "Two", "Three", "Four", "Five"];

export interface SourceChip {
  name: string;
  label: string;
  source_dim: string;
  visits: number;
}

/** The names over the floor, the report's pick first (an AI name, else the biggest). */
export function sourceChips(b: Pick<AnalyticsBreakdown, "by_source"> | null): SourceChip[] {
  const all: SourceChip[] = [];
  for (const row of b?.by_source ?? []) {
    for (const n of row.names ?? []) {
      all.push({ name: n.name, label: n.label, source_dim: row.source_dim, visits: n.visits });
    }
  }
  all.sort((a, b2) => b2.visits - a.visits);
  const ai = all.find((c) => c.source_dim === "ai");
  const ordered = ai ? [ai, ...all.filter((c) => c !== ai)] : all;
  return ordered.slice(0, 3);
}

/** The intent the report's sample would show for a source: its most seen, from the breakdown. */
export function likelyIntent(
  b: Pick<AnalyticsBreakdown, "by_tuple"> | null,
  sourceDim: string,
): string | null {
  let best: string | null = null;
  let top = 0;
  for (const r of b?.by_tuple ?? []) {
    if (r.source_dim !== sourceDim || !r.intent_dim) continue;
    if (r.visits > top) {
      top = r.visits;
      best = r.intent_dim;
    }
  }
  return best;
}

/** The intent the edge picks for a ChatGPT link to the homepage (the report's "would see"). */
export function chatgptIntent(domain: string, served: readonly string[] | null): string {
  try {
    const url = new URL(`${siteOrigin(domain)}/?utm_source=chatgpt.com`);
    const headers = new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" });
    const sel = selectVariantKey(
      classify(extractSignals({ url, headers, entryPath: "/" }), Date.now(), null),
    );
    return !served || served.includes(sel.intent_dim) ? sel.intent_dim : "evaluation";
  } catch {
    return "evaluation";
  }
}

interface Row {
  intent: string;
  body: VariantBody | null;
}

export function VisitorVersionsView({
  chips,
  chip,
  onChip,
  pages,
  page,
  onPage,
  rows,
  likely,
  open,
  onToggle,
  onRewrite,
  rewriting,
  refusal,
  expanded,
  onExpand,
  loading,
}: {
  chips: SourceChip[] | null;
  chip: number;
  onChip: (i: number) => void;
  pages: string[];
  page: string;
  onPage: (p: string) => void;
  rows: Row[];
  likely: string | null;
  open: Set<string>;
  onToggle: (intent: string) => void;
  onRewrite: (intent: string) => void;
  rewriting: string | null;
  refusal: string | null;
  expanded: boolean;
  onExpand: () => void;
  loading?: boolean;
}) {
  const named = chips !== null && chips.length > 0;
  const shownChips: { label: string }[] = named ? chips : [{ label: "ChatGPT" }];
  const more = rows.length - 3;
  return (
    <section
      className="mb-6 rounded-md border border-border bg-surface"
      aria-label="Read what your visitors see"
    >
      <div className="px-3.5 pb-2.5 pt-3.5 sm:px-4 sm:pb-3 sm:pt-4">
        <h2 className="text-sm font-semibold text-fg">Read what your visitors see</h2>
        <p className="mt-1 text-[13px] text-fg-muted">
          Your report shows one of these. Read them before it goes out.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-3.5 pb-3 sm:px-4">
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <span className="mr-2 text-xs text-fg-muted">
            {named ? "Most visits so far" : "Until visits arrive"}
          </span>
          <Seg items={shownChips.map((c) => c.label)} on={named ? chip : 0} onPick={onChip} />
        </div>
        {pages.length > 1 && (
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
            <Seg
              items={pages}
              on={Math.max(0, pages.indexOf(page))}
              onPick={(i) => onPage(pages[i] ?? "/")}
              mono
            />
          </div>
        )}
      </div>
      {loading ? (
        <p className="border-t border-border px-4 py-3 text-[13px] text-fg-muted">
          Reading the versions…
        </p>
      ) : (
        rows.map((r, i) => {
          const hero = r.body?.sections.hero;
          const isLikely = r.intent === likely;
          const isOpen = open.has(r.intent);
          return (
            <div
              key={r.intent}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-t border-border px-3.5 py-2.5 text-[13px] sm:grid-cols-[128px_minmax(0,1fr)_auto] sm:px-4",
                isLikely && "bg-[color-mix(in_srgb,var(--state-success)_4%,transparent)]",
                i >= 3 && !expanded && "hidden sm:grid",
              )}
            >
              <span className="col-start-1 row-start-1 text-xs text-fg-muted">
                {INTENT_LABEL[r.intent] ?? r.intent}
              </span>
              <span className="col-span-2 font-medium leading-[1.45] text-fg sm:col-span-1 sm:col-start-2 sm:row-start-1">
                {hero?.headline ? (
                  <Marked text={hero.headline} />
                ) : (
                  <span className="font-normal text-fg-faint">Not written yet</span>
                )}
              </span>
              <span className="col-start-2 row-start-1 flex items-center gap-3 justify-self-end sm:col-start-3">
                {isLikely && (
                  <span
                    className={cn(
                      "whitespace-nowrap rounded-full px-2 py-[5px] text-[11px] leading-none",
                      TINT.ok,
                    )}
                  >
                    Likely in your report
                  </span>
                )}
                {hero && (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => onToggle(r.intent)}
                    className="whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg"
                  >
                    {isOpen ? "Close" : "Read"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={rewriting !== null}
                  onClick={() => onRewrite(r.intent)}
                  className="hidden whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg disabled:opacity-50 sm:inline"
                >
                  {rewriting === r.intent ? "Rewriting…" : "Rewrite"}
                </button>
              </span>
              {isOpen && hero && (
                <span className="col-span-2 text-[12.5px] leading-[1.55] text-fg-muted sm:col-span-1 sm:col-start-2">
                  {hero.body && <Marked text={hero.body} />}
                  {hero.cta?.label && (
                    <>
                      <br />
                      <span className="mt-1.5 inline-block rounded-sm bg-cta-bg px-2 py-[3px] text-[11px] font-medium text-cta-fg">
                        <Marked text={hero.cta.label} />
                      </span>
                    </>
                  )}
                  <br className="sm:hidden" />
                  <button
                    type="button"
                    disabled={rewriting !== null}
                    onClick={() => onRewrite(r.intent)}
                    className="mt-2 text-xs underline decoration-dotted underline-offset-[3px] sm:hidden"
                  >
                    {rewriting === r.intent ? "Rewriting…" : "Rewrite"}
                  </button>
                </span>
              )}
            </div>
          );
        })
      )}
      {refusal && (
        <p
          className={cn(
            "border-t border-border px-4 py-2.5 text-[13px] text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]",
            WARN_WASH,
          )}
        >
          {refusal}
        </p>
      )}
      <p className="border-t border-border px-3.5 py-2.5 text-xs text-fg-muted sm:px-4">
        {more > 0 && !expanded && (
          <button
            type="button"
            onClick={onExpand}
            className="mr-1 underline decoration-dotted underline-offset-[3px] hover:text-fg sm:hidden"
          >
            {WORDS[more] ?? more} more.
          </button>
        )}
        Names show after 5 visits.{" "}
        <span className="hidden sm:inline">Rewrite writes one version again.</span>
      </p>
    </section>
  );
}

export function Seg({
  items,
  on,
  onPick,
  mono,
}: {
  items: string[];
  on: number;
  onPick: (i: number) => void;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-sm border border-border bg-surface-muted p-0.5">
      {items.map((label, i) => (
        <button
          key={label}
          type="button"
          aria-pressed={i === on}
          onClick={() => onPick(i)}
          className={cn(
            "inline-flex h-[22px] items-center whitespace-nowrap rounded-[3px] border px-[9px]",
            mono ? "font-mono text-[11.5px]" : "text-xs",
            i === on
              ? "border-border-strong bg-surface font-medium text-fg"
              : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** The card with its reads: the breakdown once, the six versions per source and page. */
export function VisitorVersions({
  customerId,
  domain,
  pages,
  served,
}: {
  customerId: string;
  domain: string;
  pages: string[];
  served: readonly string[] | null;
}) {
  const [breakdown, setBreakdown] = useState<AnalyticsBreakdown | null>(null);
  const [chips, setChips] = useState<SourceChip[] | null>(null);
  const [chip, setChip] = useState(0);
  const sorted = useMemo(() => {
    const ps = [...new Set(pages)];
    return ps.includes("/") ? ["/", ...ps.filter((p) => p !== "/")] : ps;
  }, [pages]);
  const [page, setPage] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AnalyticsBreakdown>(
      `/admin/analytics/breakdown?customer_id=${encodeURIComponent(customerId)}&window=30d`,
    )
      .then((b) => {
        if (cancelled) return;
        setBreakdown(b);
        setChips(sourceChips(b));
        // The report's page: the most visited page with its own versions.
        const top = (b.pages?.pages ?? [])
          .filter((p) => p.has_versions)
          .sort((x, y) => y.signal_visits - x.signal_visits)[0];
        if (top && pages.includes(top.page_path)) setPage(top.page_path);
      })
      .catch(() => {
        if (!cancelled) setChips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, pages]);

  const named = chips !== null && chips.length > 0;
  const sel = named ? chips[chip] : null;
  const sourceDim = sel ? (VERSION_SOURCE[sel.source_dim] ?? "default") : "ai";
  const pickedPage = page ?? sorted[0] ?? "/";
  const isReportPick = named ? chip === 0 : true;
  const likely = !isReportPick
    ? null
    : named
      ? likelyIntent(breakdown, sel?.source_dim ?? "")
      : chatgptIntent(domain, served);
  const servedKey = served ? served.join(",") : "*";

  // biome-ignore lint/correctness/useExhaustiveDependencies: servedKey stands in for served, key reloads
  useEffect(() => {
    if (chips === null) return;
    let cancelled = false;
    setLoading(true);
    const intents = INTENT_ORDER.filter((d) => !served || served.includes(d));
    Promise.all(
      intents.map((intent) =>
        apiFetch<VariantBody>(
          `/admin/variant/get?customer_id=${encodeURIComponent(customerId)}&intent=${intent}&source=${sourceDim}&page_path=${encodeURIComponent(pickedPage)}`,
        )
          .then((body) => ({ intent, body }))
          .catch(() => ({ intent, body: null })),
      ),
    ).then((rs) => {
      if (cancelled) return;
      setRows(rs);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, chips, sourceDim, pickedPage, servedKey, key]);

  const ordered = likely
    ? [...rows.filter((r) => r.intent === likely), ...rows.filter((r) => r.intent !== likely)]
    : rows;
  const openSet = new Set(open);
  if (likely && !open.has(`-${likely}`)) openSet.add(likely);

  async function rewrite(intent: string) {
    setRewriting(intent);
    setRefusal(null);
    try {
      await apiFetch("/admin/variant/regenerate", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          intent_dim: intent,
          source_dim: sourceDim,
          page_path: pickedPage,
        }),
      });
      setKey((k) => k + 1);
    } catch (e) {
      setRefusal(auditRefusal(e)?.message ?? "Could not rewrite it just now. Try again.");
    } finally {
      setRewriting(null);
    }
  }

  return (
    <VisitorVersionsView
      chips={chips}
      chip={chip}
      onChip={(i) => setChip(i)}
      pages={sorted}
      page={pickedPage}
      onPage={setPage}
      rows={ordered}
      likely={likely}
      open={openSet}
      onToggle={(intent) =>
        setOpen((prev) => {
          const next = new Set(prev);
          const isOn = openSet.has(intent);
          if (intent === likely) {
            // The likely row starts open; "-intent" records that it was closed.
            if (isOn) next.add(`-${intent}`);
            else next.delete(`-${intent}`);
          } else if (isOn) next.delete(intent);
          else next.add(intent);
          return next;
        })
      }
      onRewrite={(intent) => void rewrite(intent)}
      rewriting={rewriting}
      refusal={refusal}
      expanded={expanded}
      onExpand={() => setExpanded(true)}
      loading={loading && rows.length === 0}
    />
  );
}
