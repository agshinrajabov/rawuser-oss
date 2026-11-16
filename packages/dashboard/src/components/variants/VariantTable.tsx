"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { formatDistanceToNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { VariantListItem } from "@/types/api";
import { MoreVertical, Sparkles } from "lucide-react";
import type { VariantFiltersValue } from "./VariantFilters";

interface VariantTableProps {
  items: VariantListItem[];
  loading: boolean;
  filters: VariantFiltersValue;
  selected: Set<string>;
  onSelect: (key: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onRowClick: (item: VariantListItem) => void;
  /** When `items.length === 0` AND this is provided, the empty state shows a Generate CTA. */
  onGenerateAll?: () => void;
}

function rowKey(item: VariantListItem) {
  return `${item.intent_dim}:${item.source_dim}`;
}

function statusBadge(status: VariantListItem["status"]) {
  if (status === "ready") return <Badge variant="success">● ready</Badge>;
  if (status === "stale") return <Badge variant="warn">● stale</Badge>;
  return <Badge variant="err">● error</Badge>;
}

function applyFilters(items: VariantListItem[], filters: VariantFiltersValue): VariantListItem[] {
  return items.filter((item) => {
    if (filters.intent !== "all" && item.intent_dim !== filters.intent) return false;
    if (filters.source !== "all" && item.source_dim !== filters.source) return false;
    if (filters.staleOnly && item.status !== "stale") return false;
    return true;
  });
}

export function VariantTable({
  items,
  loading,
  filters,
  selected,
  onSelect,
  onSelectAll,
  onRowClick,
  onGenerateAll,
}: VariantTableProps) {
  const filtered = applyFilters(items, filters);
  const allChecked = filtered.length > 0 && filtered.every((i) => selected.has(rowKey(i)));
  const someChecked = filtered.some((i) => selected.has(rowKey(i)));
  const totallyEmpty = !loading && items.length === 0;

  if (totallyEmpty && onGenerateAll) {
    return (
      <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm text-center">
        <Sparkles size={20} className="text-fg-faint mb-3" />
        <p className="text-sm font-medium text-fg mb-1">No variants yet</p>
        <p className="text-xs text-fg-muted mb-4 max-w-sm">
          Writes a version for each kind of visitor on this page. Takes a few minutes.
        </p>
        <Button size="sm" onClick={onGenerateAll}>
          <Sparkles size={12} />
          Generate variants
        </Button>
      </div>
    );
  }

  if (totallyEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-12 border border-border rounded-sm text-center">
        <p className="text-sm text-fg-muted mb-1">No variants yet</p>
        <p className="text-xs text-fg-faint max-w-sm">
          Fill in the Product brief first, then come back here to generate.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 px-3">
              <Checkbox
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked && !allChecked;
                }}
                onChange={(e) => onSelectAll(e.target.checked)}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead className="min-w-[120px]">Intent</TableHead>
            <TableHead className="min-w-[120px]">Source</TableHead>
            <TableHead className="w-[88px]">Status</TableHead>
            <TableHead className="w-[80px] text-right">Cost</TableHead>
            <TableHead className="w-[120px]">Generated</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            (["sk1", "sk2", "sk3", "sk4", "sk5", "sk6", "sk7", "sk8"] as const).map((k) => (
              <TableRow key={k} className="hover:bg-transparent">
                <TableCell className="w-10 px-3">
                  <Skeleton className="h-4 w-4" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-14" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3 w-12 ml-auto" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-3 w-14" />
                </TableCell>
                <TableCell />
              </TableRow>
            ))}

          {!loading && filtered.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="py-8 text-center text-sm text-fg-muted">
                No variants match the current filters.
              </TableCell>
            </TableRow>
          )}

          {!loading &&
            filtered.map((item) => {
              const key = rowKey(item);
              const isSelected = selected.has(key);
              return (
                <TableRow
                  key={key}
                  onClick={() => onRowClick(item)}
                  className={cn(
                    "cursor-pointer",
                    isSelected && "bg-surface-muted border-l-2 border-fg -ml-px",
                  )}
                >
                  <TableCell className="w-10 px-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isSelected}
                      onChange={(e) => onSelect(key, e.target.checked)}
                      aria-label={`Select ${item.intent_dim} · ${item.source_dim}`}
                    />
                  </TableCell>
                  <TableCell className="text-sm capitalize">{item.intent_dim}</TableCell>
                  <TableCell className="text-sm capitalize">{item.source_dim}</TableCell>
                  <TableCell className="w-[88px]">{statusBadge(item.status)}</TableCell>
                  <TableCell className="w-[80px] text-right font-mono text-xs tabular-nums text-fg-muted">
                    ${item.cost_usd.toFixed(3)}
                  </TableCell>
                  <TableCell className="w-[120px] text-xs text-fg-muted">
                    {formatDistanceToNow(item.generated_at)}
                  </TableCell>
                  <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-input-sm w-7"
                      aria-label="More"
                    >
                      <MoreVertical size={13} />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>

      {!loading && filtered.length > 0 && (
        <p className="text-xs text-fg-faint px-3 py-2">
          {filtered.length} row{filtered.length !== 1 ? "s" : ""}
          {items.length !== filtered.length ? ` · ${items.length} total` : ""}
        </p>
      )}
    </div>
  );
}
