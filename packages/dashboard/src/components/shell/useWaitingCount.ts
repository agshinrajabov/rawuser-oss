"use client";

import { apiFetch } from "@/lib/api";
import { waitingVersions } from "@/lib/approval";
import type { VariantListAnswer, VariantListItem } from "@/types/api";
import { useEffect, useState } from "react";

/**
 * How many versions wait for the customer's OK, for the Versions count in
 * the sidebar. One read per customer a minute, shared by every screen (the
 * shell mounts on each page). Zero, and so no count, while the API has no
 * waiting state (lib/approval.ts).
 */
const cache = new Map<string, { at: number; n: number }>();
const TTL_MS = 60_000;

export function itemsOf(a: VariantListAnswer): VariantListItem[] {
  return Array.isArray(a) ? a : (a.items ?? []);
}

export function useWaitingCount(customerId: string): number {
  const hit = cache.get(customerId);
  const [n, setN] = useState(hit?.n ?? 0);
  useEffect(() => {
    if (!customerId) return;
    const c = cache.get(customerId);
    if (c && Date.now() - c.at < TTL_MS) {
      setN(c.n);
      return;
    }
    let cancelled = false;
    apiFetch<VariantListAnswer>(
      `/admin/variants/list?customer_id=${encodeURIComponent(customerId)}`,
    )
      .then((a) => {
        const count = waitingVersions(itemsOf(a)).length;
        cache.set(customerId, { at: Date.now(), n: count });
        if (!cancelled) setN(count);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  return n;
}

/** After an Approve: the count is read again on the next screen. */
export function forgetWaiting(customerId: string): void {
  cache.delete(customerId);
}
