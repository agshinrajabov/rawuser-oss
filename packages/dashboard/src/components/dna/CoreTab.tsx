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
import { Separator } from "@/components/ui/Separator";
import { Textarea } from "@/components/ui/Textarea";
import type { DnaSuggestions } from "@rawuser/shared";
import { Plus } from "lucide-react";
import { ListEditor } from "./ListEditor";
import { SuggestionChips, UseSuggestion } from "./SuggestionChips";

const LANGUAGES = [
  { value: "az", label: "Azerbaijani" },
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
  { value: "tr", label: "Turkish" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "ar", label: "Arabic" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
];

interface CoreTabProps {
  product: string;
  icp: string;
  target_market: string;
  target_language: string;
  value_props: string[];
  differentiators: string[];
  proof_points: string[];
  onField: <K extends "product" | "icp" | "target_market" | "target_language">(
    key: K,
    value: string,
  ) => void;
  onList: (key: "value_props" | "differentiators" | "proof_points", items: string[]) => void;
  /** Candidates read from the customer's site; null while loading or when none. */
  suggestions?: DnaSuggestions | null;
  /** True while the site is being read in the background. */
  suggesting?: boolean;
  onRefreshSuggestions?: () => void;
}

export function CoreTab({
  product,
  icp,
  target_market,
  target_language,
  value_props,
  differentiators,
  proof_points,
  onField,
  onList,
  suggestions,
  suggesting,
  onRefreshSuggestions,
}: CoreTabProps) {
  const sourceLabel = suggestions ? suggestions.url.replace(/^https?:\/\//, "") : "your site";
  const pick = (key: "value_props" | "differentiators" | "proof_points", current: string[]) => {
    return (text: string) => {
      const kept = current.filter((v) => v.trim());
      if (kept.some((v) => v.trim().toLowerCase() === text.toLowerCase())) return;
      onList(key, [...kept, text]);
    };
  };
  return (
    <div className="flex flex-col gap-gap-section pt-gap-section">
      {(suggesting || suggestions) && (
        <div className="flex items-center justify-end gap-2 font-mono text-[11px] text-fg-muted">
          {suggesting ? (
            <span>Reading {sourceLabel}…</span>
          ) : (
            <>
              <span>Suggestions read from {sourceLabel}</span>
              {onRefreshSuggestions && (
                <>
                  <span className="text-fg-faint">·</span>
                  <button
                    type="button"
                    onClick={onRefreshSuggestions}
                    className="underline underline-offset-2 hover:no-underline text-fg"
                  >
                    Refresh
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-gap-block">
        <div className="flex flex-col gap-gap-block">
          <div className="flex flex-col gap-1">
            <Label htmlFor="dna-product">
              What is your product? <span className="text-state-err">*</span>
            </Label>
            <p className="text-xs text-fg-muted">One sentence: what it is and what it does.</p>
            <div className="relative">
              <Input
                id="dna-product"
                value={product}
                onChange={(e) => onField("product", e.target.value)}
                placeholder={
                  suggestions?.product ?? "A 6-month UX/UI design course taught in Azerbaijani"
                }
                className={suggestions?.product && !product ? "pr-12" : undefined}
                required
                aria-required="true"
              />
              <UseSuggestion
                text={suggestions?.product ?? null}
                current={product}
                onUse={(t) => onField("product", t)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="dna-icp">
              Who is it for? <span className="text-state-err">*</span>
            </Label>
            <p className="text-xs text-fg-muted">
              The visitor you most want to win. Be specific: a real person, not "everyone".
            </p>
            <div className="relative">
              <Textarea
                id="dna-icp"
                value={icp}
                onChange={(e) => onField("icp", e.target.value)}
                placeholder={
                  suggestions?.icp ?? "Career-switchers who want a remote design job abroad"
                }
                required
                aria-required="true"
                className={suggestions?.icp && !icp ? "min-h-[96px] pr-12" : "min-h-[96px]"}
              />
              <UseSuggestion
                text={suggestions?.icp ?? null}
                current={icp}
                onUse={(t) => onField("icp", t)}
                variant="textarea"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-gap-block">
          <div className="flex flex-col gap-1">
            <Label htmlFor="dna-target-market">Where or which segment?</Label>
            <p className="text-xs text-fg-muted">Geography or market, if it matters.</p>
            <div className="relative">
              <Input
                id="dna-target-market"
                value={target_market}
                onChange={(e) => onField("target_market", e.target.value)}
                placeholder={suggestions?.target_market ?? "Germany, Austria and Switzerland"}
                className={suggestions?.target_market && !target_market ? "pr-12" : undefined}
              />
              <UseSuggestion
                text={suggestions?.target_market ?? null}
                current={target_market}
                onUse={(t) => onField("target_market", t)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="dna-target-language">Target language</Label>
            <Select
              value={target_language}
              onValueChange={(val) => onField("target_language", val)}
            >
              <SelectTrigger id="dna-target-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-gap-block">
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-md font-semibold text-fg">Why should someone care?</p>
            <p className="text-xs text-fg-muted">The main reasons to choose you, in your words.</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onList("value_props", [...value_props, ""])}
            disabled={value_props.length >= 7}
          >
            <Plus size={13} />
            Add
          </Button>
        </div>
        <SuggestionChips
          items={suggestions?.value_props ?? []}
          existing={value_props}
          disabled={value_props.filter((v) => v.trim()).length >= 7}
          onPick={pick("value_props", value_props)}
        />
        <ListEditor
          items={value_props}
          onChange={(items) => onList("value_props", items)}
          maxItems={7}
        />
      </div>

      <div className="flex flex-col gap-gap-block">
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-md font-semibold text-fg">What makes you different?</p>
            <p className="text-xs text-fg-muted">Versus the alternatives they're weighing.</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onList("differentiators", [...differentiators, ""])}
            disabled={differentiators.length >= 5}
          >
            <Plus size={13} />
            Add
          </Button>
        </div>
        <SuggestionChips
          items={suggestions?.differentiators ?? []}
          existing={differentiators}
          disabled={differentiators.filter((v) => v.trim()).length >= 5}
          onPick={pick("differentiators", differentiators)}
        />
        <ListEditor
          items={differentiators}
          onChange={(items) => onList("differentiators", items)}
          maxItems={5}
        />
      </div>

      <div className="flex flex-col gap-gap-block">
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-md font-semibold text-fg">Why should they trust you?</p>
            <p className="text-xs text-fg-muted">Names, numbers, logos, results. Real proof.</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onList("proof_points", [...proof_points, ""])}
            disabled={proof_points.length >= 8}
          >
            <Plus size={13} />
            Add
          </Button>
        </div>
        <SuggestionChips
          items={suggestions?.proof_points ?? []}
          existing={proof_points}
          disabled={proof_points.filter((v) => v.trim()).length >= 8}
          onPick={pick("proof_points", proof_points)}
        />
        <ListEditor
          items={proof_points}
          onChange={(items) => onList("proof_points", items)}
          maxItems={8}
        />
      </div>
    </div>
  );
}
