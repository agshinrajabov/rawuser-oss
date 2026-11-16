"use client";

import { apiFetch } from "@/lib/api";
import type { SiteMapView } from "@/types/api";
import { useCallback, useEffect, useState } from "react";

/**
 * The customer's site map (GET /admin/site-map, site-shaped-intents.md
 * §18.2). `loaded` turns true after the first answer or failure; a failure
 * (an older worker, a 403) leaves `view` null, which every reader takes as
 * "all six intents served, no row to show".
 */
export function useSiteMap(customerId: string, refreshKey: unknown = null) {
  const [view, setView] = useState<SiteMapView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [bump, setBump] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and bump are reload triggers
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    apiFetch<SiteMapView>(`/admin/site-map?customer_id=${encodeURIComponent(customerId)}`)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, refreshKey, bump]);

  const reload = useCallback(() => setBump((n) => n + 1), []);
  return { view, loaded, setView, reload };
}
