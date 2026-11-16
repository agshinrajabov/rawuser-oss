"use client";

/**
 * Overview (design/mock/dashboard-v2/app.html, section 01): one sentence at
 * the top, three numbers that each open their screen, then at most three
 * things that need the customer, each with one button.
 */

import { useProof } from "@/components/analytics/ProofSection";
import { useReadiness } from "@/components/readiness/useReadiness";
import { itemsOf } from "@/components/shell/useWaitingCount";
import { buttonVariants } from "@/components/ui/Button";
import { pendingCount } from "@/lib/approval";
import {
  type AttentionRow,
  attentionRows,
  bestSource,
  overviewSentence,
  rate,
  testTile,
  visitsChange,
} from "@/lib/overview";
import { num } from "@/lib/proof";
import { withCustomer } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type {
  AnalyticsBreakdown,
  AnalyticsOverview,
  AnalyticsTimeseries,
  LiftReport,
  VariantListAnswer,
} from "@/types/api";
import { AlertTriangle, ArrowRight, Info, Link2 } from "lucide-react";
import Link from "next/link";
import { BigLine, Card, PageHead, StateLine, TONE, updatedAgo, useJson } from "./parts";

export interface OverviewData {
  visits: number;
  clicked: number;
  change: { value: string; up: boolean; rest: string } | null;
  spark: number[];
  best: { source: string; rate: number } | null;
  buttons: string[];
  report: LiftReport | null;
  attention: AttentionRow[];
  updated: string | null;
}

