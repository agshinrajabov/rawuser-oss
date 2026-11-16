"use client";

import { TagCopy } from "@/components/onboard/TagCopy";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { WARN_WASH } from "@/components/start/tones";
import { Button } from "@/components/ui/Button";
import { CopyBlock } from "@/components/ui/CopyBlock";
import { apiFetch } from "@/lib/api";
import { OPERATOR_EMAIL } from "@/lib/identity";
import {
  HIDE_STYLE_HASH,
  NONCE_PLACEHOLDER,
  type TagCondition,
  conditionLines,
  conditionWhere,
  isHashLine,
  isTagLine,
  keepsChecking,
  linesLabel,
  lovableSwapMessage,
  policyNotes,
  tagCondition,
  tagIsOn,
} from "@/lib/install";
import { EDGE_MARK, buildSnippet } from "@/lib/snippet-tag";
import { cn } from "@/lib/utils";
import type { CustomerListItem, InstallFacts, ProbeResponse } from "@/types/api";
import { Ban, Check, Clock, Loader2, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Codey } from "./Codey";

/**
 * Is the tag on their page right now, and can it run. Asks the generation
 * worker to fetch the page being connected and read our script, the site's
 * security policy and where the tag sits
 * (packages/generation/src/admin/snippet-status.ts). One line says the
 * state; a box under it says what happens to visitors today, the exact
 * change and where to make it (install-friction mock, section 2). While the
 * line can still turn green by itself (a deploy, a capture) the check
 * repeats every ten seconds for five minutes.
 *
 * Shared by the Connect screen (/start) and /onboard.
 */

const POLL_MS = 10_000;
const MAX_POLLS = 30;

/** Red when the tag cannot work at all, amber when it works with a cost. */
const BOX = {
  err: "border border-[color-mix(in_srgb,var(--state-err)_30%,transparent)] bg-[color-mix(in_srgb,var(--state-err)_4%,transparent)]",
  warn: cn("border border-[color-mix(in_srgb,var(--state-warn)_40%,transparent)]", WARN_WASH),
} as const;

const ICON_TONE = {
  ok: "text-state-success",
  warn: "text-state-warn",
  err: "text-state-err",
} as const;

function ConditionIcon({ c }: { c: TagCondition }) {
  const cls = cn("h-4 w-4 shrink-0 mt-[1px]", ICON_TONE[c.tone]);
  switch (c.kind) {
    case "found":
    case "runs":
      return <Check className={cls} aria-hidden />;
    case "blocked":
    case "hash_only":
    case "needs_nonce":
      return <Ban className={cls} aria-hidden />;
    case "late":
      return <Clock className={cls} aria-hidden />;
    case "report_only":
    case "degrades":
    case "bot_protection":
      return <ShieldAlert className={cls} aria-hidden />;
    default:
      return <TriangleAlert className={cls} aria-hidden />;
  }
}

interface TagStatusProps {
  customer: CustomerListItem;
  /** The page being connected; the probe reads that page (spec G4). */
  pagePath?: string;
  /** Called the first time the tag is on the page and can run. */
  onFound?: () => void;
  /** Every probe answer, for the platform line and the 45-second line. */
  onProbe?: (r: ProbeResponse | null) => void;
}

