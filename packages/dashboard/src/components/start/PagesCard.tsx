"use client";

import { PickOnPage } from "@/components/onboard/PickOnPage";
import { TagCopy } from "@/components/onboard/TagCopy";
import { ConditionBox } from "@/components/onboard/TagStatus";
import { Button } from "@/components/ui/Button";
import { Marked } from "@/components/ui/Marked";
import { apiFetch } from "@/lib/api";
import { auditRefusal } from "@/lib/audit";
import { type TagCondition, tagCondition } from "@/lib/install";
import { groupRows } from "@/lib/page-groups";
import { errorSentence } from "@/lib/readiness";
import type { PendingLine } from "@/lib/site-map";
import { buildSnippet } from "@/lib/snippet-tag";
import { uncoveredLine } from "@/lib/uncovered";
import { cn } from "@/lib/utils";
import type {
  CaptureStatusResponse,
  CaptureTokenResponse,
  CustomerListItem,
  GoLiveResponse,
  Manifest,
  ManifestResponse,
  PagesBreakdown,
  PrePasteResponse,
  ProbeResponse,
  QuickstartResponse,
} from "@/types/api";
import { siteOrigin } from "@rawuser/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageButtons } from "./Buttons";
import { PageGroupRows, type PageGroupsData } from "./PageGroups";
import { ReReadLine } from "./SiteMap";
import { PreStaleNote, TwoPartTag } from "./TwoPartTag";
import {
  type HealthIssuesResponse,
  type LateTagLine,
  healthByPath,
  healthFor,
  healthLines,
  lateTagLine,
  partName,
  siteLine,
} from "./health";
import { TOTAL_TUPLES } from "./steps";
import { TINT } from "./tones";

/**
 * The Pages card on the Live screen (docs/specs/first-run.md §6). One row
 * per connected page with its version count, and "Add this page", which
 * runs the same three steps the homepage went through, scoped to that
 * path and folded into the card: open it once, one look, go live. The
 * versions are then written by the Live screen's own loop.
 */

export interface PageRow {
  path: string;
  ready: number;
  confirmed: boolean;
}

interface PagesCardProps {
  customer: CustomerListItem;
  pages: ManifestResponse[];
  /** Ready versions per page path, from the variants list. */
  readyByPath: Record<string, number>;
  writing: boolean;
  /** A page went live: the parent reloads pages and writes its versions. */
  onPageAdded: () => void;
  /**
   * A button's switch marked a page's versions to be written again
   * (docs/specs/button-rewrite.md): the parent reloads and writes them.
   */
  onVersionsStale?: () => void;
  /** The last day's problems per page; null while loading, on a 403 or on any error. */
  health?: HealthIssuesResponse | null;
  /** Versions a page gets: 36, 30 or 24 (the site map's served intents). */
  perPage?: number;
  /**
   * The last 7 days' visits per page (the breakdown's `pages`), for the one
   * line about pages without versions; null without the read.
   */
  visited?: PagesBreakdown | null;
  /**
   * A free audit at its three page and language pairs (spec §9): the add
   * field gives way to one line, "Three pages in the audit. A pilot has more."
   */
  auditFull?: boolean;
  /** A re-read found a new page (site-shaped intents §8.4): its line, Write and Change. */
  reread?: {
    line: PendingLine;
    onWrite: () => void;
    onChange: () => void;
    busy?: boolean;
    error?: string | null;
  } | null;
  /**
   * Page groups (docs/specs/page-groups.md): the proposed and accepted
   * groups under the confirmed pages. Null, or an answer without rows,
   * leaves the card as it was.
   */
  groups?: { data: PageGroupsData; superadmin: boolean } | null;
  /**
   * The tag withheld (readiness-check.md, the privacy review's condition 2): no
   * tag on this door either, so the late-tag note and the fix lines that
   * carry it stay out, and the capture link's 409 is shown as written.
   */
  tagWithheld?: boolean;
  /**
   * The two-part tag (docs/specs/faster-tag.md step 6; mock two-part-tag.html):
   * the GET's answer and a setter for a check's. Null, or an answer that is
   * not available, shows nothing.
   */
  pre?: { answer: PrePasteResponse | null; onAnswer: (a: PrePasteResponse) => void } | null;
}

