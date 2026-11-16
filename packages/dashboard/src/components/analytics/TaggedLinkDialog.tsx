"use client";

import { saveRecentLink } from "@/components/links/RecentList";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { intentLabel, sourceLabel } from "@/lib/results";
import { ABOUT, SHARE_PLACES, homeUrl, taggedLink } from "@/lib/tagged-link";
import { cn } from "@/lib/utils";
import type { IntentDim } from "@rawuser/shared";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * "Make a tagged link" on Results (founder, 2026-10-04: a dialog here, not a
 * trip to Campaign links). The link comes from the Campaign links generator
 * and is read back by the edge's classifier, so the version it names is the
 * one its visits get. A copied link also lands in Campaign links' recent list.
 */
export function TaggedLinkDialog({
  open,
  onOpenChange,
  domain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domain: string;
}) {
  const [page, setPage] = useState(homeUrl(domain));
  const [placeId, setPlaceId] = useState(SHARE_PLACES[0]?.id ?? "linkedin");
  const [about, setAbout] = useState<IntentDim>("problem");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setPage(homeUrl(domain));
      setCopied(false);
    }
  }, [open, domain]);

  const place = SHARE_PLACES.find((p) => p.id === placeId) ?? SHARE_PLACES[0];
  const link = useMemo(() => (place ? taggedLink(page, place, about) : null), [page, place, about]);

  function copy() {
    if (!link || !place) return;
    void navigator.clipboard.writeText(link.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      saveRecentLink({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        base_url: page.trim(),
        intent_target: about,
        source_target: place.source,
        generated_url: link.url,
        classified_intent: link.intent,
        classified_source: link.source,
        ts: Date.now(),
      });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-[520px] overflow-y-auto p-5 sm:p-6">
        <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">
          Make a tagged link
        </DialogTitle>
        <DialogDescription className="mt-1 text-[13px]">
          Its visits tell us where they came from and get a version.
        </DialogDescription>

        <label htmlFor="tl-page" className="mt-5 block text-xs font-medium text-fg-muted">
          Page
        </label>
        <Input
          id="tl-page"
          value={page}
          onChange={(e) => setPage(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="mt-1.5 font-mono text-[12.5px]"
        />

        <Chips
          label="Where you share it"
          options={SHARE_PLACES.map((p) => ({ value: p.id, label: p.label }))}
          value={placeId}
          onChange={setPlaceId}
        />
        <Chips
          label="What it is about"
          options={ABOUT.map((a) => ({ value: a.intent, label: a.label }))}
          value={about}
          onChange={(v) => setAbout(v as IntentDim)}
        />

        <div className="mt-5 rounded-sm border border-border bg-surface-muted px-3 py-2.5">
          {link ? (
            <p className="break-all font-mono text-xs leading-relaxed text-fg">{link.url}</p>
          ) : (
            <p className="text-xs text-fg-muted">Enter a page address, starting with https://</p>
          )}
        </div>
        {link && (
          <p className="mt-2 text-[12.5px] text-fg-muted">
            Its visits see the{" "}
            <span className="font-medium text-fg">{intentLabel(link.intent)}</span> version
            {link.source !== "direct" && <> for {sourceLabel(link.source).toLowerCase()}</>}.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={copy} disabled={!link}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Chips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-medium text-fg-muted">{label}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              className={cn(
                "h-7 rounded-sm border px-2.5 text-[12.5px] transition-colors duration-fast ease-smooth",
                on
                  ? "border-fg bg-fg text-bg"
                  : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
