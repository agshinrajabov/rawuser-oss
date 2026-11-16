"use client";

/**
 * AddConversionForm — V2 Module 3 (U2: element dropdown).
 *
 * Adds a conversion target. The "Which element?" field is a dropdown of the
 * customer's CONFIRMED manifest elements (across every connected page),
 * humanized ("Hero button") and with AI-flagged conversion candidates surfaced
 * first as "suggested" — so the operator picks a real element instead of typing
 * a raw `hero.cta.label` path. A "Custom path…" escape hatch keeps the manual
 * entry for advanced paths not in a manifest.
 *
 * When the chosen section_path matches a manifest entry, the server
 * auto-derives the 3-tier selectors at upsert time — the operator only supplies
 * the path + label + type here.
 */

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CONVERSION_LABELS,
  CONVERSION_LABEL_DESCRIPTIONS,
  type ConversionLabel,
  type ConversionTarget,
  type ManifestsAllResponse,
} from "@/types/api";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { humanizeSectionPath } from "./humanize";

const CUSTOM = "__custom__";

interface AddConversionFormProps {
  customerId: string;
  onAdded: () => void;
  /** Section paths already tracked — excluded from the element dropdown. */
  existingPaths?: string[];
}

interface ElementOption {
  path: string;
  humanized: string;
  candidate: boolean;
}

export function AddConversionForm({
  customerId,
  onAdded,
  existingPaths = [],
}: AddConversionFormProps) {
  const [elements, setElements] = useState<ElementOption[] | null>(null);
  const [choice, setChoice] = useState(""); // dropdown value: a path, CUSTOM, or ""
  const [customPath, setCustomPath] = useState("");
  const [label, setLabel] = useState("");
  const [event, setEvent] = useState<ConversionLabel>("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable-by-value key so the effect doesn't refetch on every parent render
  // (existingPaths is a fresh array each render).
  const excludedKey = existingPaths.join("|");

  // Load confirmed manifests across every page → dedup element paths, drop ones
  // already tracked, surface AI candidates first. Only clickable elements
  // (paths ending in "label", or explicitly flagged conversion candidates) are
  // offered — a headline/body isn't a conversion.
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    apiFetch<ManifestsAllResponse>(
      `/admin/onboard/manifest?customer_id=${encodeURIComponent(customerId)}&all=true`,
    )
      .then((data) => {
        if (cancelled) return;
        const excluded = new Set(excludedKey ? excludedKey.split("|") : []);
        const byPath = new Map<string, ElementOption>();
        for (const m of data.manifests ?? []) {
          for (const [path, entry] of Object.entries(m.manifest)) {
            if (excluded.has(path)) continue;
            const clickable = path.endsWith("label") || entry.conversion_candidate === true;
            if (!clickable) continue;
            const existing = byPath.get(path);
            if (existing) {
              existing.candidate = existing.candidate || entry.conversion_candidate === true;
            } else {
              byPath.set(path, {
                path,
                humanized: humanizeSectionPath(path),
                candidate: entry.conversion_candidate === true,
              });
            }
          }
        }
        const out = [...byPath.values()].sort(
          (a, b) => Number(b.candidate) - Number(a.candidate) || a.path.localeCompare(b.path),
        );
        setElements(out);
      })
      .catch(() => {
        if (!cancelled) setElements([]); // no manifest → custom-only
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, excludedKey]);

  const isCustom = choice === CUSTOM;
  const sectionPath = isCustom ? customPath.trim() : choice;

  // No manifest elements to offer → collapse straight to the custom text input.
  const customOnly = elements !== null && elements.length === 0;
  const effectiveCustom = isCustom || customOnly;

  const selectValue = useMemo(() => {
    if (customOnly) return CUSTOM;
    return choice;
  }, [customOnly, choice]);

  function handleChoice(value: string) {
    setChoice(value);
    if (value && value !== CUSTOM) {
      // Pre-fill the operator-facing label from the humanized name (editable).
      const el = elements?.find((e) => e.path === value);
      if (el && !label.trim()) setLabel(el.humanized);
    }
  }

  async function submit() {
    if (!sectionPath || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<ConversionTarget>("/admin/conversions/upsert", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          section_path: sectionPath,
          label: label.trim(),
          conversion_label: event,
        }),
      });
      setChoice("");
      setCustomPath("");
      setLabel("");
      setEvent("signup");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !sectionPath || !label.trim();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cnv-path">Which element?</Label>
          <p className="text-xs text-fg-muted">The element visitors click to convert.</p>
          {!customOnly && (
            <select
              id="cnv-path"
              value={selectValue}
              onChange={(e) => handleChoice(e.target.value)}
              disabled={elements === null}
              className={cn(
                "h-input-sm w-full rounded-sm border border-border bg-surface",
                "px-2 text-sm text-fg",
                "focus:outline-none focus:ring-1 focus:ring-fg",
              )}
            >
              <option value="" disabled>
                {elements === null ? "Loading elements…" : "Choose a detected element…"}
              </option>
              {elements?.map((el) => (
                <option key={el.path} value={el.path}>
                  {el.humanized}
                  {el.candidate ? " · suggested" : ""} ({el.path})
                </option>
              ))}
              <option value={CUSTOM}>Custom path…</option>
            </select>
          )}
          {effectiveCustom && (
            <Input
              id="cnv-path-custom"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="hero.cta.label"
              aria-label="Custom element path"
              required
              className="font-mono text-sm"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cnv-label">Name it</Label>
          <p className="text-xs text-fg-muted">A short label just for you.</p>
          <Input
            id="cnv-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Enrol button"
            required
            className="text-sm"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cnv-event">What it counts as</Label>
        <select
          id="cnv-event"
          value={event}
          onChange={(e) => setEvent(e.target.value as ConversionLabel)}
          className={cn(
            "h-input-sm w-full max-w-[260px] rounded-sm border border-border bg-surface",
            "px-2 text-sm font-mono text-fg",
            "focus:outline-none focus:ring-1 focus:ring-fg",
          )}
        >
          {CONVERSION_LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <p className="text-xs text-fg-muted">
          <span className="font-mono">{event}</span> · {CONVERSION_LABEL_DESCRIPTIONS[event]}
        </p>
      </div>
      <Button type="button" onClick={submit} disabled={disabled}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Add target
      </Button>
      {error && <p className="text-state-err text-sm">{error}</p>}
    </div>
  );
}
