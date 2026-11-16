"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { apiFetch } from "@/lib/api";
import type { VariantBody, VariantListItem } from "@/types/api";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "@rawuser/shared";
import { useEffect, useState } from "react";
import { MockLanding } from "./MockLanding";

interface CompareProps {
  items: VariantListItem[];
  customerId: string;
  /** The page whose variants are being compared (A1). Defaults to '/'. */
  pagePath: string;
}

type SelectionTuple = { intent: string; source: string };

function VariantPanel({
  label,
  selection,
  onSelection,
  items,
  customerId,
  pagePath,
}: {
  label: string;
  selection: SelectionTuple;
  onSelection: (t: SelectionTuple) => void;
  items: VariantListItem[];
  customerId: string;
  pagePath: string;
}) {
  const [body, setBody] = useState<VariantBody | null>(null);
  const [loading, setLoading] = useState(false);
  const [fadeKey, setFadeKey] = useState(0);

  const available = new Set(items.map((i) => `${i.intent_dim}:${i.source_dim}`));

  useEffect(() => {
    setLoading(true);
    setBody(null);
    apiFetch<VariantBody>(
      `/admin/variant/get?customer_id=${customerId}&intent=${selection.intent}&source=${selection.source}&page_path=${encodeURIComponent(pagePath)}`,
    )
      .then((v) => {
        setBody(v);
        setFadeKey((k) => k + 1);
      })
      .catch(() => setBody(null))
      .finally(() => setLoading(false));
  }, [selection.intent, selection.source, customerId, pagePath]);

  const currentKey = `${selection.intent}:${selection.source}`;

  return (
    <Card>
      <CardHeader className="py-3">
        <p className="text-xs font-medium text-fg-muted uppercase tracking-[0.06em] mb-2">
          {label}
        </p>
        <Select
          value={currentKey}
          onValueChange={(val) => {
            const [intent, source] = val.split(":");
            if (intent && source) onSelection({ intent, source });
          }}
        >
          <SelectTrigger className="h-input-sm text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTENT_DIMENSIONS.flatMap((intent) =>
              SOURCE_DIMENSIONS.map((source) => {
                const key = `${intent}:${source}`;
                const exists = available.has(key);
                return (
                  <SelectItem key={key} value={key} disabled={!exists} className="text-xs">
                    {intent} · {source}
                    {!exists ? " · none" : ""}
                  </SelectItem>
                );
              }),
            )}
          </SelectContent>
        </Select>
        <p className="font-mono text-xs text-fg-faint mt-1">
          {selection.intent} · {selection.source}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {loading && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {!loading && !body && (
          <div className="py-8 font-mono text-xs text-fg-faint text-center">
            No variant generated
          </div>
        )}
        {body && !loading && (
          <div key={fadeKey} className="animate-cross-fade">
            <MockLanding variant={body} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Compare({ items, customerId, pagePath }: CompareProps) {
  const [leftSel, setLeftSel] = useState<SelectionTuple>({ intent: "competitor", source: "ai" });
  const [rightSel, setRightSel] = useState<SelectionTuple>({
    intent: "competitor",
    source: "community",
  });

  return (
    <div className="pt-section">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-section">
        <VariantPanel
          label="Left"
          selection={leftSel}
          onSelection={setLeftSel}
          items={items}
          customerId={customerId}
          pagePath={pagePath}
        />
        <VariantPanel
          label="Right"
          selection={rightSel}
          onSelection={setRightSel}
          items={items}
          customerId={customerId}
          pagePath={pagePath}
        />
      </div>
    </div>
  );
}
