"use client";

/**
 * Versions (design/mock/dashboard-v2/app.html, section 03). One page at a
 * time. Left: the kinds of visitor, by where they came from. Right: their
 * words beside the page's own, why they came as a second choice, and what
 * the version did. "Came straight to the page" sits in the list so the
 * customer sees why those visits get nothing, and how to change it.
 *
 * Approve shows only for a version the API marks as waiting (lib/approval.ts);
 * today none is. A customer asks for a rewrite, never edits the words; the
 * worker holds the daily cap. No "Turn off": there is no customer call for
 * it yet.
 */

import { forgetWaiting, itemsOf } from "@/components/shell/useWaitingCount";
import { useSiteMap } from "@/components/start/useSiteMap";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Marked } from "@/components/ui/Marked";
import { apiFetch } from "@/lib/api";
import {
  APPROVAL_LINES,
  type PendingItem,
  approve,
  approveAll,
  discard,
  pendingPath,
  readPending,
  rewrittenAgo,
  waitingSince,
} from "@/lib/approval";
import { apiMessage } from "@/lib/audit";
import { type ChoiceState, answerShare, choiceLead, choicePath, readChoice } from "@/lib/direct";
import { KINDS, type VisitorKind, marketKind, pageName, reasonLabel } from "@/lib/kinds";
import { num } from "@/lib/proof";
import { withCustomer } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  KIND_LINE,
  type KindState,
  WAITS_LINE,
  firstReason,
  kindCounts,
  kindState,
  pct,
  reasonsServed,
  versionCounts,
  versionState,
  waitingParts,
} from "@/lib/versions-screen";
import {
  type CustomerVersionList,
  LINES,
  type PartRow,
  livePages,
  partRows,
  rewriteLine,
} from "@/lib/your-versions";
import type {
  AnalyticsBreakdown,
  ManifestResponse,
  ManifestsAllResponse,
  VariantListAnswer,
  VariantListItem,
} from "@/types/api";
import type { VariantBody } from "@rawuser/shared";
import { Loader2, PenLine, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChoiceCard } from "./VisitorChoice";
import { Card, PageHead, Pill, Seg, StateLine, TONE, useJson } from "./parts";

const DIRECT = "direct";
const BUTTON = /\.(label|submit_label)$/;

function PartText({ path, text, orig }: { path: string; text: string; orig?: boolean }) {
  if (BUTTON.test(path)) {
    return (
      <span
        className={cn(
          "inline-block rounded-[3px] px-2 py-[3px] text-[11.5px] font-medium text-cta-fg",
          orig ? "bg-fg-muted" : "bg-cta-bg",
        )}
      >
        <Marked text={text} />
      </span>
    );
  }
  return <Marked text={text} />;
}

