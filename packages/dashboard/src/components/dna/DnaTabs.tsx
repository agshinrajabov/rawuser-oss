"use client";

import { useCustomerList } from "@/components/shell/CustomerListContext";
import { useTopbarRightSlot } from "@/components/shell/TopbarSlotContext";
import { Button } from "@/components/ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BusinessDNA, DnaSuggestions, IntentDim } from "@rawuser/shared";
import { Check, Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CoreTab } from "./CoreTab";
import { ToneTab } from "./ToneTab";

type FormState = {
  product: string;
  icp: string;
  target_market: string;
  target_language: string;
  brand_voice: string;
  value_props: string[];
  differentiators: string[];
  proof_points: string[];
  per_intent_hints: Partial<Record<IntentDim, string>>;
};

const DEFAULT_FORM: FormState = {
  product: "",
  icp: "",
  target_market: "",
  target_language: "az",
  brand_voice: "",
  value_props: [""],
  differentiators: [""],
  proof_points: [""],
  per_intent_hints: {},
};

function isDirtyCheck(a: FormState, b: FormState): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function DnaTabs() {
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customer_id") ?? "";

  const { refresh: refreshCustomers } = useCustomerList();
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [original, setOriginal] = useState<FormState>(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<DnaSuggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  // Read the customer's site in the background and offer what it says as
  // chips (docs/specs/dna-suggestions.md). Failure is silent: the form
  // works without it.
  const loadSuggestions = useCallback(
    (refresh: boolean) => {
      setSuggesting(true);
      apiFetch<DnaSuggestions>(
        `/admin/dna/suggest?customer_id=${customerId}${refresh ? "&refresh=1" : ""}`,
      )
        .then((s) => setSuggestions(s))
        .catch(() => setSuggestions(null))
        .finally(() => setSuggesting(false));
    },
    [customerId],
  );

  useEffect(() => {
    loadSuggestions(false);
  }, [loadSuggestions]);

  useEffect(() => {
    apiFetch<BusinessDNA>(`/admin/dna/get?customer_id=${customerId}`)
      .then((dna) => {
        const loaded: FormState = {
          product: dna.product,
          icp: dna.icp,
          target_market: dna.target_market,
          target_language: dna.target_language,
          brand_voice: dna.brand_voice,
          value_props: dna.value_props.length > 0 ? dna.value_props : [""],
          differentiators: dna.differentiators.length > 0 ? dna.differentiators : [""],
          proof_points: dna.proof_points.length > 0 ? dna.proof_points : [""],
          per_intent_hints: dna.per_intent_hints ?? {},
        };
        setForm(loaded);
        setOriginal(loaded);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [customerId]);

  const isDirty = useMemo(() => isDirtyCheck(form, original), [form, original]);

  function updateField<
    K extends keyof Omit<
      FormState,
      "value_props" | "differentiators" | "proof_points" | "per_intent_hints"
    >,
  >(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateList(key: "value_props" | "differentiators" | "proof_points", items: string[]) {
    setForm((prev) => ({ ...prev, [key]: items }));
  }

  function updateHint(dim: IntentDim, value: string) {
    setForm((prev) => ({
      ...prev,
      per_intent_hints: { ...prev.per_intent_hints, [dim]: value },
    }));
  }

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    try {
      const payload: BusinessDNA = {
        customer_id: customerId,
        product: form.product.trim(),
        icp: form.icp.trim(),
        target_market: form.target_market.trim(),
        target_language: form.target_language,
        brand_voice: form.brand_voice.trim(),
        value_props: form.value_props.filter((v) => v.trim()),
        differentiators: form.differentiators.filter((v) => v.trim()),
        proof_points: form.proof_points.filter((v) => v.trim()),
        per_intent_hints: form.per_intent_hints,
        updated_at: Date.now(),
      };
      await apiFetch("/admin/dna/upsert", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const snapshot = { ...form };
      setOriginal(snapshot);
      // has_dna feeds the Next-step banner; refresh so it moves to "versions".
      refreshCustomers();
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, form, customerId, refreshCustomers]);

  const rightSlot = useMemo(
    () => (
      <div className="flex items-center gap-2">
        {isDirty && !saving && (
          <span className="text-xs text-state-warn font-medium">● unsaved</span>
        )}
        {savedAt && !isDirty && (
          <span className={cn("flex items-center gap-1 text-xs text-state-success font-medium")}>
            <Check size={12} />
            Saved
          </span>
        )}
        <Button type="button" size="sm" onClick={handleSave} disabled={!isDirty || saving}>
          {saving && <Loader2 size={12} className="animate-spin" />}
          Save changes
        </Button>
      </div>
    ),
    [isDirty, saving, savedAt, handleSave],
  );

  useTopbarRightSlot(rightSlot);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-fg-muted text-sm">
        <Loader2 size={14} className="animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <Tabs defaultValue="core">
      <TabsList>
        <TabsTrigger value="core">Product &amp; audience</TabsTrigger>
        <TabsTrigger value="tone">Voice &amp; notes</TabsTrigger>
      </TabsList>

      <TabsContent value="core">
        <CoreTab
          product={form.product}
          icp={form.icp}
          target_market={form.target_market}
          target_language={form.target_language}
          value_props={form.value_props}
          differentiators={form.differentiators}
          proof_points={form.proof_points}
          onField={updateField}
          onList={updateList}
          suggestions={suggestions}
          suggesting={suggesting}
          onRefreshSuggestions={() => loadSuggestions(true)}
        />
      </TabsContent>

      <TabsContent value="tone">
        <ToneTab
          brand_voice={form.brand_voice}
          per_intent_hints={form.per_intent_hints}
          onBrandVoice={(v) => updateField("brand_voice", v)}
          voiceSuggestion={suggestions?.brand_voice ?? null}
          sourceLabel={suggestions ? suggestions.url.replace(/^https?:\/\//, "") : null}
          onHint={updateHint}
        />
      </TabsContent>
    </Tabs>
  );
}
