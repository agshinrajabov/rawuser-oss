"use client";

import { Separator } from "@/components/ui/Separator";
import {
  CONTEXT_DIMENSIONS,
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  classify,
  extractSignals,
} from "@rawuser/shared";
import { useMemo, useState } from "react";
import { DimBar } from "./DimBar";

interface SimInputs {
  url: string;
  referrer: string;
  userAgent: string;
}

const DEFAULT_INPUTS: SimInputs = {
  url: "https://example.com?utm_campaign=salesforce-alternative&utm_medium=cpc",
  referrer: "https://news.ycombinator.com/",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

function runClassifier(inputs: SimInputs) {
  try {
    const url = new URL(inputs.url);
    const headers = new Headers();
    if (inputs.referrer) headers.set("referer", inputs.referrer);
    if (inputs.userAgent) headers.set("user-agent", inputs.userAgent);

    // Pass the URL's pathname as entryPath so the simulator applies the
    // entry-path intent signal (L1, ADR 0023) exactly like the edge does —
    // otherwise a naked "/pricing" visit shows as brand/no-signal here while
    // the real edge personalizes it as pricing intent.
    const signals = extractSignals({ url, headers, entryPath: url.pathname });
    const vector = classify(signals, Date.now());

    return { signals, vector, error: null };
  } catch (e) {
    return {
      signals: null,
      vector: null,
      error: e instanceof Error ? e.message : "Invalid input",
    };
  }
}

interface SimFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function SimField({ label, value, onChange, placeholder }: SimFieldProps) {
  const id = `sim-${label.toLowerCase().replace(/[^a-z]/g, "-")}`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs text-fg-muted block">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-input px-2.5 rounded-sm border border-border bg-transparent text-fg font-mono text-xs focus:outline-none focus:border-border-strong transition-colors duration-fast"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}

function DimGroup({
  label,
  dims,
  values,
}: {
  label: string;
  dims: readonly string[];
  values: Record<string, number>;
}) {
  const sorted = [...dims].sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0));
  const dominant = sorted[0];

  return (
    <div className="space-y-gap-block">
      <p className="text-xs font-medium text-fg-muted uppercase tracking-[0.06em]">{label}</p>
      <div className="space-y-1.5">
        {sorted.map((dim) => (
          <DimBar
            key={dim}
            label={dim}
            value={values[dim] ?? 0}
            isDominant={dim === dominant && (values[dominant] ?? 0) > 0}
          />
        ))}
      </div>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-xs text-fg-faint w-28 flex-shrink-0">{label}</span>
      <span className="font-mono text-xs text-fg truncate">{value}</span>
    </div>
  );
}

export function ClassifierSimulator() {
  const [inputs, setInputs] = useState<SimInputs>(DEFAULT_INPUTS);

  const set = (key: keyof SimInputs) => (v: string) => setInputs((prev) => ({ ...prev, [key]: v }));

  const result = useMemo(() => runClassifier(inputs), [inputs]);

  const topIntent = result.vector
    ? (Object.entries(result.vector.intent).sort(([, a], [, b]) => b - a)[0] ?? null)
    : null;

  const topSource = result.vector
    ? (Object.entries(result.vector.source).sort(([, a], [, b]) => b - a)[0] ?? null)
    : null;

  const confidence = result.vector?.meta.confidence ?? 0;
  const leadProbability = result.vector?.meta.lead_probability ?? 0;

  return (
    <div className="space-y-gap-section">
      <div>
        <p className="text-md font-semibold text-fg">Live classifier</p>
        <Separator className="mt-2" />
      </div>

      <div className="space-y-gap-block">
        <SimField
          label="URL"
          value={inputs.url}
          onChange={set("url")}
          placeholder="https://example.com?utm_campaign=..."
        />
        <SimField
          label="Referer"
          value={inputs.referrer}
          onChange={set("referrer")}
          placeholder="https://news.ycombinator.com/"
        />
        <SimField
          label="User-Agent"
          value={inputs.userAgent}
          onChange={set("userAgent")}
          placeholder="Mozilla/5.0..."
        />
      </div>

      {result.error && <p className="font-mono text-xs text-state-err">{result.error}</p>}

      {result.signals && (
        <div className="space-y-gap-block">
          <p className="text-xs font-medium text-fg-muted uppercase tracking-[0.06em]">Signals</p>
          <div className="space-y-1">
            <SignalRow label="utm_campaign" value={result.signals.utm.campaign} />
            <SignalRow label="utm_medium" value={result.signals.utm.medium} />
            <SignalRow label="utm_source" value={result.signals.utm.source} />
            <SignalRow label="referrer_host" value={result.signals.referrerHost} />
            <SignalRow label="ai_source" value={result.signals.aiSource} />
            <SignalRow label="device" value={result.signals.device} />
          </div>
        </div>
      )}

      {result.vector && (
        <>
          <DimGroup
            label="Intent"
            dims={INTENT_DIMENSIONS}
            values={result.vector.intent as unknown as Record<string, number>}
          />
          <DimGroup
            label="Source"
            dims={SOURCE_DIMENSIONS}
            values={result.vector.source as unknown as Record<string, number>}
          />
          <DimGroup
            label="Context"
            dims={CONTEXT_DIMENSIONS}
            values={result.vector.context as unknown as Record<string, number>}
          />

          <Separator />

          <div className="space-y-1.5">
            <p className="text-sm text-fg-muted">
              dominant:{" "}
              {topIntent && topIntent[1] > 0 ? (
                <span className="text-fg font-medium">intent.{topIntent[0]}</span>
              ) : (
                <span className="text-fg-faint">intent.none</span>
              )}{" "}
              +{" "}
              {topSource && topSource[1] > 0 ? (
                <span className="text-fg font-medium">source.{topSource[0]}</span>
              ) : (
                <span className="text-fg-faint">source.none</span>
              )}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs border border-border bg-surface-muted text-fg-muted rounded-pill px-2 py-0.5">
                conf {confidence.toFixed(2)}
              </span>
              <span className="font-mono text-xs border border-border bg-surface-muted text-fg-muted rounded-pill px-2 py-0.5">
                lead {leadProbability.toFixed(2)}
              </span>
            </div>
          </div>
        </>
      )}

      {!result.vector && !result.error && (
        <span className="font-mono text-xs text-fg-faint">Enter a URL to classify</span>
      )}
    </div>
  );
}