type AddState =
  | { kind: "idle" }
  | { kind: "waiting"; path: string; token: CaptureTokenResponse }
  | { kind: "reading"; path: string }
  | { kind: "look"; path: string; result: QuickstartResponse; manifest: Manifest }
  | { kind: "going-live"; path: string };

function normalizePathInput(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "") || "/";
  return p.toLowerCase();
}

function keepsLine(manifest: Manifest): string {
  const entries = Object.values(manifest);
  const bits: string[] = [];
  if (entries.some((e) => (e.inline?.emphasis ?? 0) >= 1)) bits.push("the emphasised phrase");
  if (entries.some((e) => e.inline && e.inline.icons !== "none")) bits.push("the icon");
  if (bits.length === 0) return "Plain text, nothing to keep.";
  return `Keeps ${bits.join(" and ")}.`;
}

/** The audit's page cap, as the API words its refusal (spec §17.4). */
export const AUDIT_PAGES_LINE = "Three pages in the audit. A pilot has more.";

/** The light tint and the text for a line under a page (AA on the tint, see tones.ts). */
const LINE_TONE = { warn: TINT.warn, err: TINT.err } as const;

export function PagesCard({
  customer,
  pages,
  readyByPath,
  writing,
  onPageAdded,
  onVersionsStale,
  health = null,
  perPage = TOTAL_TUPLES,
  visited = null,
  reread = null,
  auditFull = false,
  groups = null,
  tagWithheld = false,
  pre = null,
}: PagesCardProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const domain = customer.domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const known = new Set(pages.map((p) => p.page_path));
  const healthPages = healthByPath(health);
  const policyLine = tagWithheld ? null : siteLine(health?.site);
  // The late tag (mock pilot-gaps, screen 06). The count is the site's, so
  // it sits under the page when there is one, else once under the intro.
  // Where it shows, it replaces the per-page late-tag line: the same fact.
  const late = tagWithheld ? null : lateTagLine(health);
  const lateUnder = late && pages.length === 1 ? (pages[0]?.page_path ?? null) : null;
  const lateNote = late ? <LateTagNote line={late} tag={buildSnippet(customer.id)} /> : null;

  async function runChain(path: string, allowFetch: boolean) {
    setState({ kind: "reading", path });
    setError(null);
    try {
      const r = await apiFetch<QuickstartResponse>("/admin/onboard/quickstart", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customer.id,
          page_path: path,
          allow_fetch: allowFetch,
        }),
      });
      if (!mountedRef.current) return;
      setState({ kind: "look", path, result: r, manifest: r.manifest });
    } catch (e) {
      if (!mountedRef.current) return;
      setError(
        auditRefusal(e)?.message ??
          (e instanceof Error ? e.message : "Reading the page failed. Try again."),
      );
      setState({ kind: "idle" });
    }
  }

  async function openPage(path: string) {
    setError(null);
    try {
      const token = await apiFetch<CaptureTokenResponse>("/admin/onboard/capture-token", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customer.id,
          source_url: `${siteOrigin(domain)}${path}`,
        }),
      });
      setState({ kind: "waiting", path, token });
      window.open(
        `${siteOrigin(domain)}${path}#rawuser_capture=${encodeURIComponent(token.token)}`,
        "_blank",
        "noopener",
      );
    } catch (e) {
      // A 409 while the tag is withheld: the API's sentence as written.
      setError(
        errorSentence(e) ??
          (e instanceof Error ? e.message : "Could not open the page. Try again."),
      );
    }
  }

  // While the page is open, notice the capture landing, then read it once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runChain reads refs and setters only
  useEffect(() => {
    if (state.kind !== "waiting") return;
    const { path, token } = state;
    let cancelled = false;
    const interval = setInterval(() => {
      apiFetch<CaptureStatusResponse>(
        `/admin/onboard/capture-status?customer_id=${encodeURIComponent(customer.id)}&page_path=${encodeURIComponent(token.page_path)}`,
      )
        .then((data) => {
          if (cancelled || !data.captured) return;
          cancelled = true;
          clearInterval(interval);
          void runChain(path, false);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state, customer.id]);

  async function goLive(path: string, result: QuickstartResponse, manifest: Manifest) {
    setState({ kind: "going-live", path });
    setError(null);
    try {
      await apiFetch<GoLiveResponse>("/admin/onboard/go-live", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customer.id,
          page_path: path,
          dna: result.brief,
          manifest,
        }),
      });
      if (!mountedRef.current) return;
      setState({ kind: "idle" });
      setInput("");
      onPageAdded();
    } catch (e) {
      if (!mountedRef.current) return;
      const cap = auditRefusal(e);
      setError(cap?.message ?? (e instanceof Error ? e.message : "Going live failed. Try again."));
      setState(cap ? { kind: "idle" } : { kind: "look", path, result, manifest });
    }
  }

  function submit() {
    const path = normalizePathInput(input);
    if (!path) return setError("Type the page's path, like /pricing.");
    if (path === "/" || known.has(path)) return setError(`${path} is already connected.`);
    void openPage(path);
  }

  const pendingPath = state.kind === "idle" ? null : state.path;
  // The group rows say "190 visits, no versions" per group (mock A1), so the
  // one summary line about pages without versions gives way to them.
  const hasGroupRows = groups !== null && groupRows(groups.data.answer).length > 0;

  return (
    <div className="rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold text-fg mb-1">Pages</h2>
      <p className="text-[13px] text-fg-muted mb-2">
        Rawuser writes versions for each page you connect.{" "}
        {pages.length === 1 ? "One so far." : `${pages.length} so far.`}
      </p>
      {policyLine && (
        <TagFixLine
          customer={customer}
          pagePath="/"
          text={policyLine}
          kind="policy"
          className="mt-0.5 mb-2.5"
        />
      )}
      {lateNote && lateUnder === null && <div className="mb-2.5 mt-0.5 text-xs">{lateNote}</div>}
      {pre?.answer && !tagWithheld && (
        <PreStaleNote customerId={customer.id} answer={pre.answer} onAnswer={pre.onAnswer} />
      )}
      <ul className="border-t border-border">
        {pages.map((p) => {
          const ready = readyByPath[p.page_path] ?? 0;
          const label = p.page_path === "/" ? "/  homepage" : p.page_path;
          const missing = p.missing_parts ?? [];
          const lines = healthLines(
            healthFor(healthPages, p.page_path),
            health?.hours,
            late ? ["late_tag"] : [],
          );
          const lateHere = lateNote !== null && lateUnder === p.page_path;
          const st = !p.confirmed_at
            ? { text: "not confirmed", tone: "warn" }
            : ready >= perPage
              ? { text: "live", tone: "ok" }
              : writing || ready > 0
                ? { text: "live from the first version", tone: "muted" }
                : { text: "waiting", tone: "muted" };
          return (
            <li
              key={p.page_path}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 items-center py-2 border-b border-border text-[13px]"
            >
              <span className="font-mono text-fg truncate">{label}</span>
              <span className="text-fg-muted tabular-nums">
                {ready >= perPage
                  ? `${perPage} of ${perPage}`
                  : ready > 0
                    ? // "writing" only while a write runs: a version that waits
                      // is said on the versions card, not as work in progress.
                      `${writing ? "writing, " : ""}${ready} of ${perPage}`
                    : "not written yet"}
              </span>
              <span
                className={cn(
                  "text-[11px] px-2 py-0.5 rounded-full",
                  st.tone === "ok" && TINT.ok,
                  st.tone === "warn" && TINT.warn,
                  st.tone === "muted" && "border border-border text-fg-muted",
                )}
              >
                {st.text}
              </span>
              {(missing.length > 0 || lines.length > 0 || lateHere) && (
                <div className="col-span-3 -mt-1 pb-1 flex flex-col gap-1 text-xs">
                  {lateHere && lateNote}
                  {missing.length > 0 && (
                    <p className={cn("rounded-sm px-2 py-1", LINE_TONE.warn)}>
                      {missing.length === 1
                        ? "One part of this page is no longer where Rawuser read it"
                        : `${missing.length} parts of this page are no longer where Rawuser read them`}{" "}
                      ({missing.map(partName).join(", ")}); that section shows the original until
                      you{" "}
                      <a
                        className="underline decoration-dotted underline-offset-[3px]"
                        href={`/onboard/?customer_id=${encodeURIComponent(customer.id)}`}
                      >
                        fix it on the page
                      </a>
                      .
                    </p>
                  )}
                  {lines.map((line) =>
                    line.link === "tag" ? (
                      <TagFixLine
                        key={line.text}
                        customer={customer}
                        pagePath={p.page_path}
                        text={line.text}
                        kind="late"
                      />
                    ) : (
                      <p
                        key={line.text}
                        className={cn("rounded-sm px-2 py-1", LINE_TONE[line.tone])}
                      >
                        {line.text}
                        {line.link === "part" && (
                          <>
                            {" "}
                            <a
                              className="underline decoration-dotted underline-offset-[3px] whitespace-nowrap"
                              href={`/onboard/?customer_id=${encodeURIComponent(customer.id)}`}
                            >
                              See the part
                            </a>
                          </>
                        )}
                        {line.link === "page" && (
                          <>
                            {" "}
                            <a
                              className="underline decoration-dotted underline-offset-[3px] whitespace-nowrap"
                              href={`${siteOrigin(domain)}${p.page_path}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              See the page
                            </a>
                          </>
                        )}
                      </p>
                    ),
                  )}
                </div>
              )}
              {/* The page's buttons, off unless turned on (mock pilot-gaps, screen 04). */}
              {(p.buttons?.length ?? 0) > 0 && (
                <div className="col-span-3 -mt-1 pb-1 text-xs">
                  <PageButtons
                    customerId={customer.id}
                    pagePath={p.page_path}
                    buttons={p.buttons}
                    onStale={onVersionsStale}
                  />
                </div>
              )}
            </li>
          );
        })}
        {pendingPath && !known.has(pendingPath) && (
          <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 items-center py-2 border-b border-border text-[13px]">
            <span className="font-mono text-fg truncate">{pendingPath}</span>
            <span className="text-fg-muted">
              {state.kind === "look"
                ? `read, ${Object.keys(state.manifest).length} parts`
                : state.kind === "reading"
                  ? "reading…"
                  : "not read yet"}
            </span>
            <span className={cn("text-[11px] px-2 py-0.5 rounded-full", TINT.warn)}>
              {state.kind === "look" ? "check and go live" : "waiting for you"}
            </span>
          </li>
        )}
      </ul>

      {groups && (
        <PageGroupRows
          customerId={customer.id}
          data={groups.data}
          visited={visited}
          superadmin={groups.superadmin}
        />
      )}

      {reread && <ReReadLine {...reread} />}

      {!hasGroupRows && <UncoveredLine pages={visited} />}

      {pre?.answer && !tagWithheld && (
        <TwoPartTag customerId={customer.id} answer={pre.answer} onAnswer={pre.onAnswer} />
      )}

      {state.kind === "idle" && auditFull && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-fg-muted">
          <span
            aria-hidden
            className="inline-block h-2 w-2 flex-none rounded-full border-[1.5px] border-fg-muted"
          />
          {AUDIT_PAGES_LINE}
        </p>
      )}

      {state.kind === "idle" && !auditFull && (
        <>
          <div className="mt-3 flex gap-2 items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="/pricing"
              aria-label="Page path"
              className="flex-1 min-w-0 font-mono text-[13px] px-2.5 py-1.5 rounded-sm border border-border-strong bg-surface text-fg"
            />
            <Button type="button" size="sm" onClick={submit}>
              Add this page
            </Button>
          </div>
          <p className="text-xs text-fg-muted mt-2">
            A page whose layout differs from the homepage needs its own read: pricing, a campaign
            landing, a product page. Same-language pages use the brief you already wrote.
          </p>
        </>
      )}

      {state.kind === "waiting" && (
        <div className="mt-3 rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px]">
          <p className="font-medium text-fg mb-1">Open {state.path} once</p>
          <p className="text-fg-muted mb-2">
            Rawuser reads it the way a visitor sees it. Use a private window so nothing from your
            login rides along. This card notices when it lands.
          </p>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={() => openPage(state.path)}>
              Open {state.path} with Rawuser
            </Button>
            <button
              type="button"
              className="text-xs text-fg underline decoration-dotted underline-offset-[3px]"
              onClick={() => void runChain(state.path, true)}
            >
              Read it from its address instead
            </button>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-fg-faint" />
          </div>
        </div>
      )}

      {(state.kind === "reading" || state.kind === "going-live") && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-fg-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {state.kind === "reading" ? `Reading ${state.path}…` : `Going live with ${state.path}…`}
        </p>
      )}

      {state.kind === "look" && (
        <div className="mt-3 rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px]">
          <p className="font-medium text-fg mb-2">Here is {state.path}, and one version of it</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <div className="rounded-md border border-border bg-surface p-3">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-faint mb-1.5">
                Your page now
              </p>
              <p className="font-semibold text-fg leading-snug">
                {state.result.current.headline ? (
                  <Marked text={state.result.current.headline} />
                ) : (
                  <span className="text-fg-faint">no headline found</span>
                )}
              </p>
              {state.result.current.cta && (
                <p className="text-xs text-fg-muted mt-1">
                  <Marked text={state.result.current.cta} />
                </p>
              )}
            </div>
            <div className="rounded-md border border-state-success bg-surface p-3">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-faint mb-1.5">
                For a visitor comparing options
              </p>
              <p className="font-semibold text-fg leading-snug">
                {state.result.preview?.headline ? (
                  <Marked text={state.result.preview.headline} />
                ) : (
                  <span className="text-fg-faint">
                    {state.result.preview_error ?? "not written yet"}
                  </span>
                )}
              </p>
              {state.result.preview?.cta && (
                <p className="text-xs text-fg-muted mt-1">
                  <Marked text={state.result.preview.cta} />
                </p>
              )}
            </div>
          </div>
          <p className="text-fg-muted mb-1">
            <span className="text-fg font-medium">
              {Object.keys(state.manifest).length} parts found
            </span>
            {state.result.uncertain_paths.length === 0
              ? ", every one matched exactly once. "
              : `, ${state.result.uncertain_paths.length} we are not sure about. `}
            {keepsLine(state.manifest)} Written in {state.result.language.toUpperCase()}, same brief
            as the homepage.
          </p>
          {state.result.uncertain_paths.length > 0 && (
            <div className="mb-2">
              <PickOnPage
                customerId={customer.id}
                pagePath={state.path}
                onPicked={(picked) =>
                  setState({
                    kind: "look",
                    path: state.path,
                    result: state.result,
                    manifest: picked,
                  })
                }
              />
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <Button
              type="button"
              size="sm"
              onClick={() => goLive(state.path, state.result, state.manifest)}
            >
              Go live with {state.path}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setState({ kind: "idle" })}
            >
              Not this page
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-state-err">{error}</p>}
    </div>
  );
}

/**
 * Pages without versions (mock pilot-gaps, screen 07): the count line only.
 * No button: covering pages like these has no spec yet.
 */
export function UncoveredLine({ pages }: { pages: PagesBreakdown | null | undefined }) {
  const line = uncoveredLine(pages);
  if (!line) return null;
  return (
    <p
      className="mt-2.5 rounded-sm border border-border bg-surface px-2.5 py-2 text-[13px] text-fg"
      data-line="uncovered"
    >
      {line.text} <span className="whitespace-nowrap text-xs text-fg-faint">{line.period}</span>
    </p>
  );
}

/**
 * The tag at the bottom of the page (mock pilot-gaps, screen 06): how often
 * the page appeared first, then two choices of equal weight behind "What you
 * can do". Move the tag, or leave it: a page that was painted first stays as
 * built for that load (docs/specs/late-tag.md).
 */
export function LateTagNote({
  line,
  tag,
  defaultOpen = false,
}: {
  line: LateTagLine;
  /** The customer's tag, to copy. */
  tag: string;
  /** For the tests: open on arrival. */
  defaultOpen?: boolean;
}) {
  const warn = line.tone === "warn";
  return (
    <details className="group" open={defaultOpen} data-line="late-tag">
      <summary
        className={cn(
          "block cursor-pointer list-none rounded-sm px-2 py-1 leading-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden",
          warn ? TINT.warn : "bg-surface-muted text-fg-muted",
        )}
      >
        {line.text}{" "}
        <span className="whitespace-nowrap underline decoration-dotted underline-offset-[3px]">
          <span className="group-open:hidden">What you can do</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <div
        className={cn(
          "mt-1.5 rounded-md border px-3.5 py-3 text-[13px] leading-normal text-fg",
          warn
            ? "border-[color-mix(in_srgb,var(--state-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--state-warn)_5%,transparent)]"
            : "border-border bg-surface",
        )}
      >
        {line.cause && <p className="mb-2.5 text-[12.5px] text-fg-muted">{line.cause}</p>}
        <div>
          <p>
            <b className="font-semibold">Move the tag to the top.</b> Then the versions are ready
            before your page appears.
          </p>
          <div className="mt-2">
            <TagCopy label="Tag · first in the head, or top of the body" content={tag} />
          </div>
        </div>
        <div className="mt-3 border-t border-[color-mix(in_srgb,var(--fg)_8%,transparent)] pt-3">
          <p>
            <b className="font-semibold">Or leave it.</b> Rawuser changes nothing a visitor is
            already reading.
          </p>
          <p className="text-[12.5px] text-fg-muted">Those visits see your page as you built it.</p>
        </div>
        {line.counted && <p className="mt-3 text-xs text-fg-faint">{line.counted}</p>}
      </div>
    </details>
  );
}

/** Which fix a Pages card line opens, read from a fresh probe. */
export type TagFixKind = "policy" | "late";

/** True when the fresh probe still shows the problem the line names. */
export function fixStillNeeded(kind: TagFixKind, c: TagCondition): boolean {
  if (kind === "policy") {
    return c.kind === "blocked" || c.kind === "needs_nonce" || c.kind === "hash_only";
  }
  return c.kind === "late";
}

const FIX_COPY: Record<TagFixKind, { link: string; loading: string; cleared: string }> = {
  policy: {
    link: "See the lines",
    loading: "Reading the policy…",
    cleared: "The policy no longer blocks the tag. This line goes at the next check.",
  },
  late: {
    link: "How to move it",
    loading: "Checking the tag…",
    cleared: "The tag now runs in time. This line goes as new visits come in.",
  },
};

/**
 * A Pages card line whose link opens the fix in place (install-friction
 * mock, section 6). The site-wide policy line sits once under the intro;
 * the late-tag line sits under its page. The link runs the probe on that
 * page, which rebuilds the exact lines (they are never stored).
 */
export function TagFixLine({
  customer,
  pagePath,
  text,
  kind,
  className,
}: {
  customer: CustomerListItem;
  pagePath: string;
  text: string;
  kind: TagFixKind;
  className?: string;
}) {
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "open" | "failed">("idle");
  const domain = customer.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const copy = FIX_COPY[kind];

  async function open() {
    if (state === "open") return setState("idle");
    setState("loading");
    try {
      const r = await apiFetch<ProbeResponse>("/admin/snippet-status/probe", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id, page_path: pagePath }),
      });
      setProbe(r);
      setState("open");
    } catch {
      setState("failed");
    }
  }

  const condition = probe ? tagCondition(probe, domain) : null;
  return (
    <div className={className}>
      <p className={cn("rounded-sm px-2 py-1 text-xs leading-normal", TINT.warn)}>
        {text}{" "}
        <button
          type="button"
          className="underline decoration-dotted underline-offset-[3px] whitespace-nowrap"
          aria-expanded={state === "open"}
          onClick={() => void open()}
        >
          {state === "loading" ? copy.loading : copy.link}
        </button>
      </p>
      {state === "failed" && (
        <p className="mt-1.5 text-xs text-fg-muted">Rawuser could not check the tag just now.</p>
      )}
      {state === "open" &&
        condition &&
        (fixStillNeeded(kind, condition) ? (
          <ConditionBox
            condition={condition}
            install={probe?.install ?? null}
            tag={buildSnippet(customer.id)}
          />
        ) : (
          <p className="mt-1.5 text-xs text-fg-muted">{copy.cleared}</p>
        ))}
    </div>
  );
}
