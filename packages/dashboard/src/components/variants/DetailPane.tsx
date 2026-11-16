"use client";

import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { apiFetch } from "@/lib/api";
import { formatDistanceToNow } from "@/lib/time";
import type { VariantBody, VariantListItem } from "@/types/api";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { MockLanding } from "./MockLanding";

interface DetailPaneProps {
  item: VariantListItem;
  customerId: string;
  onRegenerated: () => void;
}

export function DetailPane({ item, customerId, onRegenerated }: DetailPaneProps) {
  const [body, setBody] = useState<VariantBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getUrl = `/admin/variant/get?customer_id=${customerId}&intent=${item.intent_dim}&source=${item.source_dim}&page_path=${encodeURIComponent(item.page_path)}`;

  useEffect(() => {
    setLoading(true);
    setBody(null);
    setError(null);
    apiFetch<VariantBody>(getUrl)
      .then((v) => setBody(v))
      .catch(() => setError("Failed to load variant"))
      .finally(() => setLoading(false));
  }, [getUrl]);

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      await apiFetch("/admin/variant/regenerate", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          intent_dim: item.intent_dim,
          source_dim: item.source_dim,
          page_path: item.page_path,
        }),
      });
      const updated = await apiFetch<VariantBody>(getUrl);
      setBody(updated);
      onRegenerated();
    } catch {
      setError("Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-xs font-medium text-fg-muted">Model</span>
          <span className="font-mono text-xs text-fg">{item.model}</span>
          <span className="text-xs font-medium text-fg-muted">Cost</span>
          <span className="font-mono text-xs text-fg tabular-nums">
            ${item.cost_usd.toFixed(4)}
          </span>
          <span className="text-xs font-medium text-fg-muted">Generated</span>
          <span className="text-xs text-fg-muted">{formatDistanceToNow(item.generated_at)}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {error && <p className="text-sm text-fg-muted py-4">{error}</p>}
        {body && !loading && <MockLanding variant={body} />}
      </div>

      <div className="flex-shrink-0 border-t border-border p-4">
        <Button onClick={handleRegenerate} disabled={regenerating} className="w-full">
          <RefreshCw size={13} className={regenerating ? "animate-spin" : ""} />
          {regenerating ? "Regenerating…" : "Regenerate"}
        </Button>
        <p className="text-xs text-fg-faint text-center mt-2">~$0.04 per variant</p>
      </div>
    </div>
  );
}
