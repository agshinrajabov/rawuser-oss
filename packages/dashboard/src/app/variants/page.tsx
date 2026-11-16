"use client";

import { NextStepsBanner } from "@/components/journey/NextStepsBanner";
import { AppShell } from "@/components/shell/AppShell";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { OldRoute } from "@/components/shell/OldRoute";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { useTopbarRightSlot } from "@/components/shell/TopbarSlotContext";
import { useSiteMap } from "@/components/start/useSiteMap";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Separator } from "@/components/ui/Separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { apiFetch } from "@/lib/api";
import { OUTAGE_MESSAGE, OUTAGE_STOP_AFTER, looksLikeOutage } from "@/lib/outage";
import { servedCounts } from "@/lib/site-map";
import { cn } from "@/lib/utils";
import type { VariantListItem } from "@/types/api";
import { Check, LayoutGrid, Loader2, RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import * as React from "react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compare } from "../../components/variants/Compare";
import { VariantFilters, type VariantFiltersValue } from "../../components/variants/VariantFilters";
import { VariantGallery } from "../../components/variants/VariantGallery";
import { VariantSidePanel } from "../../components/variants/VariantSidePanel";
import { VariantTable } from "../../components/variants/VariantTable";

const DEFAULT_FILTERS: Omit<VariantFiltersValue, "customerId"> = {
  intent: "all",
  source: "all",
  staleOnly: false,
};

// The full generation surface: 6 intents × 6 source modifiers = 36 tuples.
// `direct` is not generated: it falls back to `default` at edge selection time.
const ALL_INTENT_DIMS = ["competitor", "evaluation", "feature", "problem", "brand", "pricing"];
const ALL_GENERATION_SOURCE_DIMS = ["default", "ai", "social", "community", "organic", "paid"];

/**
 * Source-major order on purpose: the six "default" tuples are what the
 * gallery cards show, so they are written first and the operator sees each
 * card fill in within the first minute; the four tone variations follow.
 */
function allTupleKeys(served: readonly string[] | null = null): string[] {
  // Only the intents the site serves (site-shaped intents §7.3); a folded
  // intent's old versions stay stored, unused, and are never asked for.
  const intents = served ? ALL_INTENT_DIMS.filter((d) => served.includes(d)) : ALL_INTENT_DIMS;
  const out: string[] = [];
  for (const source of ALL_GENERATION_SOURCE_DIMS) {
    for (const intent of intents) {
      out.push(`${intent}:${source}`);
    }
  }
  return out;
}

/** The generation worker's reason, cut to one readable clause. */
function shortReason(reason: string | undefined): string {
  if (!reason) return "not written";
  const r = reason.replace(/^lint:\s*/, "").trim();
  return r.length > 80 ? `${r.slice(0, 77)}…` : r;
}

function rowKey(item: VariantListItem) {
  return `${item.intent_dim}:${item.source_dim}`;
}

type BulkState = "idle" | "confirming" | "running" | "done";

function VariantsInner() {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id") ?? "";

  const { customers, refresh: refreshCustomers } = useCustomerList();
  const currentCustomer = customerId ? (customers.find((c) => c.id === customerId) ?? null) : null;
  const canGenerate = Boolean(currentCustomer?.has_dna);
  const siteMap = useSiteMap(customerId);
  const served = siteMap.view?.served ?? null;
  const folded = siteMap.view?.folded ?? [];

  const [filters, setFilters] = useState<VariantFiltersValue>({
    customerId,
    ...DEFAULT_FILTERS,
  });
  const [items, setItems] = useState<VariantListItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Which page's variants are shown (A1 per-path; R1c b). '/' by default.
  const [selectedPath, setSelectedPath] = useState("/");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelItem, setPanelItem] = useState<VariantListItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const [bulkState, setBulkState] = useState<BulkState>("idle");
  const [bulkProgress, setBulkProgress] = useState(0);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkQueue, setBulkQueue] = useState<string[]>([]);
  // Regenerate all writes the selected page unless the operator picks every
  // page (the founder regenerated the homepage twice believing it covered
  // /az, 2026-09-14). Failures are counted and named, not swallowed.
  const [bulkScope, setBulkScope] = useState<"page" | "all">("page");
  const [bulkFailed, setBulkFailed] = useState<string[]>([]);
  const [bulkCurrent, setBulkCurrent] = useState<string | null>(null);
  const [doneText, setDoneText] = useState<string | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setFilters((prev) => ({ ...prev, customerId }));
    setSelected(new Set());
    setSelectedPath("/");
  }, [customerId]);

  // Distinct pages present in the variant set, '/' first. Drives the switcher.
  const availablePaths = useMemo(() => {
    const paths = [...new Set(items.map((i) => i.page_path))];
    paths.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
    return paths;
  }, [items]);

  // Keep the selection valid as data loads (e.g. a customer with no '/' set).
  useEffect(() => {
    if (availablePaths.length > 0 && !availablePaths.includes(selectedPath)) {
      setSelectedPath(availablePaths[0] ?? "/");
    }
  }, [availablePaths, selectedPath]);

  const pathItems = useMemo(
    () => items.filter((i) => i.page_path === selectedPath),
    [items, selectedPath],
  );
  // Counts cover the served intents only: a folded intent's old versions stay
  // stored, unused (site-shaped intents, decision 5), and are not "ready".
  const {
    ready: readyCount,
    stale: staleCount,
    error: errorCount,
  } = useMemo(() => servedCounts(pathItems, served), [pathItems, served]);
  const pageLabel = (p: string) => (p === "/" ? "the homepage" : p);

  // `silent` refreshes the list without the skeleton: used between bulk
  // generation calls so cards fill in one by one instead of flashing.
  const loadVariants = useCallback(
    (silent = false) => {
      if (!customerId) return;
      if (!silent) setLoading(true);
      apiFetch<VariantListItem[]>(`/admin/variants/list?customer_id=${customerId}`)
        .then((data) => setItems(data))
        .catch(() => {
          if (!silent) setItems([]);
        })
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [customerId],
  );

  useEffect(() => {
    loadVariants();
  }, [loadVariants]);

  function handleFiltersChange(next: VariantFiltersValue) {
    setFilters(next);
  }

  function handleSelect(key: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function handleSelectAll(checked: boolean) {
    if (checked) {
      const filteredKeys = pathItems
        .filter((item) => {
          if (filters.intent !== "all" && item.intent_dim !== filters.intent) return false;
          if (filters.source !== "all" && item.source_dim !== filters.source) return false;
          if (filters.staleOnly && item.status !== "stale") return false;
          return true;
        })
        .map(rowKey);
      setSelected(new Set(filteredKeys));
    } else {
      setSelected(new Set());
    }
  }

  function handlePathChange(path: string) {
    setSelectedPath(path);
    setSelected(new Set()); // bulk selection is per-path
  }

  function handleRowClick(item: VariantListItem) {
    setPanelItem(item);
    setPanelOpen(true);
  }

  const selectedCount = selected.size;

  async function runBulkRegenerate() {
    // Keep the canonical order (defaults first) even when the selection
    // came from the table, so the gallery fills in the way it reads.
    const order = allTupleKeys();
    const keys = Array.from(selected).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    let skipped = 0;
    const paths = bulkScope === "all" ? availablePaths : [selectedPath];
    const jobs = paths.flatMap((path) => keys.map((key) => ({ path, key })));
    const firstRun = readyCount === 0;
    setBulkState("running");
    setBulkProgress(0);
    setBulkTotal(jobs.length);
    setBulkQueue(jobs.map((j) => j.key));
    setBulkFailed([]);
    const failed: string[] = [];
    let streak = 0;
    let stoppedAt: number | null = null;
    // Every selected version goes stale first, so the worker's five-minute
    // queue finishes the run if this tab sleeps (2026-09-15).
    if (keys.length === allTupleKeys(served).length) {
      for (const path of paths) {
        try {
          await apiFetch("/admin/variants/stale-all", {
            method: "POST",
            body: JSON.stringify({ customer_id: customerId, page_path: path }),
          });
        } catch {
          // the loop below still writes
        }
      }
    }

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i] ?? { path: selectedPath, key: "" };
      const parts = job.key.split(":");
      const intent_dim = parts[0] ?? "";
      const source_dim = parts[1] ?? "";
      setBulkCurrent(job.key);
      const label = paths.length > 1 ? `${pageLabel(job.path)} ${job.key}` : job.key;
      let reason: string | undefined;
      let ok = true;
      try {
        const res = await apiFetch<{ ok?: boolean; error?: string; reason?: string }>(
          "/admin/variant/regenerate",
          {
            method: "POST",
            body: JSON.stringify({
              customer_id: customerId,
              intent_dim,
              source_dim,
              page_path: job.path,
            }),
          },
        );
        if (res && res.ok === false && res.error === "not_served") {
          // An intent the site folds: nothing spent, not a failure.
          skipped++;
        } else if (res && res.ok === false) {
          ok = false;
          // The orchestrator answers `error`; `reason` is the older shape.
          reason = res.error ?? res.reason;
          failed.push(`${label}: ${shortReason(reason)}`);
        }
      } catch {
        ok = false;
        failed.push(`${label}: request failed`);
      }
      setBulkProgress(i + 1);
      setBulkQueue(jobs.slice(i + 1).map((j) => j.key));
      // The card for this tuple can show its headline now.
      loadVariants(true);
      // Three service-shaped failures in a row: stop instead of burning
      // 45 s on each remaining version against a writing service that is
      // not answering (2026-09-14).
      streak = ok ? 0 : looksLikeOutage(reason) ? streak + 1 : 0;
      if (streak >= OUTAGE_STOP_AFTER) {
        stoppedAt = i + 1;
        break;
      }
    }

    setBulkCurrent(null);
    setBulkQueue([]);
    setBulkState("done");
    const attempted = stoppedAt ?? jobs.length;
    const n = attempted - failed.length - skipped;
    setBulkFailed(stoppedAt ? [...failed, OUTAGE_MESSAGE] : failed);
    setDoneText(
      stoppedAt
        ? `Stopped after ${attempted} of ${jobs.length}: the writing service is not answering. ${firstRun ? "Wrote" : "Regenerated"} ${n}, ${failed.length} failed`
        : failed.length > 0
          ? `${firstRun ? "Wrote" : "Regenerated"} ${n}, ${failed.length} failed`
          : firstRun
            ? `Wrote ${n} versions`
            : `Regenerated ${n}`,
    );
    setSelected(new Set());
    loadVariants();
    // The Next-step banner and the customer switcher read variants_ready_count
    // from the customer list; refresh it so the step moves on.
    refreshCustomers();

    if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    doneTimerRef.current = setTimeout(
      () => {
        setBulkState("idle");
        setDoneText(null);
      },
      stoppedAt ? 15000 : failed.length > 0 ? 8000 : 2000,
    );
  }

  function handleGenerateAll() {
    if (!canGenerate || bulkState !== "idle") return;
    setSelected(new Set(allTupleKeys(served)));
    setBulkScope("page");
    setBulkState("confirming");
  }

  /** Every tuple is selected, so the dialog may offer every page too. */
  const wholePageSelected = selectedCount === allTupleKeys(served).length;
  const scopedCount = bulkScope === "all" ? selectedCount * availablePaths.length : selectedCount;
  const stateLine = (() => {
    const c = servedCounts(bulkScope === "all" ? items : pathItems, served);
    const ready = c.ready;
    const stale = c.stale;
    const errors = c.error;
    const parts = [`${ready} ready`];
    if (stale > 0) parts.push(`${stale} stale`);
    if (errors > 0) parts.push(`${errors} with errors`);
    return parts.join(", ");
  })();

  // Script-first go-live lands here with ?write=1: the operator already
  // pressed one button for this, so the loop starts without a second ask.
  // Runs once per arrival, only while nothing is written yet.
  const autoWriteRef = useRef(false);
  const wantsWrite = searchParams.get("write") === "1";
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once when the list has loaded; runBulkRegenerate is stable for that tick
  useEffect(() => {
    if (!wantsWrite || autoWriteRef.current || loading || !canGenerate || !siteMap.loaded) return;
    if (bulkState !== "idle") return;
    autoWriteRef.current = true;
    setSelected(new Set(allTupleKeys(served)));
    // Let the selection land before the loop reads it.
    setTimeout(() => {
      void runBulkRegenerate();
    }, 0);
  }, [wantsWrite, loading, canGenerate, bulkState, siteMap.loaded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handleGenerateAll reads only canGenerate + bulkState, both already in deps
  const rightSlot = useMemo(() => {
    if (doneText) {
      return (
        <span className="flex min-w-0 max-w-[140px] items-center gap-1.5 text-xs text-state-success font-medium sm:max-w-none">
          <Check size={12} className="flex-none" />
          <span className="truncate">{doneText}</span>
        </span>
      );
    }
    if (bulkState === "running") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-fg-muted font-medium">
          <Loader2 size={12} className="animate-spin" />
          {bulkProgress}/{bulkTotal}
        </span>
      );
    }
    if (selectedCount > 0) {
      return (
        <Button size="sm" onClick={() => setBulkState("confirming")}>
          <RefreshCw size={12} aria-hidden />
          <span className="sr-only sm:not-sr-only">Regenerate</span> ({selectedCount})
        </Button>
      );
    }
    if (canGenerate && readyCount > 0) {
      return (
        <Button
          size="sm"
          variant="secondary"
          onClick={handleGenerateAll}
          aria-label="Regenerate all"
          title="Regenerate all"
        >
          <RefreshCw size={12} aria-hidden />
          {/* Icon only on a phone, so the customer picker keeps its room. */}
          <span className="hidden sm:inline">Regenerate all</span>
        </Button>
      );
    }
    return null;
  }, [selectedCount, bulkState, bulkProgress, bulkTotal, doneText, readyCount, canGenerate]);

  useTopbarRightSlot(rightSlot);

  const contextLabel = !customerId
    ? "Select a customer to view variants"
    : loading
      ? customerId
      : `${customerId} · ${readyCount} ready · ${staleCount} stale`;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-fg">Page versions</h1>
        <p className="text-sm text-fg-muted mt-0.5">
          Step 3 of 5 · The versions of the page Rawuser wrote, one for each kind of visitor.
          Preview any of them, or regenerate after editing the brief.
        </p>
        <p className="text-xs text-fg-faint mt-1 mono-num">{contextLabel}</p>
      </div>

      <Separator className="mb-4" />

      <NextStepsBanner screen="variants" />

      {!customerId ? (
        <ScreenEmpty
          icon={LayoutGrid}
          title="Pick a customer to see their page versions"
          body="Choose a customer from the top bar. Rawuser writes one version of the page per audience. Preview any of them here, or regenerate after editing the brief."
        />
      ) : (
        <Tabs defaultValue="gallery">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-4">
            <TabsList>
              <TabsTrigger value="gallery">Versions</TabsTrigger>
              <TabsTrigger value="compare">Compare</TabsTrigger>
              <TabsTrigger value="table">Advanced</TabsTrigger>
            </TabsList>

            {bulkFailed.length > 0 && (
              <p className="text-xs text-state-warn max-w-[70ch]">
                Not written: {bulkFailed.join("; ")}. The reason sits on each row under Advanced;
                the next run tries them again.
              </p>
            )}
            {availablePaths.length > 1 && (
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <span className="text-xs text-fg-muted">Page</span>
                <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-sm border border-border p-0.5">
                  {availablePaths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => handlePathChange(p)}
                      className={cn(
                        "flex-none whitespace-nowrap rounded-sm px-2.5 py-1 text-xs font-mono transition-colors duration-fast",
                        p === selectedPath
                          ? "bg-surface-muted text-fg"
                          : "text-fg-muted hover:text-fg",
                      )}
                    >
                      {p === "/" ? "Homepage" : p}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <TabsContent value="gallery">
            <VariantGallery
              items={pathItems}
              loading={loading}
              customerId={customerId}
              onOpen={handleRowClick}
              canGenerate={canGenerate}
              onGenerateAll={bulkState === "idle" ? handleGenerateAll : undefined}
              served={served}
              folded={folded}
              progress={
                bulkState === "running"
                  ? {
                      current: bulkCurrent,
                      queued: bulkQueue,
                      done: bulkProgress,
                      total: bulkTotal,
                    }
                  : null
              }
            />
          </TabsContent>

          <TabsContent value="table">
            <p className="text-xs text-fg-muted mb-3">
              Every generated version by (intent × source tone) with status and cost, for managing
              generation. Select rows to regenerate in bulk.
            </p>
            <div className="mb-3">
              <VariantFilters value={filters} onChange={handleFiltersChange} />
            </div>

            {bulkState === "running" && (
              <div className="w-full h-0.5 bg-surface-muted rounded-full mb-3 overflow-hidden">
                <div
                  className="h-full bg-fg transition-all duration-medium ease-smooth"
                  style={{ width: bulkTotal > 0 ? `${(bulkProgress / bulkTotal) * 100}%` : "0%" }}
                />
              </div>
            )}

            <VariantTable
              items={pathItems}
              loading={loading}
              filters={filters}
              selected={selected}
              onSelect={handleSelect}
              onSelectAll={handleSelectAll}
              onRowClick={handleRowClick}
              onGenerateAll={canGenerate && bulkState === "idle" ? handleGenerateAll : undefined}
            />
          </TabsContent>

          <TabsContent value="compare">
            <Compare items={pathItems} customerId={customerId} pagePath={selectedPath} />
          </TabsContent>
        </Tabs>
      )}

      <VariantSidePanel
        item={panelItem}
        customerId={customerId}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onRegenerated={loadVariants}
      />

      <Dialog
        open={bulkState === "confirming"}
        onOpenChange={(o) => {
          if (!o) setBulkState("idle");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {readyCount === 0
                ? `Write ${scopedCount} versions of ${pageLabel(selectedPath)}?`
                : bulkScope === "all"
                  ? `Regenerate ${scopedCount} versions across ${availablePaths.length} pages?`
                  : `Regenerate ${scopedCount} version${scopedCount !== 1 ? "s" : ""} of ${pageLabel(selectedPath)}?`}
            </DialogTitle>
            <DialogDescription>
              Now: {stateLine}. About ${(scopedCount * 0.025).toFixed(2)} in total, one version at a
              time, roughly {Math.max(1, Math.round(scopedCount / 12))} to{" "}
              {Math.max(2, Math.round(scopedCount / 6))} minutes. You can keep the page open and
              watch the cards fill in. Versions that fail are named when the run ends.
            </DialogDescription>
          </DialogHeader>
          {wholePageSelected && availablePaths.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-sm border border-border p-0.5 self-start text-xs">
              {(["page", "all"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setBulkScope(scope)}
                  className={cn(
                    "rounded-sm px-2.5 py-1 transition-colors duration-fast",
                    bulkScope === scope
                      ? "bg-surface-muted text-fg"
                      : "text-fg-muted hover:text-fg",
                  )}
                >
                  {scope === "page"
                    ? `This page only (${pageLabel(selectedPath)}), ${selectedCount}`
                    : `Every page, ${selectedCount * availablePaths.length}`}
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setBulkState("idle")}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => runBulkRegenerate()}>
              <RefreshCw size={12} />
              {readyCount === 0 ? "Write versions" : "Regenerate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function VariantsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>
          <Suspense>
            <VariantsInner />
          </Suspense>
        </OldRoute>
      </Suspense>
    </AppShell>
  );
}
