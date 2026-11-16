"use client";

import { Checkbox } from "@/components/ui/Checkbox";
import { Label } from "@/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { INTENT_DIMENSIONS, SOURCE_DIMENSIONS } from "@rawuser/shared";

export interface VariantFiltersValue {
  customerId: string;
  intent: string;
  source: string;
  staleOnly: boolean;
}

interface VariantFiltersProps {
  value: VariantFiltersValue;
  onChange: (next: VariantFiltersValue) => void;
}

export function VariantFilters({ value, onChange }: VariantFiltersProps) {
  function set<K extends keyof VariantFiltersValue>(key: K, val: VariantFiltersValue[K]) {
    onChange({ ...value, [key]: val });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select value={value.intent} onValueChange={(v) => set("intent", v)}>
        <SelectTrigger className="h-input-sm w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">
            All intents
          </SelectItem>
          {INTENT_DIMENSIONS.map((dim) => (
            <SelectItem key={dim} value={dim} className="text-xs capitalize">
              {dim}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={value.source} onValueChange={(v) => set("source", v)}>
        <SelectTrigger className="h-input-sm w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">
            All sources
          </SelectItem>
          {SOURCE_DIMENSIONS.map((dim) => (
            <SelectItem key={dim} value={dim} className="text-xs capitalize">
              {dim}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-1.5 ml-1">
        <Checkbox
          id="stale-only"
          checked={value.staleOnly}
          onChange={(e) => set("staleOnly", e.target.checked)}
        />
        <Label htmlFor="stale-only" className="text-xs cursor-pointer select-none">
          Stale only
        </Label>
      </div>
    </div>
  );
}
