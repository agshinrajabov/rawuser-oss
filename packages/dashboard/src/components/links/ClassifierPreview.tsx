"use client";

import { Badge } from "@/components/ui/Badge";
import { Separator } from "@/components/ui/Separator";
import { classify, extractSignals } from "@rawuser/shared";
import type { IntentDim, SourceDim } from "@rawuser/shared";
import { AlertTriangle, Check, X as XIcon } from "lucide-react";
import { useMemo } from "react";
import type { BuiltLink } from "./LinkForm";

interface ClassificationResult {
  dominantIntent: IntentDim;
  dominantIntentScore: number;
  dominantSource: SourceDim;
  dominantSourceScore: number;
  confidence: number;
  matchesIntent: boolean;
  matchesSource: boolean;
  whyExplanation: string;
  intentMismatchHint: string | null;
  sourceMismatchHint: string | null;
}

function runClassification(
  generatedUrl: string,
  intentTarget: IntentDim,
  sourceTarget: SourceDim,
): ClassificationResult | null {
  try {
    const url = new URL(generatedUrl);
    const headers = new Headers();
    // entryPath from the URL so the preview matches the edge (entry-path L1,
    // ADR 0023) — matters when the tagged link points at an intent-bearing path.
    const signals = extractSignals({ url, headers, entryPath: url.pathname });
    const vector = classify(signals, Date.now(), null);

    const sortedIntent = (Object.entries(vector.intent) as [IntentDim, number][]).sort(
      ([, a], [, b]) => b - a,
    );
    const sortedSource = (Object.entries(vector.source) as [SourceDim, number][]).sort(
      ([, a], [, b]) => b - a,
    );

    const [dominantIntent, dominantIntentScore] = sortedIntent[0] ?? ["brand", 0];
    const [dominantSource, dominantSourceScore] = sortedSource[0] ?? ["direct", 0];

    const matchesIntent = dominantIntent === intentTarget;
    const matchesSource = dominantSource === sourceTarget;

    let intentMismatchHint: string | null = null;
    let sourceMismatchHint: string | null = null;

    if (!matchesIntent) {
      const utmCampaign = url.searchParams.get("utm_campaign");
      intentMismatchHint = utmCampaign
        ? `utm_campaign="${utmCampaign}" routes to intent.${dominantIntent}. Try a value matching the ${intentTarget} pattern (e.g. "${getIntentExemplar(intentTarget)}")`
        : `No utm_campaign found. Add one matching the ${intentTarget} pattern`;
    }

    if (!matchesSource) {
      const utmSource = url.searchParams.get("utm_source");
      const utmMedium = url.searchParams.get("utm_medium");
      if (utmSource) {
        sourceMismatchHint = `utm_source="${utmSource}" (medium="${utmMedium ?? "none"}") routes to source.${dominantSource}. Try "${getSourceExemplar(sourceTarget)}" or use the override field`;
      } else {
        sourceMismatchHint = `No utm_source found. Add utm_source="${getSourceExemplar(sourceTarget)}" for source.${sourceTarget}`;
      }
    }

    const utmCampaign = url.searchParams.get("utm_campaign");
    const utmSource = url.searchParams.get("utm_source");
    let whyExplanation = "";
    if (utmCampaign) {
      whyExplanation = `utm_campaign="${utmCampaign}" matched intent.${dominantIntent}`;
      if (utmSource)
        whyExplanation += `, utm_source="${utmSource}" matched source.${dominantSource}`;
    } else if (utmSource) {
      whyExplanation = `utm_source="${utmSource}" matched source.${dominantSource}, no utm_campaign found`;
    } else {
      whyExplanation =
        "No UTM params, so it classifies as the default intent.brand + source.direct";
    }

    return {
      dominantIntent,
      dominantIntentScore,
      dominantSource,
      dominantSourceScore,
      confidence: vector.meta.confidence,
      matchesIntent,
      matchesSource,
      whyExplanation,
      intentMismatchHint,
      sourceMismatchHint,
    };
  } catch {
    return null;
  }
}

