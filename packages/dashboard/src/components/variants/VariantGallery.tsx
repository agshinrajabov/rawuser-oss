"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Marked } from "@/components/ui/Marked";
import { Skeleton } from "@/components/ui/Skeleton";
import { apiFetch } from "@/lib/api";
import { foldReason, servedOnly } from "@/lib/site-map";
import type { SiteMapView, VariantBody, VariantListItem } from "@/types/api";
import { INTENT_DIMENSIONS } from "@rawuser/shared";
import { Eye, Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Plain-language description of each intent — the AUDIENCE the version is for,
 * in the customer's words rather than the engine's dimension name (ADR 0024).
 */
export const AUDIENCE: Record<string, { title: string; sub: string }> = {
  competitor: {
    title: "Comparing you to a rival",
    sub: "weighing you against a named alternative",
  },
  evaluation: { title: "Weighing their options", sub: "researching the whole category" },
  feature: { title: "Digging into a capability", sub: "here for a specific feature" },
  problem: { title: "Arrived with a problem", sub: "looking to solve a pain" },
  brand: { title: "Already knows you", sub: "direct or returning visitor" },
  pricing: { title: "Price-first", sub: "cost is the question" },
};

/**
 * A folded intent is one quiet line under the cards (site-shaped intents
 * mock, section 06): who its visitors see and why, no empty card.
 */
export function FoldedLines({ folded }: { folded: SiteMapView["folded"] }) {
  if (folded.length === 0) return null;
  return (
    <div className="mt-3">
      {folded.map((f) => (
        <p
          key={f.intent}
          className="border-t border-border py-2.5 text-[13px] leading-normal text-fg-muted"
          data-fold={f.intent}
        >
          <b className="font-medium text-fg">{AUDIENCE[f.intent]?.title ?? f.intent}</b> visitors
          see {AUDIENCE[f.to]?.title ?? f.to}.{" "}
          <span className="text-fg-faint">{foldReason(f.intent)}</span>
        </p>
      ))}
    </div>
  );
}

const COUNT_WORD: Record<number, string> = { 4: "four", 5: "five", 6: "six" };

/** Pick the representative variant for an intent: prefer the base 'default' source. */
function representative(items: VariantListItem[], intent: string): VariantListItem | null {
  const forIntent = items.filter((i) => i.intent_dim === intent);
  if (forIntent.length === 0) return null;
  return forIntent.find((i) => i.source_dim === "default") ?? forIntent[0] ?? null;
}

export interface GenerationProgress {
  /** "intent:source" being written right now, or null between calls. */
  current: string | null;
  /** Tuples still to be written, in order. */
  queued: string[];
  done: number;
  total: number;
}

/** What the card should say about this intent while a bulk run is on. */
function writingState(
  intent: string,
  progress: GenerationProgress | null,
): "writing" | "queued" | null {
  if (!progress) return null;
  if (progress.current?.startsWith(`${intent}:`)) return "writing";
  if (progress.queued.some((k) => k.startsWith(`${intent}:default`))) return "queued";
  return null;
}

function GalleryCard({
  intent,
  item,
  customerId,
  onOpen,
  writing,
}: {
  intent: string;
  item: VariantListItem | null;
  customerId: string;
  onOpen: (item: VariantListItem) => void;
  writing: "writing" | "queued" | null;
}) {
  const audience = AUDIENCE[intent] ?? { title: intent, sub: "" };
  const [body, setBody] = useState<VariantBody | null>(null);
  const [loading, setLoading] = useState(Boolean(item));

  useEffect(() => {
    if (!item) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiFetch<VariantBody>(
      `/admin/variant/get?customer_id=${encodeURIComponent(customerId)}&intent=${item.intent_dim}&source=${item.source_dim}&page_path=${encodeURIComponent(item.page_path)}`,
    )
      .then((v) => {
        if (!cancelled) setBody(v);
      })
      .catch(() => {
        if (!cancelled) setBody(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item, customerId]);

  const hero = body?.sections.hero;
  const heroCta = hero?.cta?.label;

  return (
    <button
      type="button"
      onClick={() => item && onOpen(item)}
      disabled={!item}
      className="group text-left bg-surface border border-border rounded-md p-4 flex flex-col gap-3 transition-colors duration-fast hover:border-border-strong disabled:cursor-default disabled:opacity-70"
    >
      <div>
        <div className="text-sm font-medium text-fg">{audience.title}</div>
        <div className="text-xs text-fg-muted mt-0.5">{audience.sub}</div>
      </div>

      {/* Mini page preview — the actual headline + button the visitor would see */}
      <div className="bg-bg border border-border rounded-sm px-3 py-3 min-h-[92px] flex flex-col">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-5 w-24 mt-2" />
          </div>
        ) : !item ? (
          <div className="flex-1 flex items-center gap-1.5 text-xs text-fg-faint">
            {writing === "writing" ? (
              <>
                <Loader2 size={12} className="animate-spin text-fg-muted" />
                <span className="text-fg-muted">Writing this version…</span>
              </>
            ) : writing === "queued" ? (
              "Queued"
            ) : (
              "Not written yet"
            )}
          </div>
        ) : hero ? (
          <>
            <div className="text-[13px] font-semibold text-fg leading-snug line-clamp-3">
              <Marked text={hero.headline ?? ""} />
            </div>
            {heroCta && (
              <div className="mt-2 inline-flex self-start items-center bg-cta-bg text-cta-fg rounded-sm font-medium px-2.5 py-1 text-[11px]">
                <Marked text={heroCta} />
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center text-xs text-fg-faint">Preview unavailable</div>
        )}
      </div>

      <div className="flex items-center justify-between mt-auto">
        {item ? (
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted group-hover:text-fg transition-colors">
            <Eye size={13} />
            Preview
          </span>
        ) : (
          <span />
        )}
        {item && item.status !== "ready" && (
          <Badge variant={item.status === "stale" ? "warn" : "err"}>● {item.status}</Badge>
        )}
      </div>
    </button>
  );
}

/**
 * Visual gallery of a customer's page versions — one card per audience (the 6
 * intents), each showing the real headline + button that audience would see.
 * Replaces the raw (intent × source) tuple table as the default view (ADR 0024).
 * The source-tone variations and generation metadata live in the Advanced tab.
 */
export function VariantGallery({
  items,
  loading,
  customerId,
  onOpen,
  canGenerate,
  onGenerateAll,
  progress,
  served = null,
  folded = [],
}: {
  items: VariantListItem[];
  loading: boolean;
  customerId: string;
  onOpen: (item: VariantListItem) => void;
  /** The brief is filled, so generation is possible. */
  canGenerate?: boolean;
  /** Present when a bulk run may start now; absent while one is running. */
  onGenerateAll?: () => void;
  /** Present while a bulk run is on. */
  progress?: GenerationProgress | null;
  /** The intents the site serves; null shows all six. */
  served?: string[] | null;
  /** Intents the site folds, one line each under the cards. */
  folded?: SiteMapView["folded"];
}) {
  const intents = servedOnly(INTENT_DIMENSIONS, served);
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {INTENT_DIMENSIONS.map((d) => (
          <Skeleton key={d} className="h-48 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const nothingYet = items.length === 0;

  return (
    <>
      {progress ? (
        <div className="mb-3 flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          <span>
            Writing version {Math.min(progress.done + 1, progress.total)} of {progress.total}. The
            six cards fill in first, the tone variations follow.
          </span>
        </div>
      ) : nothingYet && canGenerate ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3">
          <div>
            <p className="text-sm font-medium text-fg">No versions written yet</p>
            <p className="text-xs text-fg-muted">
              Rawuser writes {intents.length * 6} versions from your brief:{" "}
              {COUNT_WORD[intents.length] ?? intents.length} audiences, six tones each. About $0.45
              and two minutes.
            </p>
          </div>
          <Button size="sm" onClick={onGenerateAll} disabled={!onGenerateAll}>
            <Sparkles size={12} />
            Write the versions
          </Button>
        </div>
      ) : nothingYet ? (
        <p className="text-sm text-fg-muted mb-3">
          Fill in the product brief first; the versions are written from it.
        </p>
      ) : (
        <p className="text-sm text-fg-muted mb-3">
          One version per kind of visitor. Each shows the headline and button that audience sees;
          click any to preview the full page or regenerate it.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {intents.map((intent) => (
          <GalleryCard
            key={intent}
            intent={intent}
            item={representative(items, intent)}
            customerId={customerId}
            onOpen={onOpen}
            writing={writingState(intent, progress ?? null)}
          />
        ))}
      </div>
      <FoldedLines folded={folded} />
    </>
  );
}
