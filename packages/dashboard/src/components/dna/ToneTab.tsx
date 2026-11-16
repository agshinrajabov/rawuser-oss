"use client";

import { Input } from "@/components/ui/Input";
import { Separator } from "@/components/ui/Separator";
import { cn } from "@/lib/utils";
import type { IntentDim } from "@rawuser/shared";
import { useState } from "react";

/**
 * Voice presets: three or four plain words each, the shape the generation
 * prompt expects ("HONOR THE BRAND VOICE"). A pick replaces the field; the
 * operator can still edit the words.
 */
const VOICE_PRESETS = [
  "plain and direct",
  "warm and mentoring",
  "technical and precise",
  "confident and bold",
  "calm and formal",
  "light and playful",
];

/**
 * One row per intent dimension. `defaultAngle` is a plain-words summary of
 * what the generation prompt already does for that visitor
 * (packages/generation/src/prompts/intent-prompts.ts, intentDescriptions),
 * so the operator sees that nothing is required. `example` seeds the
 * optional note.
 */
const INTENT_ROWS: Array<{
  dim: IntentDim;
  title: string;
  caption: string;
  defaultAngle: string;
  example: string;
}> = [
  {
    dim: "brand",
    title: "Already knows you",
    caption: "typed your address, or came back",
    defaultAngle: "Tells the full story, warm and credible. This is the default page.",
    example: "e.g. What is new this season, if anything",
  },
  {
    dim: "competitor",
    title: "Comparing you to a rival",
    caption: "arrived from a 'vs' or 'alternative' search",
    defaultAngle:
      "Leads with the honest difference, backs it with proof, makes switching feel safe.",
    example: "e.g. Never name competitors",
  },
  {
    dim: "evaluation",
    title: "Weighing their options",
    caption: "researching the whole category",
    defaultAngle: "Gives criteria and transparency, no overselling.",
    example: "e.g. The one thing only you offer",
  },
  {
    dim: "feature",
    title: "Here for a feature",
    caption: "looking for one specific capability",
    defaultAngle: "Confirms the capability first, then goes deep and specific.",
    example: "e.g. The capability people ask about most",
  },
  {
    dim: "problem",
    title: "Has a problem to solve",
    caption: "came from a 'how do I' search or an AI answer",
    defaultAngle: "Names their problem in their own words before the product.",
    example: "e.g. Who usually arrives with this problem, in their words",
  },
  {
    dim: "pricing",
    title: "Price-first",
    caption: "cost is the main question",
    defaultAngle: "Prices and plans first; features justify the price.",
    example: "e.g. Payment terms worth stating, or what not to say about price",
  },
];

interface ToneTabProps {
  brand_voice: string;
  per_intent_hints: Partial<Record<IntentDim, string>>;
  onBrandVoice: (value: string) => void;
  onHint: (dim: IntentDim, value: string) => void;
  /** Tone read from the customer's site, if suggestions loaded. */
  voiceSuggestion?: string | null;
  /** Host of the site the suggestion came from, for the chip label. */
  sourceLabel?: string | null;
}

export function ToneTab({
  brand_voice,
  per_intent_hints,
  onBrandVoice,
  onHint,
  voiceSuggestion,
  sourceLabel,
}: ToneTabProps) {
  // Notes stay closed until asked for, except where one already exists.
  const [open, setOpen] = useState<Set<IntentDim>>(
    () =>
      new Set(INTENT_ROWS.filter((r) => (per_intent_hints[r.dim] ?? "").trim()).map((r) => r.dim)),
  );
  const current = brand_voice.trim().toLowerCase();

  return (
    <div className="flex flex-col gap-gap-section pt-gap-section">
      <p className="text-xs text-fg-muted">
        Nothing on this tab is required. Rawuser writes from your brief; this only steers the tone.
      </p>

      <div className="flex flex-col gap-gap-block">
        <div>
          <p className="text-md font-semibold text-fg">How should it sound?</p>
          <p className="text-xs text-fg-muted">
            Pick one, or write three or four words of your own. Every version keeps this tone.
          </p>
        </div>
        <Separator />
        <div className="flex flex-wrap gap-1.5">
          {voiceSuggestion && (
            <VoiceChip
              label={voiceSuggestion}
              hint={sourceLabel ? `Read from ${sourceLabel}` : undefined}
              selected={current === voiceSuggestion.trim().toLowerCase()}
              onPick={() => onBrandVoice(voiceSuggestion)}
              fromSite
            />
          )}
          {VOICE_PRESETS.map((preset) => (
            <VoiceChip
              key={preset}
              label={preset}
              selected={current === preset}
              onPick={() => onBrandVoice(preset)}
            />
          ))}
        </div>
        <Input
          id="dna-brand-voice"
          value={brand_voice}
          onChange={(e) => onBrandVoice(e.target.value)}
          placeholder="warm, mentor-like, credible"
          className="max-w-md"
        />
      </div>

      <div className="flex flex-col gap-gap-block">
        <div>
          <p className="text-md font-semibold text-fg">What each visitor gets</p>
          <p className="text-xs text-fg-muted">
            Rawuser already rewrites the page for six kinds of visitor. This is what each one gets
            by default. Add a note only to change it.
          </p>
        </div>
        <Separator />
        <div className="flex flex-col divide-y divide-border">
          {INTENT_ROWS.map((row) => {
            const value = per_intent_hints[row.dim] ?? "";
            const isOpen = open.has(row.dim);
            return (
              <div key={row.dim} className="grid gap-x-6 gap-y-1 py-3 md:grid-cols-[220px_1fr]">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-fg">{row.title}</span>
                  <span className="text-xs text-fg-muted">{row.caption}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-sm text-fg-muted">{row.defaultAngle}</p>
                  {isOpen ? (
                    <Input
                      value={value}
                      onChange={(e) => onHint(row.dim, e.target.value)}
                      placeholder={row.example}
                      className="max-w-lg"
                      autoFocus={!value}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpen((prev) => new Set(prev).add(row.dim))}
                      className="self-start text-xs text-fg underline underline-offset-2 hover:no-underline"
                    >
                      Add a note
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VoiceChip({
  label,
  hint,
  selected,
  onPick,
  fromSite,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPick: () => void;
  fromSite?: boolean;
}) {
  return (
    <button
      type="button"
      title={hint}
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "rounded-sm border px-2 py-1 text-xs transition-colors duration-fast ease-smooth",
        selected
          ? "border-fg bg-fg text-bg"
          : fromSite
            ? "border-dashed border-border-strong text-fg-muted hover:border-solid hover:border-fg hover:text-fg"
            : "border-border text-fg-muted hover:border-fg hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}