function Spark({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  return (
    <span aria-hidden className="mt-2.5 flex h-7 items-end gap-0.5">
      {values.map((v, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed series of days
          key={i}
          className={cn(
            "min-h-[2px] flex-1 rounded-[1px]",
            i === values.length - 1 ? "bg-fg" : "bg-border-strong",
          )}
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

function Tile({
  href,
  k,
  children,
}: {
  href: string;
  k: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col gap-0.5 px-[18px] pb-4 pt-3.5 text-inherit transition-colors duration-fast ease-smooth hover:bg-surface-muted/50 [&+&]:border-t [&+&]:border-border sm:[&+&]:border-l sm:[&+&]:border-t-0"
    >
      <span className="flex items-center justify-between text-xs font-medium text-fg-muted">
        {k}
        <ArrowRight size={14} aria-hidden className="text-fg-faint group-hover:text-fg" />
      </span>
      {children}
    </Link>
  );
}

const ICON = { alert: AlertTriangle, link: Link2, info: Info } as const;

export function OverviewView({
  data,
  link,
}: {
  data: OverviewData;
  /** Keeps the superadmin's picked customer on every link. */
  link: (href: string) => string;
}) {
  const s = overviewSentence(data.visits, data.clicked, data.best);
  const t = testTile(data.report);
  const on =
    data.buttons.length === 1
      ? `On ${data.buttons[0]}`
      : data.buttons.length > 1
        ? `On ${data.buttons.length} buttons`
        : "No button chosen yet";
  return (
    <div className="flex flex-col animate-fade-in">
      <PageHead title="Overview" sub={`Last 30 days${data.updated ? ` · ${data.updated}` : ""}`} />
      <BigLine className="mt-5 sm:mt-7" lead={s.lead} tail={s.tail} />

      <div className="mt-6 grid grid-cols-1 rounded-md border border-border bg-surface sm:grid-cols-3">
        <Tile href={link("/visitors")} k="Visits">
          <span className="mt-1 font-mono text-[26px] font-semibold leading-tight tracking-[-0.02em]">
            {num(data.visits)}
          </span>
          <span className="text-xs text-fg-muted">
            {data.change ? (
              <>
                <span className={data.change.up ? TONE.OK_TEXT : undefined}>
                  {data.change.value}
                </span>{" "}
                {data.change.rest}
              </>
            ) : (
              "Every visit to every page"
            )}
          </span>
          <Spark values={data.spark} />
        </Tile>
        <Tile href={link("/visitors")} k="Clicked a button that counts">
          <span className="mt-1 font-mono text-[26px] font-semibold leading-tight tracking-[-0.02em]">
            {num(data.clicked)}
            <small className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-fg-muted">
              {rate(data.clicked, data.visits)} of visits
            </small>
          </span>
          <span className="text-xs text-fg-muted">{on}</span>
        </Tile>
        <Tile href={link("/test")} k="Test: versions against your page">
          <span className="mt-1 font-mono text-[26px] font-semibold leading-tight tracking-[-0.02em]">
            {t.value}
            {t.small && (
              <small className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-fg-muted">
                {t.small}
              </small>
            )}
          </span>
          <span className="text-xs text-fg-muted">{t.line}</span>
        </Tile>
      </div>

      <section className="mt-9" aria-labelledby="att-h">
        <h2 id="att-h" className="text-[15px] font-semibold tracking-[-0.005em]">
          Needs your attention
        </h2>
        {data.attention.length === 0 ? (
          <p className="mt-3 text-[13px] text-fg-muted">Nothing right now.</p>
        ) : (
          <Card className="mt-3">
            {data.attention.map((a) => {
              const Icon = ICON[a.icon];
              return (
                <div
                  key={a.id}
                  data-attention={a.id}
                  className="grid grid-cols-[20px_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 sm:grid-cols-[20px_minmax(0,1fr)_auto] sm:px-[18px] [&+&]:border-t [&+&]:border-border"
                >
                  <Icon
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden
                    className={cn(
                      "self-start pt-px",
                      a.icon === "alert" ? "text-state-warn" : "text-fg-muted",
                    )}
                  />
                  <div>
                    <p className="text-[13.5px] font-medium">{a.title}</p>
                    {a.line && <p className="mt-px text-[12.5px] text-fg-muted">{a.line}</p>}
                  </div>
                  <Link
                    href={link(a.action.href)}
                    className={cn(
                      buttonVariants({ variant: "secondary", size: "sm" }),
                      "col-start-2 justify-self-start bg-surface sm:col-start-3",
                    )}
                  >
                    {a.action.label}
                  </Link>
                </div>
              );
            })}
          </Card>
        )}
      </section>
    </div>
  );
}

/** The screen with its reads. */
export function Overview({ customerId, superadmin }: { customerId: string; superadmin: boolean }) {
  const q = `customer_id=${encodeURIComponent(customerId)}`;
  const ov = useJson<AnalyticsOverview>(`/admin/analytics/overview?${q}&window=30d`);
  const bd = useJson<AnalyticsBreakdown>(`/admin/analytics/breakdown?${q}&window=30d`);
  const ts = useJson<AnalyticsTimeseries>(`/admin/analytics/timeseries?${q}`);
  const list = useJson<VariantListAnswer>(`/admin/variants/list?${q}`);
  const proof = useProof(customerId, false);
  const readiness = useReadiness(customerId);
  const link = (href: string) => (superadmin ? withCustomer(href, customerId) : href);

  if (ov.loading && !ov.data) return <StateLine kind="loading">Reading the last 30 days</StateLine>;

  const o = ov.data;
  const data: OverviewData = {
    visits: o?.hero.total_visits ?? 0,
    clicked: o?.hero.total_conversions ?? 0,
    change: visitsChange(o),
    spark: (ts.data?.series ?? []).slice(-30).map((p) => p.visits),
    best: bestSource(bd.data?.by_source),
    buttons: proof.report?.metric.labels ?? [],
    report: proof.report,
    attention: attentionRows({
      items: list.data ? itemsOf(list.data) : null,
      pending: pendingCount(o, list.data ? itemsOf(list.data) : null),
      noSignalVisits: bd.data?.unknown?.visits ?? o?.cohorts.no_signal.visits ?? 0,
      readiness: readiness.answer,
    }),
    updated: updatedAgo(o?.computed_at),
  };
  return (
    <>
      {ov.failed && (
        <StateLine kind="error">Could not read the numbers. Reload to try again.</StateLine>
      )}
      <OverviewView data={data} link={link} />
    </>
  );
}
