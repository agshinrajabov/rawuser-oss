"use client";

import { NextStepsBanner } from "@/components/journey/NextStepsBanner";
import { YourAdsForCustomer } from "@/components/links/AdLinks";
import { ClassifierPreview } from "@/components/links/ClassifierPreview";
import { LinkForm, buildLink } from "@/components/links/LinkForm";
import type { LinkFormValues } from "@/components/links/LinkForm";
import { RecentList, loadRecentLinks, saveRecentLink } from "@/components/links/RecentList";
import type { RecentLinkEntry } from "@/components/links/RecentList";
import { AppShell } from "@/components/shell/AppShell";
import { OldRoute } from "@/components/shell/OldRoute";
import { Separator } from "@/components/ui/Separator";
import { classifyLink } from "@/lib/tagged-link";
import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

function validateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    new URL(trimmed);
    return null;
  } catch {
    return "Enter a valid URL including the protocol (e.g. https://…)";
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const DEFAULT_FORM: LinkFormValues = {
  baseUrl: "",
  intentTarget: "competitor",
  sourceTarget: "paid",
  campaignOverride: "",
  sourceOverride: "",
};

export default function LinksPage() {
  const [form, setForm] = useState<LinkFormValues>(DEFAULT_FORM);
  const [recent, setRecent] = useState<RecentLinkEntry[]>([]);

  const deferredForm = useDeferredValue(form);

  useEffect(() => {
    setRecent(loadRecentLinks());
  }, []);

  const urlError = useMemo(
    () => (form.baseUrl.trim() ? validateUrl(form.baseUrl) : null),
    [form.baseUrl],
  );

  const builtLink = useMemo(() => {
    if (urlError) return null;
    return buildLink({
      baseUrl: deferredForm.baseUrl,
      intentTarget: deferredForm.intentTarget,
      sourceTarget: deferredForm.sourceTarget,
      campaignOverride: deferredForm.campaignOverride,
      sourceOverride: deferredForm.sourceOverride,
    });
  }, [deferredForm, urlError]);

  const handleSave = useCallback(() => {
    if (!builtLink) return;
    const { intent, source } = classifyLink(builtLink.url);
    const entry: RecentLinkEntry = {
      id: makeId(),
      base_url: form.baseUrl.trim(),
      intent_target: form.intentTarget,
      source_target: form.sourceTarget,
      generated_url: builtLink.url,
      classified_intent: intent,
      classified_source: source,
      ts: Date.now(),
    };
    setRecent(saveRecentLink(entry));
  }, [builtLink, form]);

  const handleRestore = useCallback((values: LinkFormValues) => {
    setForm(values);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>
          <div className="mb-5">
            <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Campaign links</h1>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">
              Tagged links for ads, posts and newsletters. Their visitors get a version.
            </p>
          </div>

          <Suspense>
            <NextStepsBanner screen="links" />
          </Suspense>

          {/* Ad links above the builder (ads-platforms mock, section 01): a line
          pasted once tags every ad; the builder makes one link at a time. */}
          <Suspense>
            <YourAdsForCustomer />
          </Suspense>

          <Separator className="my-6" />

          <div className="grid grid-cols-2 gap-6 mb-6">
            <LinkForm
              values={form}
              onChange={setForm}
              builtLink={builtLink}
              onSave={handleSave}
              urlError={urlError}
            />

            <ClassifierPreview
              builtLink={builtLink}
              intentTarget={deferredForm.intentTarget}
              sourceTarget={deferredForm.sourceTarget}
            />
          </div>

          <Separator className="mb-6" />

          <RecentList entries={recent} onRestore={handleRestore} />
        </OldRoute>
      </Suspense>
    </AppShell>
  );
}
