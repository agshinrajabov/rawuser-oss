"use client";

import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import type { Manifest, PickStatusResponse, PickTokenResponse } from "@/types/api";
import { Check, Copy, Loader2, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "Fix on the page" (docs/specs/visual-picker.md). Mints a one-time link,
 * shows it, polls until the picker on the operator's own page posts a
 * manifest, then hands it to the parent. The generation worker stores it
 * unconfirmed for the path; the parent decides when it is confirmed.
 */
interface PickOnPageProps {
  customerId: string;
  pagePath: string;
  onPicked: (manifest: Manifest) => void;
}

type Phase = "idle" | "minting" | "waiting" | "landed";

export function PickOnPage({ customerId, pagePath, onPicked }: PickOnPageProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;

  async function start() {
    setError(null);
    setPhase("minting");
    try {
      const r = await apiFetch<PickTokenResponse>("/admin/onboard/pick-token", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, page_path: pagePath }),
      });
      setLink(r.link);
      setPhase("waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link.");
      setPhase("idle");
    }
  }

  useEffect(() => {
    if (phase !== "waiting") return;
    let cancelled = false;
    const t = setInterval(() => {
      apiFetch<PickStatusResponse>(
        `/admin/onboard/pick-status?customer_id=${encodeURIComponent(customerId)}&page_path=${encodeURIComponent(pagePath)}`,
      )
        .then((r) => {
          if (cancelled || !r.landed || !r.manifest) return;
          setPhase("landed");
          onPickedRef.current(r.manifest);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [phase, customerId, pagePath]);

  if (phase === "landed") {
    return (
      <p className="text-sm text-state-success flex items-center gap-1.5">
        <Check className="h-4 w-4" />
        Elements updated from the page.
        <button
          type="button"
          className="text-xs text-fg-muted underline decoration-dotted ml-2"
          onClick={() => {
            setLink(null);
            setPhase("idle");
          }}
        >
          Pick again
        </button>
      </p>
    );
  }

  if (phase === "waiting" && link) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-fg">
          Open this link in a private window. Your page opens with a small panel: press Pick next to
          an element, click it on the page, then Done.
        </p>
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono bg-surface-muted border border-border rounded-md px-2 py-1.5 truncate flex-1 min-w-0">
            {link}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              navigator.clipboard
                .writeText(link)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-fg-faint flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for Done on the page… link lasts 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="ghost" onClick={start} disabled={phase === "minting"}>
        {phase === "minting" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <MousePointerClick className="h-4 w-4" />
        )}
        Fix on the page
      </Button>
      {error && <p className="text-state-err text-sm">{error}</p>}
    </div>
  );
}
