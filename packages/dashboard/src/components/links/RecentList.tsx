"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Separator } from "@/components/ui/Separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { formatDistanceToNow } from "@/lib/time";
import type { IntentDim, SourceDim } from "@rawuser/shared";
import { AlertTriangle, CornerUpLeft } from "lucide-react";
import type { LinkFormValues } from "./LinkForm";

export interface RecentLinkEntry {
  id: string;
  base_url: string;
  intent_target: IntentDim;
  source_target: SourceDim;
  generated_url: string;
  classified_intent: IntentDim;
  classified_source: SourceDim;
  ts: number;
}

const STORAGE_KEY = "rawuser_recent_links";
const MAX_ENTRIES = 20;

export function loadRecentLinks(): RecentLinkEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentLinkEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveRecentLink(entry: RecentLinkEntry): RecentLinkEntry[] {
  const existing = loadRecentLinks().filter((e) => e.id !== entry.id);
  const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

function truncateUrl(url: string, maxLen = 56): string {
  if (url.length <= maxLen) return url;
  return `${url.slice(0, maxLen)}…`;
}

interface RecentListProps {
  entries: RecentLinkEntry[];
  onRestore: (values: LinkFormValues) => void;
}

export function RecentList({ entries, onRestore }: RecentListProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs font-medium text-fg-muted uppercase tracking-wide">
          Recent (this session)
        </p>
        {entries.length > 0 && <span className="text-xs text-fg-faint">{entries.length}</span>}
      </div>

      <Separator className="mb-3" />

      {entries.length === 0 ? (
        <p className="text-xs text-fg-faint">Generated links stay here for this session only.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Built URL</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const intentMatch = entry.classified_intent === entry.intent_target;
              const sourceMatch = entry.classified_source === entry.source_target;
              const bothMatch = intentMatch && sourceMatch;

              const restoreValues: LinkFormValues = {
                baseUrl: entry.base_url,
                intentTarget: entry.intent_target,
                sourceTarget: entry.source_target,
                campaignOverride: "",
                sourceOverride: "",
              };

              return (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {!bothMatch && (
                        <span
                          title="Routing mismatch: classified differently from the target"
                          className="inline-flex"
                        >
                          <AlertTriangle size={11} className="text-state-warn flex-shrink-0" />
                        </span>
                      )}
                      <Badge variant="default" className="capitalize">
                        {entry.intent_target}
                      </Badge>
                      <span className="text-xs text-fg-faint">/</span>
                      <Badge variant="default" className="capitalize">
                        {entry.source_target}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span
                      className="font-mono text-xs text-fg-muted truncate block max-w-xs"
                      title={entry.generated_url}
                    >
                      {truncateUrl(entry.generated_url)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-fg-muted">{formatDistanceToNow(entry.ts)}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onRestore(restoreValues)}
                      aria-label={`Restore ${entry.intent_target} × ${entry.source_target} link`}
                      className="h-6 px-2 gap-1"
                    >
                      <CornerUpLeft size={11} />
                      <span className="text-xs">Restore</span>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
