"use client";

/**
 * Pieces the Turn on dialog, the New recovery codes dialog and the required
 * set-up page share (two-step mock §04, §05): the four-part step bar, the
 * QR code drawn in the browser, the key to type by hand, the recovery codes
 * with Copy and Download, and the error lines.
 */

import { Button } from "@/components/ui/Button";
import { CODES_FILE_NAME, codesFileText, keyLines } from "@/lib/mfa";
import { type QrModules, qrModules } from "@/lib/qr";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, Copy, Download } from "lucide-react";
import * as React from "react";

export const OK_TEXT = "text-[color:color-mix(in_srgb,var(--state-success)_70%,black)]";
export const OK_TINT = "bg-[color-mix(in_srgb,var(--state-success)_12%,transparent)]";
export const WARN_TEXT = "text-[color:color-mix(in_srgb,var(--state-warn)_62%,black)]";
export const ERR_TEXT = "text-[color:color-mix(in_srgb,var(--state-err)_85%,black)]";

export function StepBar({
  step,
  name,
  live = false,
  className,
}: {
  step: 1 | 2 | 3 | 4;
  /** "Scan": the page writes "Step 2 of 4 · Scan"; the dialog writes the number only. */
  name?: string;
  /** Read out on each change (the set-up page, mock §08). */
  live?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <i
            key={n}
            className={cn("block h-[3px] flex-1 rounded-[2px]", n <= step ? "bg-fg" : "bg-border")}
          />
        ))}
      </span>
      <span
        className="whitespace-nowrap font-mono text-[11px] text-fg-muted"
        aria-live={live ? "polite" : undefined}
      >
        Step {step} of 4{name ? ` · ${name}` : ""}
      </span>
    </div>
  );
}

/**
 * The QR code, drawn here from the otpauth URI (privacy review condition 7): no
 * QR service, no image URL, nothing leaves the browser. The box keeps its
 * size while the generator loads, so nothing moves.
 */
export function QrCode({ uri, preset }: { uri: string; preset?: QrModules }) {
  const [mods, setMods] = React.useState<QrModules | null>(preset ?? null);
  React.useEffect(() => {
    if (preset) return;
    let alive = true;
    qrModules(uri)
      .then((m) => {
        if (alive) setMods(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [uri, preset]);

  return (
    <div className="h-[168px] w-[168px] shrink-0 rounded-md border border-border bg-white p-2.5">
      {mods && (
        <svg
          viewBox={`-2 -2 ${mods.size + 4} ${mods.size + 4}`}
          className="block h-full w-full"
          shapeRendering="crispEdges"
          role="img"
          aria-label="QR code for your authenticator app"
        >
          <path d={mods.path} fill="#0a0a0a" />
        </svg>
      )}
    </div>
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback((text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  }, []);
  return [copied, copy];
}

export function KeyBlock({
  secret,
  lead,
  center = false,
}: {
  secret: string;
  lead: string;
  center?: boolean;
}) {
  const [copied, copy] = useCopied();
  const lines = keyLines(secret);
  return (
    <div className={cn("min-w-0", center && "text-center sm:text-left")}>
      <p className="text-[12.5px] text-fg-muted">{lead}</p>
      <p className="mt-1.5 select-all font-mono text-sm leading-[1.7] tracking-[0.04em] [word-spacing:0.25em] text-fg">
        {lines.map((l, i) => (
          <React.Fragment key={l}>
            {i > 0 && <br />}
            {l}
          </React.Fragment>
        ))}
      </p>
      <div
        className={cn("mt-2 flex items-center gap-2", center && "justify-center sm:justify-start")}
      >
        <Button type="button" variant="secondary" size="sm" onClick={() => copy(secret)}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy key"}
        </Button>
      </div>
    </div>
  );
}

export function CodesBlock({
  codes,
  email,
  madeAt,
  columns = "responsive",
}: {
  codes: string[];
  email: string;
  madeAt: number;
  /** The dialog drops to one column on a phone; the set-up page keeps two. */
  columns?: "responsive" | "two";
}) {
  const [copied, copy] = useCopied();
  function download() {
    const blob = new Blob([codesFileText(email, codes, madeAt)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = CODES_FILE_NAME;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <ul
        aria-label="Recovery codes"
        className={cn(
          "mt-3 grid list-none gap-x-5 gap-y-1.5 rounded-md border border-border bg-surface-muted px-4 py-3.5 font-mono tracking-[0.02em] tabular-nums text-fg",
          columns === "two"
            ? "grid-cols-2 gap-x-3 text-[12.5px] sm:gap-x-5 sm:text-[13px]"
            : "grid-cols-1 text-[13.5px] sm:grid-cols-2 sm:text-[13px]",
        )}
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => copy(codes.join("\n"))}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={download}>
          <Download size={14} />
          Download
        </Button>
      </div>
    </>
  );
}

export function SavedCheck({
  checked,
  onChange,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "mt-4 flex w-fit cursor-pointer items-center gap-2.5 text-[13.5px] text-fg",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer rounded-sm border border-border-strong accent-[var(--cta-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
      />
      I saved them
    </label>
  );
}

/** Under a dialog field, in the dashboard's error red (mock §04, E and F). */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className={cn("mt-1.5 flex items-center gap-1.5 text-xs", ERR_TEXT)}>
      <AlertCircle size={12} className="shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** A step's own error, under the fields (mock §04, G and H). */
export function BlockError({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "mt-3.5 flex items-start gap-1.5 text-[12.5px] leading-normal",
        ERR_TEXT,
        className,
      )}
    >
      <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** A green done line with a tick; focusable by script so focus can land on it. */
export const DoneLine = React.forwardRef<
  HTMLSpanElement,
  { children: React.ReactNode; className?: string }
>(({ children, className }, ref) => (
  <span
    ref={ref}
    tabIndex={-1}
    className={cn(
      "inline-flex items-center gap-1.5 text-[12.5px] focus:outline-none",
      OK_TEXT,
      className,
    )}
  >
    <Check size={14} className="shrink-0" aria-hidden />
    {children}
  </span>
));
DoneLine.displayName = "DoneLine";

/** The pill: Off, or On in green. */
export function StatePill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 py-[5px] text-xs leading-none",
        on ? cn("border-transparent", OK_TINT, OK_TEXT) : "border-border text-fg-muted",
      )}
    >
      <i
        aria-hidden
        className={cn(
          "block h-1.5 w-1.5 rounded-full border-[1.5px]",
          on
            ? "border-[color:color-mix(in_srgb,var(--state-success)_70%,black)] bg-[color:color-mix(in_srgb,var(--state-success)_70%,black)]"
            : "border-fg-faint",
        )}
      />
      {on ? "On" : "Off"}
    </span>
  );
}

/** The code field of the dialogs: mono, spaced, at most 200 px wide. */
export const dialogCodeInput = "h-10 max-w-[200px] font-mono text-lg tracking-[0.3em] tabular-nums";