function getIntentExemplar(dim: IntentDim): string {
  const map: Record<IntentDim, string> = {
    competitor: "vs-competitor",
    evaluation: "comparison",
    feature: "features",
    problem: "how-it-works",
    brand: "brand",
    pricing: "pricing",
  };
  return map[dim];
}

function getSourceExemplar(dim: SourceDim): string {
  const map: Record<SourceDim, string> = {
    ai: "chatgpt",
    social: "linkedin",
    community: "reddit",
    paid: "google-ads",
    organic: "google",
    direct: "(remove utm_source)",
  };
  return map[dim];
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-muted">Confidence</span>
        <span className="font-mono text-xs text-fg">{pct}%</span>
      </div>
      <div className="h-px w-full bg-border relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-fg transition-all duration-300"
          style={{ width: `${pct}%`, height: "1px" }}
        />
      </div>
    </div>
  );
}

interface MatchLineProps {
  axis: "intent" | "source";
  target: string;
  classified: string;
  matches: boolean;
}

function MatchLine({ axis, target, classified, matches }: MatchLineProps) {
  if (matches) {
    return (
      <div className="flex items-center gap-2">
        <Check size={12} className="text-state-success flex-shrink-0" />
        <span className="text-xs text-fg-muted capitalize">{axis}</span>
        <Badge variant="default" className="capitalize">
          {target}
        </Badge>
        <span className="text-xs text-fg-muted">on target</span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <XIcon size={12} className="mt-0.5 flex-shrink-0 text-state-err" />
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-fg-muted capitalize">{axis}</span>
        <Badge variant="err" className="capitalize">
          {classified}
        </Badge>
        <span className="text-xs text-fg-muted">
          → target <span className="text-fg">{target}</span>
        </span>
      </div>
    </div>
  );
}

interface ClassifierPreviewProps {
  builtLink: BuiltLink | null;
  intentTarget: IntentDim;
  sourceTarget: SourceDim;
}

export function ClassifierPreview({
  builtLink,
  intentTarget,
  sourceTarget,
}: ClassifierPreviewProps) {
  const generatedUrl = builtLink?.url ?? null;

  const result = useMemo(
    () => (generatedUrl ? runClassification(generatedUrl, intentTarget, sourceTarget) : null),
    [generatedUrl, intentTarget, sourceTarget],
  );

  const anyMismatch = result && (!result.matchesIntent || !result.matchesSource);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-fg-muted uppercase tracking-wide mb-1">
          Live classification
        </p>
        <Separator />
      </div>

      {!builtLink ? (
        <p className="text-xs text-fg-faint">Generate a link above to preview its classification</p>
      ) : !result ? (
        <p className="text-xs text-fg-faint italic">Could not classify. Check the URL</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-fg-muted">Classifies as</p>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="default" className="capitalize">
                {result.dominantIntent}
              </Badge>
              <span className="text-xs text-fg-faint">·</span>
              <Badge variant="default" className="capitalize">
                {result.dominantSource}
              </Badge>
            </div>
          </div>

          <ConfidenceBar value={result.confidence} />

          <div className="space-y-2">
            <MatchLine
              axis="intent"
              target={intentTarget}
              classified={result.dominantIntent}
              matches={result.matchesIntent}
            />
            <MatchLine
              axis="source"
              target={sourceTarget}
              classified={result.dominantSource}
              matches={result.matchesSource}
            />
          </div>

          {anyMismatch && (
            <div className="border border-state-warn/20 bg-state-warn/5 rounded-sm px-3 py-2 space-y-1">
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={11} className="text-state-warn flex-shrink-0" />
                <span className="text-xs font-medium text-state-warn">Won't route as expected</span>
              </div>
              {result.intentMismatchHint && (
                <p className="text-xs text-fg-muted">{result.intentMismatchHint}</p>
              )}
              {result.sourceMismatchHint && (
                <p className="text-xs text-fg-muted">{result.sourceMismatchHint}</p>
              )}
            </div>
          )}

          <Separator />
          <p className="text-xs text-fg-muted">{result.whyExplanation}</p>
        </div>
      )}
    </div>
  );
}