export function TagStatus({ customer, pagePath = "/", onFound, onProbe }: TagStatusProps) {
  const { refresh: refreshCustomers } = useCustomerList();
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [polls, setPolls] = useState(0);
  const foundRef = useRef(false);
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;

  const domain = customer.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  const check = useCallback(async () => {
    try {
      const r = await apiFetch<ProbeResponse>("/admin/snippet-status/probe", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id, page_path: pagePath }),
      });
      setProbe(r);
      setFailed(false);
      setCheckedAt(r.probed_at);
      onProbeRef.current?.(r);
      const on = tagIsOn(tagCondition(r, domain));
      if (on && !foundRef.current) {
        foundRef.current = true;
        refreshCustomers();
        onFoundRef.current?.();
      }
      if (!on) foundRef.current = false;
    } catch {
      setFailed(true);
      setCheckedAt(Date.now());
      onProbeRef.current?.(null);
    } finally {
      setChecking(false);
    }
  }, [customer.id, pagePath, domain, refreshCustomers]);

  // First check on mount, then every ten seconds while the line can change.
  useEffect(() => {
    setChecking(true);
    void check();
  }, [check]);

  const condition: TagCondition | null = failed
    ? {
        kind: "unreachable",
        tone: "warn",
        line: `Could not check ${domain}.`,
        meta: "Rawuser did not answer.",
      }
    : probe
      ? tagCondition(probe, domain)
      : null;
  const polling = condition !== null && keepsChecking(condition);

  useEffect(() => {
    if (checking || !polling || polls >= MAX_POLLS) return;
    const t = setTimeout(() => {
      setPolls((n) => n + 1);
      void check();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [checking, polling, polls, check]);

  const paused = polling && polls >= MAX_POLLS;
  const tag = buildSnippet(customer.id);
  const install = probe?.install ?? null;

  function again() {
    setPolls(0);
    setChecking(true);
    void check();
  }

  if (checking && !condition) {
    return (
      <div className="flex items-center gap-2 text-sm min-h-6 mt-2" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-muted" />
        <span className="text-fg-muted">Checking {domain}…</span>
      </div>
    );
  }
  if (!condition) return null;

  return (
    <TagStatusView
      condition={condition}
      install={install}
      tag={tag}
      meta={conditionMeta(condition, paused, checkedAt)}
      showAgain={
        paused ||
        condition.kind === "unreachable" ||
        condition.kind === "off_host" ||
        condition.kind === "other_customer"
      }
      onAgain={again}
    />
  );
}

/** The small grey words after the line. */
export function conditionMeta(
  condition: TagCondition,
  paused: boolean,
  checkedAt: number | null,
): string | null {
  switch (condition.kind) {
    case "unreachable":
    case "off_host":
    case "runs":
      return condition.meta;
    case "missing":
      return paused ? "Paused." : "Checking again in 10 seconds.";
    case "bot_protection":
      return null;
    default:
      return checkedAt === null ? null : `checked ${ago(checkedAt)}`;
  }
}

interface TagStatusViewProps {
  condition: TagCondition;
  install: InstallFacts | null;
  tag: string;
  meta: string | null;
  showAgain: boolean;
  onAgain?: () => void;
}

/** One line for the state, the box with the fix under it, the policy's caveats last. */
export function TagStatusView({
  condition,
  install,
  tag,
  meta,
  showAgain,
  onAgain,
}: TagStatusViewProps) {
  const notes = policyNotes(install?.csp);
  return (
    <div className="mt-2">
      <div className="flex items-start gap-2 text-sm min-h-6 flex-wrap" aria-live="polite">
        <ConditionIcon c={condition} />
        <span className="text-fg flex-1 min-w-0 sm:flex-none">{condition.line}</span>
        {meta && <span className="text-xs text-fg-faint mt-[2px]">{meta}</span>}
        {showAgain && (
          <Button type="button" size="sm" variant="ghost" onClick={onAgain} className="-my-1">
            <RefreshCw className="h-3.5 w-3.5" />
            Check again
          </Button>
        )}
      </div>
      {condition.kind === "bot_protection" && (
        <p className="mt-1.5 text-[12.5px] text-fg-muted max-w-[60ch]">{condition.note}</p>
      )}
      <ConditionBox condition={condition} install={install} tag={tag} />
      {notes.length > 0 && (
        <details className="mt-2.5 text-[12.5px] text-fg-muted max-w-[68ch]">
          <summary className="cursor-pointer list-none inline underline decoration-dotted underline-offset-[3px] hover:text-fg">
            More on your policy, nothing to add
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The box under the line: what visitors get today, the change, where to make it. */
export function ConditionBox({
  condition,
  install,
  tag,
}: {
  condition: TagCondition;
  install: InstallFacts | null;
  tag: string;
}) {
  const c = condition;
  if (
    c.kind === "found" ||
    c.kind === "runs" ||
    c.kind === "missing" ||
    c.kind === "unreachable" ||
    c.kind === "off_host" ||
    c.kind === "bot_protection" ||
    c.kind === "other_customer"
  ) {
    return null;
  }
  const csp = install?.csp ?? null;
  const lines = conditionLines(c, csp, tag);
  const tone = c.tone === "err" ? BOX.err : BOX.warn;
  const tagLines = lines.filter(isTagLine).length;

  return (
    <div className={cn("mt-2.5 rounded-md px-3.5 py-3 text-[13px] leading-relaxed", tone)}>
      <p className="text-fg">
        <Codey text={c.body} />
      </p>

      {c.kind === "hash_only" && OPERATOR_EMAIL && (
        <p className="mt-2 text-[12.5px]">
          <a
            href={`mailto:${OPERATOR_EMAIL}`}
            className="text-fg underline decoration-dotted underline-offset-[3px]"
          >
            {OPERATOR_EMAIL}
          </a>
        </p>
      )}

      {lines.length > 0 && (
        <>
          <p className="mt-2 text-[12.5px] text-fg-muted">
            <Codey text={conditionWhere(c, install, lines.length)} />
          </p>
          <div className="mt-2.5">
            <CopyBlock
              label={
                tagLines === 0
                  ? linesLabel(lines.length)
                  : lines.length === 1
                    ? "Tag with your nonce"
                    : "Tag with your nonce, and the policy line"
              }
              content={lines.join("\n")}
              multiline
              highlight={[EDGE_MARK, HIDE_STYLE_HASH, `nonce="${NONCE_PLACEHOLDER}"`]}
            />
          </div>
          {c.kind === "report_only" && lines.some(isHashLine) && (
            <p className="mt-2 text-[12.5px] text-fg-muted">
              The hash line lets Rawuser hide what it rewrites, so nothing flashes.
            </p>
          )}
          {(c.kind === "blocked" || c.kind === "needs_nonce") && (
            <p className="mt-2.5 text-[12.5px] text-fg-muted">
              This turns green within 10 seconds of your deploy.
            </p>
          )}
          {csp?.where === "next_config" && (
            <details className="mt-2 text-[12.5px] text-fg-muted">
              <summary className="cursor-pointer list-none inline text-fg underline decoration-dotted underline-offset-[3px]">
                Not in next.config.js?
              </summary>
              <p className="mt-1.5">
                <Codey text="Then in `middleware.ts`, or wherever your host or proxy adds it." />
              </p>
            </details>
          )}
        </>
      )}

      {c.kind === "late" && <LateFix cause={c.cause} install={install} tag={tag} />}
    </div>
  );
}

function LateFix({
  cause,
  install,
  tag,
}: {
  cause: Extract<TagCondition, { kind: "late" }>["cause"];
  install: InstallFacts | null;
  tag: string;
}) {
  if (cause === "body_late" || cause === "blocking_script_before") return null;
  if (cause === "older" && install?.platform === "lovable") {
    return (
      <div className="mt-2.5">
        <CopyBlock label="Message for Lovable" content={lovableSwapMessage(tag)} multiline />
      </div>
    );
  }
  if (cause === "rocket_loader") {
    return (
      <div className="mt-2.5">
        <TagCopy label="Tag" content={tag} highlight={['data-cfasync="false"']} />
      </div>
    );
  }
  return (
    <div className="mt-2.5">
      <TagCopy label="Tag, first line inside <head>" content={tag} />
    </div>
  );
}

function ago(ts: number | null): string {
  if (ts === null) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}
