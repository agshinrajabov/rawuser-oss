"use client";

/**
 * The signed-in Audit page (mock section 04) and the ended screen (section
 * 11). Where the audit stands, the day, the visits counted and the report
 * date: never a number by source before the report (spec §6). Dashboard
 * tokens, not the ledger.
 */

import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  type AuditPageView,
  type PillTone,
  SHARE_COPIED,
  SHARE_LINE,
  apiMessage,
  auditPageView,
  endedFoot,
  pilotMailto,
} from "@/lib/audit";
import { getAuditReport, getAuditStatus, makeShareLink } from "@/lib/audit-api";
import { cn } from "@/lib/utils";
import type { AuditStatus } from "@rawuser/shared";
import { Clock, Copy } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TINT } from "../start/tones";

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export function AuditPill({
  tone,
  live,
  children,
}: {
  tone: PillTone;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[5px] text-[11px] leading-none",
        tone === "muted" && "border border-border text-fg-muted",
        tone === "ok" && TINT.ok,
        tone === "warn" && TINT.warn,
        tone === "ink" && "bg-fg text-bg",
      )}
    >
      {live && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none"
        />
      )}
      {children}
    </span>
  );
}

function Days({ days }: { days: NonNullable<AuditPageView["days"]> }) {
  return (
    <div className="mt-5 max-w-[560px]" aria-hidden>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${days.cells}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: days.cells }, (_, i) => (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: one cell per day
            key={i}
            className={cn(
              "block h-2 rounded-[2px] border",
              i < days.today && "border-fg bg-fg",
              i === days.today &&
                "border-transparent bg-[color-mix(in_srgb,var(--fg)_35%,transparent)]",
              i > days.today && "border-border bg-surface-muted",
            )}
          />
        ))}
      </div>
      {days.cells === 7 && (
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-fg-muted">
          <span>{days.first}</span>
          <span className="hidden sm:inline">{days.mid}</span>
          <span>{days.last}</span>
        </div>
      )}
    </div>
  );
}

export interface ShareState {
  state: "idle" | "busy" | "copied" | "error";
  message?: string;
}

// ---------------------------------------------------------------------------
// The Audit page, every stage
// ---------------------------------------------------------------------------

export function AuditStatusView({
  status,
  share = { state: "idle" },
  onShare,
  reportHref,
  startHref,
}: {
  status: AuditStatus;
  share?: ShareState;
  onShare?: () => void;
  reportHref: string;
  startHref: string;
}) {
  const v = auditPageView(status);
  const big = status.stage === "counting" || status.stage === "ready";
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Audit</h1>
          <p className="mt-0.5 text-sm text-fg-muted">{status.domain} · free audit</p>
        </div>
      </div>

      <div className="mt-5 sm:mt-7">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.005em] text-fg">Your report</h2>
          <AuditPill tone={v.tone} live={v.live}>
            {v.pill}
          </AuditPill>
        </div>
        <p
          className={cn(
            "mt-3 max-w-[30em] font-medium tracking-[-0.022em] [text-wrap:balance]",
            big
              ? "text-[21px] leading-[1.32] sm:text-[27px] sm:leading-[1.28]"
              : "text-[19px] leading-[1.32] sm:text-[21px]",
          )}
        >
          <span className="text-fg">{v.s1}</span>
          {v.s2 && <span className="font-normal text-fg-muted"> {v.s2}</span>}
        </p>
        {v.period && (
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-fg-muted">
            <Clock size={14} className="text-fg-faint" aria-hidden />
            {v.period}
          </p>
        )}
        {v.days && <Days days={v.days} />}
        {v.after && <p className="mt-3 max-w-[64ch] text-[13px] text-fg-muted">{v.after}</p>}

        {status.stage === "before_go_live" && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href={startHref}>Finish setup</Link>
            </Button>
          </div>
        )}
        {status.stage === "counting" && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <Button asChild variant="secondary">
              <Link href={startHref}>Read what your visitors see</Link>
            </Button>
            <span className="hidden text-xs text-fg-muted sm:inline">
              Opens the versions on Live.
            </span>
          </div>
        )}
        {status.stage === "ready" && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button asChild>
                <Link href={reportHref}>Open your report</Link>
              </Button>
              <Button variant="secondary" onClick={onShare} disabled={share.state === "busy"}>
                <Copy size={14} aria-hidden />
                Copy a share link
              </Button>
            </div>
            <p
              className={cn(
                "mt-3 max-w-[64ch] text-[13px]",
                share.state === "error" ? "text-state-err" : "text-fg-muted",
              )}
              aria-live="polite"
            >
              {share.state === "copied"
                ? SHARE_COPIED
                : share.state === "error"
                  ? share.message
                  : SHARE_LINE}
            </p>
          </>
        )}
        {status.stage === "pilot" && (
          <div className="mt-4">
            <Button asChild variant="secondary">
              <Link href="/">Open your dashboard</Link>
            </Button>
          </div>
        )}
      </div>

      {v.foot && (
        <div className="mt-7 flex flex-wrap gap-x-[18px] gap-y-2 border-t border-border pt-3.5 text-[12.5px] text-fg-muted">
          <span>{v.foot}</span>
          <a
            href="/audit/terms/"
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-dotted underline-offset-[3px] hover:text-fg"
          >
            Audit terms
          </a>
        </div>
      )}
    </>
  );
}

