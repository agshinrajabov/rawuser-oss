"use client";

import { Button } from "@/components/ui/Button";
import { mintCountPick, pollCountPick } from "@/lib/measure";
import { cn } from "@/lib/utils";
import type { ConversionTarget } from "@/types/api";
import { Check, Copy, Loader2, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "Pick it on your page" with the count link (docs/specs/visual-picker.md
 * section 9): mints a one-time link, opens the customer's page with the
 * picker on "The button to count", and polls until Done lands. The landed
 * button is already the counted one; the manifests and the versions are
 * untouched. A 409 (a test runs) is shown as the API says it.
 */

const POLL_MS = 3000;
/** The link lives 15 minutes (section 9.1). */
const LINK_MS = 15 * 60 * 1000;

export const PICK_LABEL = "Pick it on your page";
export const WAITING_LINE = "Waiting for Done on your page.";
export const EXPIRED_LINE = "The link ran out. Pick again.";

interface CountPickProps {
  customerId: string;
  pagePath: string;
  onLanded: (target: ConversionTarget, items: ConversionTarget[]) => void;
  /** link: a quiet underlined link (the list's "Not here?"); button: a small secondary button. */
  variant: "link" | "button";
  className?: string;
}

type Phase =
  | { k: "idle" }
  | { k: "minting" }
  | { k: "waiting"; link: string; pagePath: string; since: number };

export function CountPick({ customerId, pagePath, onLanded, variant, className }: CountPickProps) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [said, setSaid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;

  async function start() {
    setSaid(null);
    setCopied(false);
    setPhase({ k: "minting" });
    const out = await mintCountPick(customerId, pagePath);
    if (out.kind !== "ok") {
      setSaid(out.kind === "refused" ? out.sentence : out.message);
      setPhase({ k: "idle" });
      return;
    }
    setPhase({ k: "waiting", link: out.link, pagePath: out.pagePath, since: Date.now() });
    window.open(out.link, "_blank", "noopener");
  }

  useEffect(() => {
    if (phase.k !== "waiting") return;
    let cancelled = false;
    const t = setInterval(() => {
      if (Date.now() - phase.since > LINK_MS) {
        setSaid(EXPIRED_LINE);
        setPhase({ k: "idle" });
        return;
      }
      void pollCountPick(customerId, phase.pagePath).then((out) => {
        if (cancelled) return;
        if (out.kind === "waiting") return;
        if (out.kind === "landed") {
          setPhase({ k: "idle" });
          landedRef.current(out.target, out.items);
          return;
        }
        setSaid(out.kind === "refused" ? out.sentence : out.message);
        setPhase({ k: "idle" });
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [phase, customerId]);

  const busy = phase.k === "minting";

  return (
    <span className={cn("inline-flex flex-col items-start gap-1.5", className)}>
      {phase.k === "waiting" ? (
        <span
          className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {WAITING_LINE}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-[3px] hover:text-fg"
            onClick={() => {
              navigator.clipboard
                .writeText(phase.link)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </span>
      ) : variant === "button" ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void start()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
          )}
          {PICK_LABEL}
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg disabled:opacity-60"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {PICK_LABEL}
        </button>
      )}
      {said && (
        <span
          aria-live="polite"
          className="block text-[12.5px] leading-normal text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]"
        >
          {said}
        </span>
      )}
    </span>
  );
}
