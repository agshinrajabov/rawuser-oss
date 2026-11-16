"use client";

import { apiFetch } from "@/lib/api";
import { auditRefusal } from "@/lib/audit";
import { OUTAGE_MESSAGE, OUTAGE_STOP_AFTER, looksLikeOutage } from "@/lib/outage";
import type { VariantListItem } from "@/types/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { allTuples, missingTuples, readyOnPage, tuplesPerPage, writeOutcome } from "./steps";

/**
 * Writes every version that is not ready yet, one call at a time, and
 * reports progress. Reload-safe: it reads the list first and only writes
 * what is missing, so a customer who refreshes mid-way does not pay twice.
 * Only the served intents are counted and written (site-shaped intents
 * §7.3); `served` null means all six (the site map not read).
 */
export function useWriteVersions(
  customerId: string,
  pagePaths: readonly string[],
  enabled: boolean,
  served: readonly string[] | null = null,
  /**
   * Bumped when versions were marked to be written again outside this hook
   * (a button's switch turned on): the missing-only write starts again.
   */
  runKey = 0,
) {
  const servedKey = served ? served.join(",") : "*";
  // A change of the served set (Write on the Pages card, a Save in the
  // dialog) starts the missing-only write again, like a new page does.
  const pathsKey = `${pagePaths.join("|")}#${servedKey}#${runKey}`;
  const [ready, setReady] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(0);
  /** Set when the loop stopped early because the writing service was not answering. */
  const [stopped, setStopped] = useState<string | null>(null);
  /**
   * The free audit's cap refusal that stopped the loop (409 audit_spend,
   * audit_rewrite_used, audit_ended), in the API's own sentence.
   */
  const [refused, setRefused] = useState<string | null>(null);
  /** "missing" writes what is not ready; "all" rewrites every version. */
  const [mode, setMode] = useState<"missing" | "all">("missing");
  /** The path list the missing-only write last ran for; a new page starts it again. */
  const startedForRef = useRef<string | null>(null);
  const cancelRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathsKey stands in for the array
  const load = useCallback(async () => {
    const items = await apiFetch<VariantListItem[]>(
      `/admin/variants/list?customer_id=${encodeURIComponent(customerId)}`,
    );
    const done = pagePaths.reduce((n, p) => n + readyOnPage(items, p, served), 0);
    setReady(done);
    return items;
  }, [customerId, pathsKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathsKey stands in for the array
  useEffect(() => {
    if (!enabled || !customerId || startedForRef.current === pathsKey) return;
    startedForRef.current = pathsKey;
    let cancelled = false;
    (async () => {
      let items: VariantListItem[];
      try {
        items = await load();
      } catch {
        return;
      }
      const todo = pagePaths.flatMap((pagePath) =>
        missingTuples(items, pagePath, served).map((t) => ({ ...t, page_path: pagePath })),
      );
      if (todo.length === 0) return;
      // A run of its own: the count of what failed starts again, and the
      // card says "Writing", whatever a Rewrite everything left behind.
      setMode("missing");
      setFailed(0);
      setRunning(true);
      setStopped(null);
      let streak = 0;
      for (const t of todo) {
        if (cancelled) break;
        let reason: string | undefined;
        let outcome: "ok" | "skipped" | "waiting" | "failed" = "ok";
        try {
          // `auto`: this is the screen's own loop, not a click. A row the
          // queue is leaving alone after a failed try is not paid for again
          // on every page load; the worker answers `waiting` with the time
          // of its next try (J9 of docs/specs/pilot-gaps.md).
          const res = await apiFetch<WriteResult>("/admin/variant/regenerate", {
            method: "POST",
            body: JSON.stringify({ customer_id: customerId, ...t, auto: true }),
          });
          const o = writeOutcome(res);
          outcome = o.kind;
          if (o.kind === "failed") reason = o.reason;
        } catch (e) {
          const cap = auditRefusal(e);
          if (cap) {
            setRefused(cap.message);
            break;
          }
          outcome = "failed";
        }
        if (outcome === "skipped") continue;
        if (outcome === "ok") {
          setReady((n) => (n ?? 0) + 1);
          streak = 0;
          continue;
        }
        // A row still not written: counted so the card reaches its end
        // state. Only a failure of the writing service feeds the streak.
        setFailed((n) => n + 1);
        if (outcome === "waiting") continue;
        streak = looksLikeOutage(reason) ? streak + 1 : 0;
        if (streak >= OUTAGE_STOP_AFTER) {
          setStopped(OUTAGE_MESSAGE);
          break;
        }
      }
      if (!cancelled) setRunning(false);
    })();
    return () => {
      // A new path list or served set starts its own loop; this one stops
      // after the call in flight and must not leave "writing" on.
      cancelled = true;
      setRunning(false);
    };
  }, [enabled, customerId, pathsKey, load]);

  /**
   * Rewrite every version of every enabled page (docs/specs/NEXT.md): after
   * the brief or the parts of the page changed, the missing-only write above
   * leaves the old copy in place. One call at a time, progress counts up
   * from zero, failures are counted and the row keeps its reason.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathsKey stands in for the array
  const rewriteAll = useCallback(async () => {
    if (running || !customerId) return;
    cancelRef.current = false;
    setMode("all");
    setRunning(true);
    setReady(0);
    setFailed(0);
    setStopped(null);
    setRefused(null);
    // Mark every version stale first, so the five-minute queue on the
    // worker finishes the rewrite if this tab sleeps (2026-09-15).
    try {
      await apiFetch("/admin/variants/stale-all", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId }),
      });
    } catch (e) {
      // A free audit's cap refuses the whole rewrite: nothing is written.
      const cap = auditRefusal(e);
      if (cap) {
        setRefused(cap.message);
        setRunning(false);
        void load().catch(() => {});
        return;
      }
      // otherwise the loop below still writes; only the safety net is missing
    }
    const todo = pagePaths.flatMap((page_path) =>
      allTuples(served).map((t) => ({ ...t, page_path })),
    );
    let streak = 0;
    for (const t of todo) {
      if (cancelRef.current) break;
      let reason: string | undefined;
      let outcome: "ok" | "skipped" | "waiting" | "failed" = "ok";
      try {
        // No `auto`: the operator's own click writes at once, whatever the
        // queue's marker says.
        const res = await apiFetch<WriteResult>("/admin/variant/regenerate", {
          method: "POST",
          body: JSON.stringify({ customer_id: customerId, ...t }),
        });
        const o = writeOutcome(res);
        outcome = o.kind;
        if (o.kind === "failed") reason = o.reason;
      } catch (e) {
        const cap = auditRefusal(e);
        if (cap) {
          setRefused(cap.message);
          break;
        }
        outcome = "failed";
      }
      // A folded intent (the served set moved under the loop): nothing spent, not a failure.
      if (outcome === "skipped") continue;
      if (outcome === "ok") {
        setReady((n) => (n ?? 0) + 1);
        streak = 0;
        continue;
      }
      setFailed((n) => n + 1);
      if (outcome === "waiting") continue;
      // Three service-shaped failures in a row: stop and say why instead
      // of burning 45 s on each of the remaining versions.
      streak = looksLikeOutage(reason) ? streak + 1 : 0;
      if (streak >= OUTAGE_STOP_AFTER) {
        setStopped(OUTAGE_MESSAGE);
        break;
      }
    }
    setRunning(false);
  }, [customerId, pathsKey, running, load]);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  return {
    ready,
    total: tuplesPerPage(served) * Math.max(1, pagePaths.length),
    running,
    failed,
    stopped,
    refused,
    mode,
    rewriteAll,
  };
}

/** What /admin/variant/regenerate answers: the orchestrator's `error`, older callers' `reason`. */
interface WriteResult {
  ok?: boolean;
  error?: string;
  reason?: string;
}