/** The Audit page: reads GET /admin/audit for the customer's own id (or ?customer_id= for a superadmin). */
export function AuditPageScreen() {
  const { user, loading } = useCurrentUser();
  const params = useSearchParams();
  const router = useRouter();
  const customerId =
    user?.role === "customer" ? (user.customer_id ?? "") : (params.get("customer_id") ?? "");
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [share, setShare] = useState<ShareState>({ state: "idle" });
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    if (loading || !customerId) return;
    let cancelled = false;
    getAuditStatus(customerId)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.stage === "ended" && s.report_released_at !== null) {
          void reportStillOpen(customerId, Date.now()).then((open) => {
            if (!cancelled) setReportOpen(open);
          });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof Error && /^API error 404/.test(e.message)) router.replace("/");
        else setFailed("Rawuser did not answer. Reload the page in a minute.");
      });
    return () => {
      cancelled = true;
    };
  }, [loading, customerId, router]);

  async function copyShare() {
    if (!customerId) return;
    setShare({ state: "busy" });
    try {
      const r = await makeShareLink(customerId);
      await navigator.clipboard.writeText(r.link);
      setShare({ state: "copied" });
    } catch (e) {
      setShare({ state: "error", message: apiMessage(e, "Could not make a link. Try again.") });
    }
  }

  const qs = user?.role === "customer" ? "" : `?customer_id=${encodeURIComponent(customerId)}`;
  if (!loading && !customerId) {
    return <p className="text-sm text-fg-muted">Choose a customer to see its audit.</p>;
  }
  if (failed) return <p className="text-sm text-fg-muted">{failed}</p>;
  if (!status) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full max-w-xl" />
      </div>
    );
  }
  if (status.stage === "ended" || status.stage === "lapsed") {
    return (
      <AuditEndedView status={status} reportHref={`/audit/report/${qs}`} reportOpen={reportOpen} />
    );
  }
  return (
    <AuditStatusView
      status={status}
      share={share}
      onShare={() => void copyShare()}
      reportHref={`/audit/report/${qs}`}
      startHref={`/start/${qs}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Ended (mock section 11)
// ---------------------------------------------------------------------------

export function AuditEndedView({
  status,
  reportOpen,
  reportHref,
}: {
  status: AuditStatus;
  /** The report is released, not revoked and not expired. */
  reportOpen: boolean;
  reportHref: string;
}) {
  const v = auditPageView(status);
  const foot = reportOpen ? endedFoot(status) : null;
  const pilot = pilotMailto(status.domain);
  return (
    <div className="pb-12 pt-4 sm:pb-[72px] sm:pt-14">
      <AuditPill tone="muted">{v.pill}</AuditPill>
      <p className="mt-4 max-w-[30em] text-[21px] font-medium leading-[1.32] tracking-[-0.022em] [text-wrap:balance] sm:text-[27px] sm:leading-[1.28]">
        <span className="text-fg">{v.s1}</span>
        {v.s2 && <span className="font-normal text-fg-muted"> {v.s2}</span>}
      </p>
      {v.after && <p className="mt-3 max-w-[64ch] text-[13px] text-fg-muted">{v.after}</p>}
      <div className="mt-5 flex flex-col gap-2.5 sm:mt-6 sm:flex-row sm:flex-wrap">
        {pilot && (
          <Button asChild size="lg">
            <a href={pilot}>Talk about a pilot</a>
          </Button>
        )}
        {reportOpen && (
          <Button asChild size="lg" variant="secondary">
            <Link href={reportHref}>Open your report</Link>
          </Button>
        )}
      </div>
      {foot && (
        <div className="mt-7 border-t border-border pt-3.5 text-[12.5px] text-fg-muted sm:mt-9">
          {foot}
        </div>
      )}
    </div>
  );
}

/** Whether the customer's released report still opens (released, not revoked, not past its date). */
export async function reportStillOpen(customerId: string, now: number): Promise<boolean> {
  try {
    const r = await getAuditReport(customerId);
    return r.released_at !== null && r.revoked_at === null && (r.expires_at ?? 0) > now;
  } catch {
    return false;
  }
}
