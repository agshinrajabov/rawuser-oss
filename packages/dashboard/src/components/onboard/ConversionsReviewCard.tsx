"use client";

/**
 * ConversionsReviewCard — V2 Module 3.
 *
 * Renders after manifest confirm succeeds. Shows the AI-detected
 * conversion candidates (entries with conversion_candidate: true) as a
 * checkbox-confirm list. Operator chooses which ones to track + assigns
 * conversion_label + custom label.
 *
 * Submit → POST /admin/conversions/confirm. "Skip for now" closes the
 * card without submitting; the operator can come back via /conversions.
 */

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Separator } from "@/components/ui/Separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CONVERSION_LABELS,
  CONVERSION_LABEL_DESCRIPTIONS,
  type ConversionLabel,
  type ConversionsConfirmResponse,
  type Manifest,
} from "@/types/api";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface ConversionsReviewCardProps {
  customerId: string;
  manifest: Manifest;
}

interface Draft {
  section_path: string;
  label: string;
  conversion_label: ConversionLabel;
  enabled: boolean;
}

function defaultLabelForPath(path: string, fallback: string): string {
  // Use the first text signature if any, else fall back to the path itself.
  if (fallback && fallback.length > 0) return fallback.slice(0, 60);
  return path;
}

function inferConversionLabel(path: string): ConversionLabel {
  if (path.startsWith("pricing.")) return "signup";
  if (path.startsWith("forms.")) return "contact";
  if (path.includes("demo")) return "demo_request";
  return "signup";
}

export function ConversionsReviewCard({ customerId, manifest }: ConversionsReviewCardProps) {
  // Filter to candidates only. If no entry has conversion_candidate set,
  // we render nothing — pre-V2 manifests skip this card entirely.
  const candidates = useMemo(() => {
    return Object.entries(manifest)
      .filter(([, entry]) => entry.conversion_candidate === true)
      .map(([path, entry]) => ({ path, entry }));
  }, [manifest]);

  // Total detected elements in the manifest — used to give the candidate
  // count context (F15): "N of M detected elements flagged as primary actions".
  const totalElements = useMemo(() => Object.keys(manifest).length, [manifest]);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null); // count saved
  const [skipped, setSkipped] = useState(false);

  // Initialize drafts from candidates on mount / candidates change.
  useEffect(() => {
    if (candidates.length === 0) return;
    const initial: Record<string, Draft> = {};
    for (const { path, entry } of candidates) {
      initial[path] = {
        section_path: path,
        label: defaultLabelForPath(path, entry.text[0] ?? entry.structural),
        conversion_label: inferConversionLabel(path),
        enabled: true,
      };
    }
    setDrafts(initial);
    // Fade-in matches the existing manifest review card pattern.
    setVisible(false);
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [candidates]);

  function toggle(path: string) {
    setDrafts((d) => {
      const existing = d[path];
      if (!existing) return d;
      return { ...d, [path]: { ...existing, enabled: !existing.enabled } };
    });
  }

  function setLabel(path: string, value: string) {
    setDrafts((d) => {
      const existing = d[path];
      if (!existing) return d;
      return { ...d, [path]: { ...existing, label: value } };
    });
  }

  function setConvLabel(path: string, value: ConversionLabel) {
    setDrafts((d) => {
      const existing = d[path];
      if (!existing) return d;
      return { ...d, [path]: { ...existing, conversion_label: value } };
    });
  }

  async function handleSave() {
    setError(null);
    setSubmitting(true);
    try {
      const targets = Object.values(drafts).filter((t) => t.enabled);
      const resp = await apiFetch<ConversionsConfirmResponse>("/admin/conversions/confirm", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, targets }),
      });
      setSaved(resp.accepted.length);
      if (resp.rejected.length > 0) {
        setError(
          `${resp.rejected.length} target(s) rejected: ${resp.rejected.map((r) => `${r.section_path} (${r.reason})`).join(", ")}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) return null;
  if (skipped) return null;

  return (
    <Card
      className={cn(
        "p-4 transition-opacity duration-medium ease-smooth",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <p className="text-[0.9375rem] font-semibold text-fg mb-1">
        Potential conversion targets ({candidates.length} of {totalElements} detected element
        {totalElements === 1 ? "" : "s"} flagged as primary actions)
      </p>
      <p className="text-sm text-fg-muted mb-3">
        AI flagged these as primary conversion actions. Choose which to track. You can edit them
        later in <span className="font-mono text-xs">/conversions</span>.
      </p>
      <Separator className="mb-3" />

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[44px]" />
            <TableHead className="w-[180px]">Section</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="w-[160px]">Event</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {candidates.map(({ path }) => {
            const d = drafts[path];
            if (!d) return null;
            return (
              <TableRow key={path}>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    onChange={() => toggle(path)}
                    aria-label={`Track ${path} as a conversion`}
                    className="h-4 w-4"
                  />
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs text-fg">{path}</span>
                </TableCell>
                <TableCell>
                  <Input
                    value={d.label}
                    onChange={(e) => setLabel(path, e.target.value)}
                    disabled={!d.enabled}
                    className="h-input-sm text-sm"
                  />
                </TableCell>
                <TableCell>
                  <select
                    value={d.conversion_label}
                    onChange={(e) => setConvLabel(path, e.target.value as ConversionLabel)}
                    disabled={!d.enabled}
                    title={CONVERSION_LABEL_DESCRIPTIONS[d.conversion_label]}
                    className={cn(
                      "h-input-sm w-full rounded-sm border border-border bg-surface",
                      "px-2 text-xs font-mono text-fg",
                      "focus:outline-none focus:ring-1 focus:ring-fg",
                    )}
                  >
                    {CONVERSION_LABELS.map((label) => (
                      <option
                        key={label}
                        value={label}
                        title={CONVERSION_LABEL_DESCRIPTIONS[label]}
                      >
                        {label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[0.6875rem] leading-tight text-fg-muted">
                    {CONVERSION_LABEL_DESCRIPTIONS[d.conversion_label]}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {error && <p className="text-state-err text-sm mt-3">{error}</p>}
      {saved !== null && (
        <p className="text-state-success text-sm mt-3 flex items-center gap-1.5">
          <Check className="h-4 w-4" />
          Saved {saved} conversion target{saved === 1 ? "" : "s"}
        </p>
      )}

      <div className="flex items-center gap-2 mt-4">
        <Button type="button" onClick={handleSave} disabled={submitting || saved !== null}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Save conversions
        </Button>
        <Button type="button" variant="ghost" onClick={() => setSkipped(true)}>
          Skip for now
        </Button>
      </div>
    </Card>
  );
}