export function CompareParts({
  parts,
  left = LINES.yourPage,
  right = LINES.thisVersion,
}: {
  parts: PartRow[];
  /** "Live now" and "New, waiting" for a version that waits for the OK. */
  left?: string;
  right?: string;
}) {
  return (
    <div className="mt-3.5 rounded-sm border border-border bg-surface-muted">
      <div className="hidden grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b border-border px-3.5 py-[7px] font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-faint sm:grid">
        <span />
        <span>{left}</span>
        <span>{right}</span>
      </div>
      {parts.map((p) => {
        const hl = p.path === "hero.headline";
        return (
          <div
            key={p.path}
            className="grid grid-cols-1 gap-1.5 px-3.5 py-2.5 sm:grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4 [&+&]:border-t [&+&]:border-border"
          >
            <span className="pt-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-muted sm:font-sans sm:text-xs sm:normal-case sm:tracking-normal">
              {p.name}
            </span>
            <span
              className={cn(
                "text-fg-muted",
                hl ? "text-[15px] leading-[1.4] tracking-[-0.01em]" : "text-[13px] leading-[1.55]",
              )}
            >
              <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-fg-faint sm:hidden">
                {left}
              </span>
              {p.original ? (
                <PartText path={p.path} text={p.original} orig />
              ) : (
                <span className="text-fg-faint">{LINES.noOriginal}</span>
              )}
            </span>
            <span
              className={cn(
                "rounded-[3px] bg-surface px-2 py-1.5 text-fg sm:-mx-2 sm:-my-1 sm:py-1",
                hl
                  ? "text-[15px] font-medium leading-[1.4] tracking-[-0.01em]"
                  : "text-[13px] leading-[1.55]",
              )}
            >
              <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-fg-faint sm:hidden">
                {right}
              </span>
              {p.version ? (
                <PartText path={p.path} text={p.version} />
              ) : (
                <span className="text-fg-faint">{LINES.asBuilt}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface KindRow {
  kind: VisitorKind;
  state: KindState;
  visits: number;
  conversions: number;
}

export function KindList({
  rows,
  markets = [],
  picked,
  onPick,
  choice = null,
}: {
  rows: KindRow[];
  /** Market versions (ADR 0038 part 5): under the line, beside Came straight. */
  markets?: KindRow[];
  picked: string;
  onPick: (source: string) => void;
  /** The visitor choice, when the worker has it: the direct row says whether they are asked. */
  choice?: ChoiceState | null;
}) {
  const asking = !!choice?.on && !choice.killed && !!choice.live;
  const kindButton = (r: KindRow) => {
    const on = picked === r.kind.source;
    return (
      <button
        key={r.kind.source}
        type="button"
        aria-pressed={on}
        data-kind={r.kind.source}
        onClick={() => onPick(r.kind.source)}
        className={cn(
          "grid flex-none grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b-2 px-3.5 py-2.5 text-left lg:w-full lg:border-b-0 lg:py-[9px]",
          on ? "border-fg bg-surface-muted" : "border-transparent hover:bg-surface-muted/60",
        )}
      >
        <span className={cn("text-[13px]", on ? "font-semibold" : "font-medium")}>
          {r.kind.label}
        </span>
        <span className="hidden text-right font-mono text-[11.5px] text-fg-muted lg:inline">
          {r.visits > 0 ? pct(r.conversions, r.visits) : ""}
        </span>
        <span className="col-span-2 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fg-muted">
          <i
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 flex-none rounded-full",
              r.state === "live" && "bg-state-success",
              r.state === "waiting" && "bg-state-warn",
              (r.state === "none" || r.state === "rewriting") && "bg-fg-faint",
            )}
          />
          {r.state === "live" && r.visits > 0
            ? `Live · ${num(r.visits)} visits`
            : KIND_LINE[r.state]}
        </span>
      </button>
    );
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the mock draws it
    <div
      role="group"
      aria-label="Kind of visitor"
      className="flex overflow-x-auto rounded-md border border-border bg-surface lg:block lg:py-1.5"
    >
      {rows.map(kindButton)}
      <hr className="m-0 hidden border-0 border-t border-border lg:my-1.5 lg:block" />
      <button
        type="button"
        aria-pressed={picked === DIRECT}
        data-kind={DIRECT}
        onClick={() => onPick(DIRECT)}
        className={cn(
          "grid flex-none grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b-2 px-3.5 py-2.5 text-left lg:w-full lg:border-b-0 lg:py-[9px]",
          picked === DIRECT
            ? "border-fg bg-surface-muted"
            : "border-transparent hover:bg-surface-muted/60",
        )}
      >
        <span
          className={cn(
            "text-[13px]",
            asking ? "font-medium" : "text-fg-muted",
            picked === DIRECT && "font-semibold",
          )}
        >
          Came straight to the page
        </span>
        <span className="hidden text-right font-mono text-[11.5px] text-fg-muted lg:inline">
          {asking ? (answerShare(choice) ?? "") : "no version"}
        </span>
        <span className="col-span-2 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fg-muted">
          <i
            aria-hidden
            className={cn("h-1.5 w-1.5 flex-none rounded-full", asking ? "bg-fg" : "bg-fg-faint")}
          />
          {asking ? "Asked what brings them" : "Sees your original page"}
        </span>
      </button>
      {markets.map(kindButton)}
    </div>
  );
}

export interface DirectChoice {
  customerId: string;
  state: ChoiceState;
  onState: (s: ChoiceState) => void;
  /** The page picked: the question runs on the home page only. */
  page: string;
  onOpenVersion?: (intent: string, source: string) => void;
  testHref: string;
}

export function DirectDetail({
  linksHref,
  choice = null,
}: {
  linksHref: string;
  /** The visitor choice; null on a worker without it, which keeps the tagged-link box. */
  choice?: DirectChoice | null;
}) {
  const head = (pill: React.ReactNode) => (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.005em]">Came straight to the page</h2>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">
          Typed the address, a bookmark, or an app that hides where it came from
        </p>
      </div>
      {pill}
    </div>
  );
  if (choice && choice.page === "/") {
    const st = choice.state;
    const asking = st.on && !st.killed && !!st.live;
    const lead = choiceLead(st);
    return (
      <Card className="px-3.5 py-3.5 sm:px-[18px] sm:pb-[18px] sm:pt-4">
        {head(asking ? <Pill tone="ok">Asking</Pill> : <Pill>Not asked</Pill>)}
        <p className="mt-3.5 max-w-[46em] text-[15px] leading-[1.45] tracking-[-0.005em]">
          {lead.lead}
          {lead.tail && <span className="text-fg-muted"> {lead.tail}</span>}
        </p>
        <ChoiceCard
          customerId={choice.customerId}
          state={st}
          onState={choice.onState}
          onOpenVersion={choice.onOpenVersion}
          testHref={choice.testHref}
        />
        <p className="mt-3 text-xs text-fg-muted">
          A tagged link in your posts and newsletters gives them a version too.{" "}
          <Link
            href={linksHref}
            className="text-fg underline decoration-dotted underline-offset-[3px]"
          >
            Make a tagged link
          </Link>
        </p>
      </Card>
    );
  }
  return (
    <Card className="px-4 py-4 sm:px-[18px]">
      {head(null)}
      <div className="mt-3.5 flex flex-col items-start gap-2.5 rounded-sm border border-dashed border-border-strong p-3.5 text-[13px] text-fg-muted">
        <p>We have nothing to go on for these visits, so they see your page as built.</p>
        <p>A tagged link in your posts, ads and newsletters gives them a version.</p>
        {choice && <p>The question for these visits runs on your home page.</p>}
        <Link
          href={linksHref}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "bg-surface")}
        >
          Make a tagged link
        </Link>
      </div>
    </Card>
  );
}

export interface DetailProps {
  kind: VisitorKind;
  reasons: { intent: string; visits: number; waiting?: boolean }[];
  reason: string;
  onReason: (intent: string) => void;
  state: KindState;
  waitingLine: string | null;
  parts: PartRow[] | null;
  /** A waiting version: its new words beside the live ones (GET /admin/variants/pending). */
  waiting?: { parts: PartRow[]; hasLive: boolean } | null;
  /** Null for a market version: its visits count under Came straight, by country. */
  counts: { visits: number; conversions: number } | null;
  visitorsHref: string;
  onRewrite: () => void;
  onApprove: () => void;
  onDiscard?: () => void;
  busy: "rewrite" | "approve" | "discard" | "all" | null;
  said: string | null;
  canRewrite: boolean;
}

export function VersionDetail(p: DetailProps) {
  const pill =
    p.state === "waiting" ? (
      <Pill tone="warn">Waiting for your OK</Pill>
    ) : p.state === "live" ? (
      <Pill tone="ok">Live</Pill>
    ) : p.state === "rewriting" ? (
      <Pill>Being rewritten</Pill>
    ) : (
      <Pill>Not written yet</Pill>
    );
  return (
    <Card className="px-3.5 py-3.5 sm:px-[18px] sm:pb-[18px] sm:pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.005em]">
            {p.kind.label.startsWith("Visitors")
              ? p.kind.label
              : `Visitors ${p.kind.label.charAt(0).toLowerCase()}${p.kind.label.slice(1)}`}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{p.kind.who}</p>
        </div>
        {pill}
      </div>

      {p.reasons.length > 1 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-fg-muted">Why they came</span>
          {p.reasons.map((r) => (
            <button
              key={r.intent}
              type="button"
              aria-pressed={p.reason === r.intent}
              onClick={() => p.onReason(r.intent)}
              className={cn(
                "inline-flex h-[26px] items-center gap-1.5 rounded-pill border bg-surface px-2.5 text-xs",
                p.reason === r.intent
                  ? "border-fg font-medium text-fg"
                  : "border-border text-[#52525b] hover:border-border-strong",
              )}
            >
              {r.waiting && (
                <i
                  aria-label="waiting for your OK"
                  className="h-1.5 w-1.5 rounded-full bg-state-warn"
                />
              )}
              {reasonLabel(r.intent)}
              {r.visits > 0 && (
                <span className="font-mono text-[10.5px] text-fg-faint">{num(r.visits)}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {p.state === "waiting" && (
        <div
          className={cn(
            "mt-3.5 flex flex-wrap items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-[12.5px]",
            TONE.WARN_TINT,
            TONE.WARN_TEXT,
          )}
        >
          <span>
            {p.waitingLine ? `${p.waitingLine} ` : ""}Visitors see the old one until you approve.
          </span>
          <span className="flex gap-2">
            <Button type="button" size="sm" onClick={p.onApprove} disabled={p.busy !== null}>
              {p.busy === "approve" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              Approve
            </Button>
            {p.onDiscard && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={p.onDiscard}
                disabled={p.busy !== null}
              >
                {p.busy === "discard" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                Discard
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={p.onRewrite}
              disabled={p.busy !== null || !p.canRewrite}
            >
              Rewrite again
            </Button>
          </span>
        </div>
      )}

      {p.parts === null ? (
        <p className="mt-3.5 flex items-center gap-2 text-[13px] text-fg-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Reading the version
        </p>
      ) : p.state === "waiting" && p.waiting && p.waiting.parts.length > 0 ? (
        <CompareParts
          parts={p.waiting.parts}
          left={p.waiting.hasLive ? "Live now" : LINES.yourPage}
          right="New, waiting"
        />
      ) : p.parts.length === 0 ? (
        <p className="mt-3.5 text-[13px] text-fg-muted">This page has no parts to compare yet.</p>
      ) : (
        <CompareParts parts={p.parts} />
      )}

      <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-fg-muted">
        {p.counts ? (
          <>
            <span>
              Seen by <b className="font-mono font-medium text-fg">{num(p.counts.visits)}</b> visits
              in 30 days, all pages
            </span>
            <span>
              <b className="font-mono font-medium text-fg">{num(p.counts.conversions)}</b> clicked
            </span>
            <span>
              <b className="font-mono font-medium text-fg">
                {pct(p.counts.conversions, p.counts.visits)}
              </b>{" "}
              click rate
            </span>
          </>
        ) : (
          <span>Its visits count under Came straight to the page, by country.</span>
        )}
        <Link
          href={p.visitorsHref}
          className="text-fg underline decoration-dotted underline-offset-[3px]"
        >
          See on Visitors
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {p.state !== "waiting" && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="bg-surface"
              onClick={p.onRewrite}
              disabled={p.busy !== null || !p.canRewrite}
            >
              {p.busy === "rewrite" ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <PenLine size={12} aria-hidden />
              )}
              {p.busy === "rewrite" ? "Rewriting" : "Rewrite"}
            </Button>
          )}
          <span aria-live="polite" className="text-xs text-fg-muted">
            {p.said}
          </span>
        </div>
        <span className="text-xs text-fg-muted">A rewrite takes about a minute.</span>
      </div>
    </Card>
  );
}

/** More than one version of the page waits: one line and Approve all. */
export function PageWaiting({
  count,
  busy,
  disabled,
  said,
  onApproveAll,
}: {
  count: number;
  busy: boolean;
  disabled: boolean;
  said: string | null;
  onApproveAll: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "mt-3.5 flex flex-wrap items-center justify-between gap-3 rounded-sm px-3 py-2.5 text-[12.5px]",
        count > 1 ? cn(TONE.WARN_TINT, TONE.WARN_TEXT) : "bg-surface-muted text-fg-muted",
      )}
    >
      <span>{count > 1 ? `${count} new versions on this page wait for your OK.` : said}</span>
      {count > 1 && (
        <span className="flex items-center gap-3">
          {said && <span>{said}</span>}
          <Button type="button" size="sm" onClick={onApproveAll} disabled={disabled}>
            {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            Approve all {count}
          </Button>
        </span>
      )}
    </div>
  );
}

interface RewriteAnswer {
  ok?: boolean;
  error?: string;
  body?: VariantBody;
  rewrites_left?: number;
  /** The new body waits for the OK; visitors keep the old (versions-approval.md §4). */
  pending?: boolean;
}

const cell = (page: string, source: string, intent: string) => `${page}\n${source}\n${intent}`;

/** The screen with its reads. */
export function Versions({
  customerId,
  superadmin,
}: {
  customerId: string;
  superadmin: boolean;
}) {
  const q = `customer_id=${encodeURIComponent(customerId)}`;
  const link = (href: string) => (superadmin ? withCustomer(href, customerId) : href);
  const siteMap = useSiteMap(customerId);
  const served = siteMap.view?.served ?? null;
  const manifests = useJson<ManifestsAllResponse>(`/admin/onboard/manifest?${q}&all=true`);
  const bd = useJson<AnalyticsBreakdown>(`/admin/analytics/breakdown?${q}&window=30d`);
  const [list, setList] = useState<CustomerVersionList | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, VariantBody | null>>({});
  const [busy, setBusy] = useState<"rewrite" | "approve" | "discard" | "all" | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [pageSaid, setPageSaid] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  // The visitor choice (ADR 0038 part 2): undefined while read, null on a worker without it.
  const [choice, setChoice] = useState<ChoiceState | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    apiFetch<unknown>(choicePath(customerId))
      .then((r) => !cancelled && setChoice(readChoice(r)))
      .catch(() => !cancelled && setChoice(null));
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  // After an approve, a discard or a rewrite that waits: the list and the waiting words again.
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is the trigger
  useEffect(() => {
    let cancelled = false;
    apiFetch<unknown>(pendingPath(customerId))
      .then((r) => !cancelled && setPending(readPending(r)))
      .catch(() => !cancelled && setPending([]));
    return () => {
      cancelled = true;
    };
  }, [customerId, reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is the trigger
  useEffect(() => {
    let cancelled = false;
    apiFetch<CustomerVersionList>(`/admin/variants/list?${q}&summary=1`)
      .then((r) => {
        if (cancelled) return;
        const items = itemsOf(r as unknown as VariantListAnswer);
        setList({ ...r, items });
        if (r.rewrites) setLeft(r.rewrites.left);
      })
      .catch(() => !cancelled && setList({ items: [] }));
    return () => {
      cancelled = true;
    };
  }, [q, reload]);

  const all: ManifestResponse[] = manifests.data?.manifests ?? [];
  const pages = useMemo(() => livePages(manifests.data?.manifests ?? null), [manifests.data]);
  const picked = page && pages.includes(page) ? page : (pages[0] ?? "/");
  const items: VariantListItem[] = list?.items ?? [];
  const byTuple = bd.data?.by_tuple ?? [];
  const reasons = reasonsServed(served);
  const present = KINDS.filter((k) => items.some((i) => i.source_dim === k.source));
  const kinds = present.length > 0 ? present : KINDS.slice(0, 5);
  // Market versions (`mk-gb`, ADR 0038 part 5): one per country, on the page picked.
  const marketKinds = [
    ...new Set(items.filter((i) => i.page_path === picked).map((i) => i.source_dim)),
  ]
    .map((m) => marketKind(m))
    .filter((k): k is VisitorKind => k !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  const src = source ?? kinds[0]?.source ?? "ai";
  const market = marketKind(src);
  const kind = market ?? kinds.find((k) => k.source === src);
  // A market version is written for a visit with no reason: `brand` only.
  const kindReasons = market ? ["brand"] : reasons;
  // A kind with a version waiting opens on it; else the busiest reason.
  const waitingWhy = kindReasons.find((r) => versionState(items, picked, src, r) === "waiting");
  const why =
    reason && kindReasons.includes(reason)
      ? reason
      : (waitingWhy ?? firstReason(byTuple, src, kindReasons));
  const key = cell(picked, src, why);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bodies is read, not watched
  useEffect(() => {
    if (pages.length === 0 || src === DIRECT || key in bodies) return;
    let cancelled = false;
    apiFetch<VariantBody>(
      `/admin/variant/get?${q}&intent=${why}&source=${src}&page_path=${encodeURIComponent(picked)}`,
    )
      .then((b) => !cancelled && setBodies((p) => ({ ...p, [key]: b })))
      .catch(() => !cancelled && setBodies((p) => ({ ...p, [key]: null })));
    return () => {
      cancelled = true;
    };
  }, [key, q, pages.length]);

  const manifest = all.find((m) => m.page_path === picked && m.status === "confirmed");
  const state = versionState(items, picked, src, why);
  const body = key in bodies ? (bodies[key] ?? null) : undefined;
  const item = items.find(
    (i) => i.page_path === picked && i.source_dim === src && i.intent_dim === why,
  );

  const thisCell = { page_path: picked, intent_dim: why, source_dim: src };
  const waitingHere = (pending ?? []).find(
    (w) => w.page_path === picked && w.intent_dim === why && w.source_dim === src,
  );
  const waitingOnPage = (pending ?? []).filter((w) => w.page_path === picked).length;

  /** The live body changed or a new one waits: read both again. */
  function settle() {
    forgetWaiting(customerId);
    setBodies((p) => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    setReload((n) => n + 1);
  }

  async function rewrite() {
    setBusy("rewrite");
    setSaid(null);
    try {
      const a = await apiFetch<RewriteAnswer>("/admin/variant/regenerate", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          intent_dim: why,
          source_dim: src,
          page_path: picked,
        }),
      });
      if (typeof a.rewrites_left === "number") setLeft(a.rewrites_left);
      if (a.ok && a.pending) {
        setSaid(WAITS_LINE);
        settle();
      } else {
        if (a.ok && a.body) {
          const b = a.body;
          setBodies((p) => ({ ...p, [key]: b }));
        }
        setSaid(rewriteLine(a));
      }
    } catch (e) {
      if (/rewrite_cap/.test(e instanceof Error ? e.message : "")) setLeft(0);
      setSaid(apiMessage(e, LINES.failed));
    } finally {
      setBusy(null);
    }
  }

  async function act(kind: "approve" | "discard") {
    setBusy(kind);
    setSaid(null);
    const out = await (kind === "approve" ? approve : discard)(customerId, thisCell);
    setBusy(null);
    if (out.kind === "failed") return setSaid(out.message);
    setSaid(
      out.kind === "gone"
        ? APPROVAL_LINES.gone
        : kind === "approve"
          ? APPROVAL_LINES.approved
          : APPROVAL_LINES.discarded,
    );
    settle();
  }

  async function approvePage() {
    setBusy("all");
    setPageSaid(null);
    const out = await approveAll(customerId, picked);
    setBusy(null);
    if (out.kind === "failed") return setPageSaid(out.message);
    setPageSaid(
      out.kind === "gone" ? APPROVAL_LINES.gone : APPROVAL_LINES.approvedAll(out.approved ?? 0),
    );
    setBodies({});
    forgetWaiting(customerId);
    setReload((n) => n + 1);
  }

  const leftText =
    left === null ? null : left <= 0 ? "No rewrites left today" : `${left} rewrites left today`;
  const head = (
    <PageHead
      title="Versions"
      sub="What each kind of visitor reads, beside your own words"
      right={
        leftText ? (
          <span className="font-mono text-[11.5px] text-fg-muted">{leftText}</span>
        ) : undefined
      }
    />
  );

  if (manifests.loading || list === null || !siteMap.loaded) {
    return (
      <div className="flex flex-col">
        {head}
        <StateLine kind="loading">Reading your versions</StateLine>
      </div>
    );
  }
  if (pages.length === 0) {
    return (
      <div className="flex flex-col">
        {head}
        <p className="mt-6 text-sm text-fg-muted">{LINES.noPages}</p>
      </div>
    );
  }

  const kindRows: KindRow[] = kinds.map((k) => ({
    kind: k,
    state: kindState(items, picked, k.source, reasons),
    ...kindCounts(byTuple, k.source),
  }));
  const marketRows: KindRow[] = marketKinds.map((k) => ({
    kind: k,
    state: kindState(items, picked, k.source, ["brand"]),
    visits: 0,
    conversions: 0,
  }));
  const marketCountry = market ? src.slice(3).toUpperCase() : null;

  return (
    <div className="flex flex-col animate-fade-in">
      {head}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {pages.length > 1 ? (
          <Seg
            label="Page"
            values={pages}
            labels={pageName}
            value={picked}
            onChange={(p) => {
              setPage(p);
              setSaid(null);
            }}
          />
        ) : (
          <span className="text-[13px] text-fg-muted">{pageName(picked)} page</span>
        )}
        <Link href={link("/start")} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <Plus size={14} aria-hidden />
          Add a page
        </Link>
      </div>
      {(waitingOnPage > 1 || pageSaid) && (
        <PageWaiting
          count={waitingOnPage}
          busy={busy === "all"}
          disabled={busy !== null}
          said={pageSaid}
          onApproveAll={() => void approvePage()}
        />
      )}
      <div className="mt-3.5 grid grid-cols-1 items-start gap-3 lg:grid-cols-[264px_minmax(0,1fr)]">
        <KindList
          rows={kindRows}
          markets={marketRows}
          choice={choice}
          picked={src}
          onPick={(s) => {
            setSource(s);
            setReason(null);
            setSaid(null);
          }}
        />
        {src === DIRECT || !kind ? (
          <DirectDetail
            linksHref={link("/settings?tab=links")}
            choice={
              choice
                ? {
                    customerId,
                    state: choice,
                    onState: setChoice,
                    page: picked,
                    testHref: link("/test"),
                    onOpenVersion: (intent, s) => {
                      setPage("/");
                      setSource(s);
                      setReason(intent);
                      setSaid(null);
                    },
                  }
                : null
            }
          />
        ) : (
          <VersionDetail
            kind={kind}
            reasons={kindReasons.map((r) => ({
              intent: r,
              visits: versionCounts(byTuple, src, r).visits,
              waiting: versionState(items, picked, src, r) === "waiting",
            }))}
            reason={why}
            onReason={(r) => {
              setReason(r);
              setSaid(null);
            }}
            state={state}
            waitingLine={rewrittenAgo(
              waitingHere?.pending_since ?? (item ? waitingSince(item) : null),
              Date.now(),
            )}
            waiting={
              waitingHere
                ? { parts: waitingParts(waitingHere, manifest), hasLive: waitingHere.has_live }
                : null
            }
            onDiscard={() => void act("discard")}
            parts={body === undefined ? null : partRows(manifest, body)}
            counts={marketCountry ? null : versionCounts(byTuple, src, why)}
            visitorsHref={link(
              marketCountry
                ? `/visitors?source=none&country=${marketCountry}`
                : `/visitors?version=${encodeURIComponent(`*:${src}`)}`,
            )}
            onRewrite={() => void rewrite()}
            onApprove={() => void act("approve")}
            busy={busy}
            said={said}
            canRewrite={state !== "rewriting" && left !== 0}
          />
        )}
      </div>
    </div>
  );
}
