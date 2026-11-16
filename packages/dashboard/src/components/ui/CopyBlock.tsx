"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface CopyBlockProps {
  label: string;
  content: string;
  multiline?: boolean;
  /**
   * Substrings to mark as added (a green tint), such as our origin at the end
   * of a policy line. The copied text is the content as it is.
   */
  highlight?: string[];
  /** A short note beside Copy, such as the text's length. */
  meta?: string;
  /** Show three lines with a fade; Copy still takes all of it. */
  clamp?: boolean;
}

/** Content split into plain runs and the runs to mark, first match wins. */
function marked(content: string, highlight: string[]): { add: boolean; text: string }[] {
  const needles = highlight.filter((h) => h.length > 0);
  if (needles.length === 0) return [{ add: false, text: content }];
  const out: { add: boolean; text: string }[] = [];
  let rest = content;
  while (rest.length > 0) {
    let at = -1;
    let hit = "";
    for (const n of needles) {
      const i = rest.indexOf(n);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = n;
      }
    }
    if (at < 0) {
      out.push({ add: false, text: rest });
      break;
    }
    if (at > 0) out.push({ add: false, text: rest.slice(0, at) });
    out.push({ add: true, text: hit });
    rest = rest.slice(at + hit.length);
  }
  return out;
}

export function CopyBlock({ label, content, multiline, highlight, meta, clamp }: CopyBlockProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore: older browsers and non-secure contexts cannot write to the clipboard
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-fg-muted font-medium uppercase tracking-wide">{label}</span>
        {meta && (
          <span className="ml-auto mr-1 font-mono text-[11px] text-fg-faint tabular-nums">
            {meta}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={handleCopy} aria-label={`Copy ${label}`}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* On a phone a line wraps inside its block: the customer needs to see
          it whole before copying it (install-friction mock, section 4). */}
      <div className={clamp ? "relative" : undefined}>
        <pre
          data-clamp={clamp ? "" : undefined}
          className={cn(
            "text-xs font-mono text-fg bg-surface-muted border border-border rounded-md p-3 overflow-x-auto leading-relaxed",
            clamp &&
              "max-h-[calc(3*1.625em+24px)] overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere]",
            clamp
              ? null
              : multiline
                ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
                : "whitespace-pre-wrap [overflow-wrap:anywhere] sm:whitespace-pre sm:[overflow-wrap:normal]",
          )}
        >
          {highlight
            ? marked(content, highlight).map((part, i) =>
                part.add ? (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: runs of one fixed string
                    key={i}
                    className="rounded-[2px] px-0.5 bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]"
                  >
                    {part.text}
                  </span>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: runs of one fixed string
                  <span key={i}>{part.text}</span>
                ),
              )
            : content}
        </pre>
        {clamp && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-px bottom-px h-7 rounded-b-md bg-gradient-to-b from-transparent to-surface-muted"
          />
        )}
      </div>
    </div>
  );
}
