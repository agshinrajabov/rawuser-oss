"use client";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { type BuiltLink, INTENT_UTM_CAMPAIGN, SOURCE_UTM_SOURCE } from "@/lib/tagged-link";
import { cn } from "@/lib/utils";
import type { IntentDim, SourceDim } from "@rawuser/shared";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// The generator itself lives in lib/tagged-link.ts, shared with the
// "Make a tagged link" dialog on Results.
export {
  INTENT_UTM_CAMPAIGN,
  SOURCE_UTM_MEDIUM,
  SOURCE_UTM_SOURCE,
  buildLink,
} from "@/lib/tagged-link";
export type { BuiltLink, LinkConfig } from "@/lib/tagged-link";

export const INTENT_UTM_HINT: Record<IntentDim, string> = {
  competitor: "vs|alternative|alternatives-to",
  evaluation: "comparison|review|alternatives|best",
  feature: "enterprise|security|api|features",
  problem: "how|why|problem|tutorial|guide",
  brand: "no campaign keyword · direct / typed-in",
  pricing: "pricing|free|plan|cost",
};

export const SOURCE_SIGNAL_HINT: Record<SourceDim, string> = {
  ai: "utm_source=chatgpt",
  social: "utm_medium=social · utm_source=linkedin",
  community: "referrer=reddit.com",
  paid: "utm_medium=cpc · utm_source=google-ads",
  organic: "referrer=google.com",
  direct: "no UTM, no referrer",
};

export interface LinkFormValues {
  baseUrl: string;
  intentTarget: IntentDim;
  sourceTarget: SourceDim;
  campaignOverride: string;
  sourceOverride: string;
}

interface LinkFormProps {
  values: LinkFormValues;
  onChange: (v: LinkFormValues) => void;
  builtLink: BuiltLink | null;
  onSave: () => void;
  urlError: string | null;
}

const INTENT_DIMS = [
  "competitor",
  "evaluation",
  "feature",
  "problem",
  "brand",
  "pricing",
] as const satisfies readonly IntentDim[];

const SOURCE_DIMS = [
  "ai",
  "social",
  "community",
  "paid",
  "organic",
  "direct",
] as const satisfies readonly SourceDim[];

export function LinkForm({ values, onChange, builtLink, onSave, urlError }: LinkFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback(
    <K extends keyof LinkFormValues>(key: K, val: LinkFormValues[K]) =>
      onChange({ ...values, [key]: val }),
    [values, onChange],
  );

  const handleCopy = useCallback(() => {
    if (!builtLink) return;
    navigator.clipboard.writeText(builtLink.url).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
      onSave();
    });
  }, [builtLink, onSave]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label
          htmlFor="base-url"
          className="text-xs font-medium text-fg-muted uppercase tracking-wide"
        >
          Base URL
        </Label>
        <Textarea
          id="base-url"
          value={values.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          onBlur={() => set("baseUrl", values.baseUrl.trim())}
          placeholder="https://your-site.com/landing"
          rows={2}
          className={cn("min-h-0", urlError ? "border-state-err" : "")}
          spellCheck={false}
          autoComplete="off"
        />
        {urlError && <p className="text-xs text-state-err">{urlError}</p>}
      </div>

      <div className="space-y-1">
        <Label
          htmlFor="intent-target"
          className="text-xs font-medium text-fg-muted uppercase tracking-wide"
        >
          Target intent
        </Label>
        <Select
          value={values.intentTarget}
          onValueChange={(v) => set("intentTarget", v as IntentDim)}
        >
          <SelectTrigger id="intent-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTENT_DIMS.map((dim) => (
              <SelectItem key={dim} value={dim}>
                <span className="capitalize">{dim}</span>
                <span className="ml-2 text-xs text-fg-faint font-mono">{INTENT_UTM_HINT[dim]}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label
          htmlFor="source-target"
          className="text-xs font-medium text-fg-muted uppercase tracking-wide"
        >
          Target source
        </Label>
        <Select
          value={values.sourceTarget}
          onValueChange={(v) => set("sourceTarget", v as SourceDim)}
        >
          <SelectTrigger id="source-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_DIMS.map((dim) => (
              <SelectItem key={dim} value={dim}>
                <span className="capitalize">{dim}</span>
                <span className="ml-2 text-xs text-fg-faint font-mono">
                  {SOURCE_SIGNAL_HINT[dim]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="border border-border rounded-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors duration-fast"
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? (
            <ChevronDown size={13} className="flex-shrink-0" />
          ) : (
            <ChevronRight size={13} className="flex-shrink-0" />
          )}
          <span className="text-xs font-medium">Advanced overrides</span>
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 pt-2 space-y-3 border-t border-border bg-surface-muted/30">
            <p className="text-xs text-fg-muted">
              Override the auto-derived UTM values to match an existing campaign naming convention.
            </p>
            <div className="space-y-1">
              <Label
                htmlFor="campaign-override"
                className="text-xs font-medium text-fg-muted uppercase tracking-wide"
              >
                utm_campaign override
              </Label>
              <Input
                id="campaign-override"
                type="text"
                value={values.campaignOverride}
                onChange={(e) => set("campaignOverride", e.target.value)}
                placeholder={`e.g. ${INTENT_UTM_CAMPAIGN[values.intentTarget]}`}
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="source-override"
                className="text-xs font-medium text-fg-muted uppercase tracking-wide"
              >
                utm_source override
              </Label>
              <Input
                id="source-override"
                type="text"
                value={values.sourceOverride}
                onChange={(e) => set("sourceOverride", e.target.value)}
                placeholder={SOURCE_UTM_SOURCE[values.sourceTarget] ?? "e.g. newsletter"}
                spellCheck={false}
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium text-fg-muted uppercase tracking-wide">
            Generated URL
          </Label>
          {builtLink && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-6 px-2 gap-1"
            >
              <Copy size={11} />
              <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
            </Button>
          )}
        </div>
        <div
          className={cn(
            "rounded-sm border border-border bg-surface-muted min-h-[40px] px-3 py-2 flex items-start",
          )}
        >
          {builtLink ? (
            <span className="font-mono text-xs text-fg break-all leading-relaxed">
              {builtLink.url}
            </span>
          ) : (
            <span className="font-mono text-xs text-fg-faint italic">
              {values.baseUrl.trim()
                ? "Enter a valid URL to generate the tagged link"
                : "Paste a base URL above to get started"}
            </span>
          )}
        </div>
        {builtLink && (
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="pill font-mono">
              utm_campaign=<strong className="text-fg font-medium">{builtLink.utmCampaign}</strong>
            </span>
            {builtLink.utmSource && (
              <span className="pill font-mono">
                utm_source=<strong className="text-fg font-medium">{builtLink.utmSource}</strong>
              </span>
            )}
            {builtLink.utmMedium && (
              <span className="pill font-mono">
                utm_medium=<strong className="text-fg font-medium">{builtLink.utmMedium}</strong>
              </span>
            )}
          </div>
        )}
      </div>

      {builtLink && (
        <Button type="button" variant="default" onClick={onSave}>
          Save to recent
        </Button>
      )}
    </div>
  );
}
