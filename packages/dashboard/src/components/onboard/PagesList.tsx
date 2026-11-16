"use client";

/**
 * PagesList — the multi-page overview for the Connect screen (A1 / R1c).
 *
 * A customer's site is more than one page. Each page whose DOM differs from the
 * homepage (e.g. /start, a paid-traffic landing) needs its OWN confirmed
 * manifest, or visitors there fall through to the homepage selectors and get
 * skipped. This card makes that reality legible: one row per connected page,
 * its live/pending status, and how many elements Rawuser personalizes on it —
 * so the operator can see at a glance which pages are covered and add more.
 *
 * Read-only overview; the detect/confirm flow below (OnboardFlow) does the work.
 * Selecting a row hands its source URL back up so the operator can re-detect it.
 */

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Separator } from "@/components/ui/Separator";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ManifestResponse, ManifestsAllResponse } from "@/types/api";
import { Check, Clock, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

interface PagesListProps {
  customerId: string;
  /** Bump to force a refetch (e.g. after a confirm elsewhere in the flow). */
  refreshKey: number;
  /** The path currently loaded in the detect/review area, highlighted here. */
  activePath?: string | null;
  /** Operator clicked a page row — hand back its source URL to re-detect it. */
  onSelectPage: (page: ManifestResponse) => void;
}

/** Homepage reads friendlier than a bare "/". Other paths show verbatim. */
function pageLabel(path: string): string {
  return path === "/" ? "Homepage (/)" : path;
}

export function PagesList({ customerId, refreshKey, activePath, onSelectPage }: PagesListProps) {
  const [pages, setPages] = useState<ManifestResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate refetch trigger, not read in the body
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    setError(null);
    apiFetch<ManifestsAllResponse>(
      `/admin/onboard/manifest?customer_id=${encodeURIComponent(customerId)}&all=true`,
    )
      .then((data) => {
        if (!cancelled) setPages(data.manifests ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load pages");
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, refreshKey]);

  // Nothing connected yet → say nothing here; the detect form below owns the
  // first-run empty state so we don't double up on "add your first page".
  if (pages !== null && pages.length === 0) return null;

  const confirmedCount = pages?.filter((p) => p.status === "confirmed").length ?? 0;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[0.9375rem] font-semibold text-fg">Connected pages</p>
        {pages !== null && (
          <span className="text-xs text-fg-muted tabular-nums">
            {confirmedCount} live
            {pages.length > confirmedCount ? ` · ${pages.length - confirmedCount} pending` : ""}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Each page with its own layout needs its own detection. Pages not listed here fall back to
        the homepage and may be skipped.
      </p>
      <Separator className="mb-2" />

      {error && <p className="text-state-err text-sm py-2">{error}</p>}

      {pages === null && !error && (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading pages…
        </div>
      )}

      {pages?.map((page) => {
        const live = page.status === "confirmed";
        const count = Object.keys(page.manifest).length;
        const isActive = activePath != null && page.page_path === activePath;
        return (
          <button
            type="button"
            key={page.page_path}
            onClick={() => onSelectPage(page)}
            className={cn(
              "flex w-full items-center gap-3 rounded-sm px-2 py-2.5 text-left",
              "transition-colors duration-fast hover:bg-surface-muted",
              isActive && "bg-surface-muted",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
              {pageLabel(page.page_path)}
            </span>
            <span className="shrink-0 text-xs text-fg-muted tabular-nums">
              {count} element{count !== 1 ? "s" : ""}
            </span>
            {live ? (
              <Badge variant="success">
                <Check size={11} className="mr-0.5" />
                Live
              </Badge>
            ) : (
              <Badge variant="warn">
                <Clock size={11} className="mr-0.5" />
                Pending
              </Badge>
            )}
          </button>
        );
      })}
    </Card>
  );
}
