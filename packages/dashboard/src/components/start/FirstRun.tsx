"use client";

import { SensitiveDialog, useSensitive } from "@/components/analytics/SensitiveControl";
import {
  AuditEndedScreen,
  AuditStrip,
  GoLiveAuditLine,
  LiveAuditLine,
  isAuditCustomer,
  useAuditStatus,
} from "@/components/audit/FirstRunAudit";
import { VisitorVersions } from "@/components/audit/VisitorVersions";
import { PickOnPage } from "@/components/onboard/PickOnPage";
import { TagCopy } from "@/components/onboard/TagCopy";
import { TagStatus } from "@/components/onboard/TagStatus";
import { BeforeGoLive, Dot } from "@/components/readiness/ReadinessList";
import { ConnectQuestion, HeldBox, QuestionRow } from "@/components/readiness/SpecialCategory";
import { useReadiness } from "@/components/readiness/useReadiness";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { Button } from "@/components/ui/Button";
import { Marked } from "@/components/ui/Marked";
import { Skeleton } from "@/components/ui/Skeleton";
import { adsReduced } from "@/lib/ad-links";
import { apiFetch } from "@/lib/api";
import { auditRefusal } from "@/lib/audit";
import { buttonsLine, withSwitches } from "@/lib/buttons";
import {
  LIVE_TEST_LINE,
  countedPages,
  goLiveTest,
  goLiveWarning,
  measureBody,
  resultWaitLine,
  shareLine,
  switchDefault,
  tickedPaths,
} from "@/lib/golive";
import { CAPTURE_WAIT_MS, waitLine } from "@/lib/install";
import { sameAddressLangs, withPage } from "@/lib/languages";
import { readFailureLine } from "@/lib/read-failure";
import {
  type ReadinessCheck,
  TAG_LABEL,
  blockingLine,
  checkById,
  connectCategory,
  errorSentence,
  promptLine,
  visibleChecks,
} from "@/lib/readiness";
import { isMarkIt } from "@/lib/sensitive";
import { apiErrorLine, checksTitle, lookRow, pendingLine } from "@/lib/site-map";
import { buildSnippet } from "@/lib/snippet-tag";
import { writesPart } from "@/lib/template-view";
import { cn } from "@/lib/utils";
import { readVersionList, versionLines } from "@/lib/versions";
import type {
  AnalyticsBreakdown,
  AnalyticsOverview,
  BusinessDNA,
  CaptureStatusResponse,
  CaptureTokenResponse,
  CustomerListItem,
  GoLiveResponse,
  HeroTexts,
  LiftReport,
  Manifest,
  ManifestResponse,
  ManifestsAllResponse,
  MeasureButton,
  PageRow,
  PagesBreakdown,
  ProbeResponse,
  QuickstartResponse,
  SiteMapView,
  StoredLanguage,
  VariantListAnswer,
  VariantListItem,
  VariantSummary,
} from "@/types/api";
import type { AuditStatus } from "@rawuser/shared";
import { siteOrigin } from "@rawuser/shared";
import { shapeLine } from "@rawuser/shared/inline-shape";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ButtonPartRow, ButtonRefusal, PartRow, useButtons } from "./Buttons";
import { FirstRunProviders, FirstRunShell } from "./FirstRunShell";
import { LanguageRow } from "./LanguageRow";
import { ButtonToCount, GoLiveTestLine, GoLiveWarning, Tick } from "./Measure";
import { usePageGroups } from "./PageGroups";
import { PagesCard } from "./PagesCard";
import { PlatformSteps } from "./PlatformSteps";
import { SiteMapDialog, YourPagesRow } from "./SiteMap";
import { usePrePaste } from "./TwoPartTag";
import { VersionLines } from "./VersionLines";
import { WaitBox } from "./WaitBox";
import { type HealthIssuesResponse, loadHealth } from "./health";
import { type FirstRunStep, firstRunStep, readyOnPage, seeItLink } from "./steps";
import { WARN_WASH } from "./tones";
import { useSiteMap } from "./useSiteMap";
import { useWriteVersions } from "./useWriteVersions";

/**
 * First-run flow (docs/specs/first-run.md). Three screens, one primary
 * button each, every escape hatch under "Something's not right?". The
 * endpoints are the script-first chain (quickstart, go-live) and the
 * picker; nothing new server-side.
 */

/** The audit's refusal sentences as the API words them (spec §17.4). */
const AUDIT_SPEND_LINE = "The audit's writing budget is used up.";
const AUDIT_REWRITE_LINE = "Rewrite everything is used for this audit.";

const SLOT_LABELS: Record<string, string> = {
  "hero.headline": "Hero headline",
  "hero.body": "Hero text",
  "hero.cta.label": "Hero button",
  "cta.cta.label": "Call-to-action button",
  "features.headline": "Features headline",
  "features.body": "Features text",
  "pricing.cta.label": "Pricing button",
  "forms.submit_label": "Form submit button",
};

function siteUrl(customer: CustomerListItem): string {
  // https, or http for a site on this machine or one typed with http.
  return `${siteOrigin(customer.domain)}/`;
}

function bareDomain(customer: CustomerListItem | null): string {
  return customer
    ? siteUrl(customer)
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "")
    : "";
}

/** The ticked languages that have a page; one on the same address is never among them. */
function enabledWithPage(languages: readonly StoredLanguage[] | undefined): string[] {
  return withPage(languages)
    .filter((l) => l.enabled)
    .map((l) => l.lang);
}

function Hatch({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-6 text-xs text-fg-faint group">
      <summary className="cursor-pointer text-fg-muted underline decoration-dotted underline-offset-[3px] list-none inline">
        Something&apos;s not right?
      </summary>
      <div className="mt-3 space-y-3 text-fg-muted">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: Connect
// ---------------------------------------------------------------------------

interface ConnectProps {
  customer: CustomerListItem;
  onResult: (r: QuickstartResponse) => void;
}

function Connect({ customer, onResult }: ConnectProps) {
  const { refresh: refreshCustomers } = useCustomerList();
  const [token, setToken] = useState<CaptureTokenResponse | null>(null);
  const [opening, setOpening] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlFirst, setUrlFirst] = useState(false);
  // The last probe answer (TagStatus), for the platform line and the
  // 45-second line (install-friction mock, sections 1 and 3).
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [overdue, setOverdue] = useState(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const pageUrl = siteUrl(customer);
  const domain = bareDomain(customer);
  const snippet = buildSnippet(customer.id);
  // The special-category question before the tag (readiness-check mock,
  // section 03; privacy review condition 2): no tag while it is withheld. An older
  // worker has no answer and the screen is as it was.
  const readiness = useReadiness(customer.id);
  const [asking, setAsking] = useState(false);
  const category = readiness.answer ? connectCategory(readiness.answer) : null;
  const withheld = readiness.state === "loading" || readiness.answer?.tag_withheld === true;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function runChain(path: string, allowFetch: boolean) {
    if (runningRef.current) return;
    runningRef.current = true;
    setReading(true);
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
      refreshCustomers();
      onResult(r);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(auditRefusal(e)?.message ?? readFailureLine(e));
      setReading(false);
      setToken(null);
    } finally {
      runningRef.current = false;
    }
  }

  async function openPage() {
    setError(null);
    setOpening(true);
    try {
      const data = await apiFetch<CaptureTokenResponse>("/admin/onboard/capture-token", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id, source_url: pageUrl }),
      });
      setToken(data);
      window.open(
        `${pageUrl}#rawuser_capture=${encodeURIComponent(data.token)}`,
        "_blank",
        "noopener",
      );
    } catch (e) {
      // A 409 while the tag is withheld: the API's sentence as written.
      setError(
        errorSentence(e) ??
          (e instanceof Error ? e.message : "Could not open the page. Try again."),
      );
    } finally {
      setOpening(false);
    }
  }

  // Poll while the page is open; when the capture lands, run the chain once.
  // The poll keeps running after the 45-second line: a capture that lands
  // late still moves the screen on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runChain reads refs and setters only
  useEffect(() => {
    if (token === null || reading) return;
    let cancelled = false;
    const interval = setInterval(() => {
      apiFetch<CaptureStatusResponse>(
        `/admin/onboard/capture-status?customer_id=${encodeURIComponent(customer.id)}&page_path=${encodeURIComponent(token.page_path)}`,
      )
        .then((data) => {
          if (cancelled || !data.captured) return;
          void runChain(token.page_path, false);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, reading, customer.id]);

  // After 45 seconds without a capture, name the likely cause.
  useEffect(() => {
    setOverdue(false);
    if (token === null) return;
    const t = setTimeout(() => setOverdue(true), CAPTURE_WAIT_MS);
    return () => clearTimeout(t);
  }, [token]);

  const captureLink = token ? `${pageUrl}#rawuser_capture=${token.token}` : "";
  const wait = token && overdue && !reading ? waitLine(probe, domain) : null;
  const readPath = token?.page_path ?? "/";

  return (
    <>
      <h1 className="text-[17px] font-semibold text-fg tracking-tight mb-1 text-balance">
        Add Rawuser to {domain}
      </h1>
      <p className="text-sm text-fg-muted mb-6 max-w-[60ch]">
        Two minutes. Rawuser then reads your page and writes a first version of it.
      </p>

      {category && (
        <ConnectQuestion
          customerId={customer.id}
          category={category}
          asking={asking}
          onAsk={() => setAsking(true)}
          onAnswered={() => {
            setAsking(false);
            readiness.reload();
            refreshCustomers();
          }}
        />
      )}

      <PlatformSteps
        probe={probe}
        tag={snippet}
        adsReduced={adsReduced(readiness.answer)}
        held={
          readiness.state === "loading" ? (
            <Skeleton className="mt-2 h-9 w-full max-w-[560px]" />
          ) : withheld && category && "held" in category ? (
            <HeldBox>{category.held}</HeldBox>
          ) : undefined
        }
      >
        <TagStatus customer={customer} pagePath="/" onProbe={setProbe} />
      </PlatformSteps>

      <section
        className={cn(
          "border-t border-b border-border py-5",
          withheld && "opacity-40 pointer-events-none",
        )}
        aria-disabled={withheld || undefined}
      >
        <h2 className="text-sm font-semibold text-fg mb-1">2. Open your page once</h2>
        <p className="text-sm text-fg-muted mb-3 max-w-[60ch]">
          Rawuser looks at the page the way a visitor sees it. Use a private window so nothing from
          your own login rides along.
        </p>
        {!urlFirst ? (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="button"
              size="lg"
              onClick={openPage}
              disabled={opening || reading || withheld}
              className="w-full sm:w-auto"
            >
              {(opening || reading) && <Loader2 className="h-4 w-4 animate-spin" />}
              {reading ? "Reading your page…" : "Open my page with Rawuser"}
              {!reading && !opening && <ExternalLink className="h-3.5 w-3.5" />}
            </Button>
            {token && !reading && !wait && (
              <span className="text-xs text-fg-faint flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for the page to open… this screen moves on by itself.
              </span>
            )}
            {reading && <span className="text-xs text-fg-faint">About half a minute.</span>}
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="button"
              size="lg"
              onClick={() => void runChain("/", true)}
              disabled={reading || withheld}
              className="w-full sm:w-auto"
            >
              {reading && <Loader2 className="h-4 w-4 animate-spin" />}
              {reading ? "Reading your page…" : `Read ${domain} from its address`}
            </Button>
            <span className="text-xs text-fg-faint">Takes up to half a minute.</span>
          </div>
        )}
        {token && !reading && !wait && (
          <p className="text-xs text-fg-faint mt-3">
            If the page did not open, paste this into a private window:{" "}
            <span className="font-mono break-all text-fg-muted">{captureLink}</span>
          </p>
        )}
        {wait && (
          <WaitBox
            wait={wait}
            captureLink={captureLink}
            domain={domain}
            onRead={() => void runChain(readPath, true)}
          />
        )}
        {error && <p className="text-state-err text-sm mt-3">{error}</p>}
      </section>

      <Hatch>
        <p>
          Can&apos;t add the tag yet?{" "}
          <button
            type="button"
            className="underline decoration-dotted"
            onClick={() => setUrlFirst(true)}
          >
            Rawuser can read the page from its address instead.
          </button>
        </p>
        <p>Tag pasted but not found? It is checked every 10 seconds; give the deploy a minute.</p>
      </Hatch>
    </>
  );
}

// ---------------------------------------------------------------------------
// Screen 2: Look
// ---------------------------------------------------------------------------

function HeroPane({ title, texts, after }: { title: string; texts: HeroTexts; after?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border p-4 min-w-0",
        after ? "border-state-success bg-surface" : "border-border bg-surface-muted",
      )}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-faint mb-3">
        {title}
      </p>
      <p className="text-[17px] font-semibold text-fg leading-snug tracking-tight text-balance">
        {texts.headline ? (
          <Marked text={texts.headline} />
        ) : (
          <span className="text-fg-faint">no headline found</span>
        )}
      </p>
      {texts.body && (
        <p className="text-[13px] text-fg-muted mt-2 leading-relaxed">
          <Marked text={texts.body} />
        </p>
      )}
      {texts.cta && (
        <span className="inline-block mt-3 text-xs font-medium px-2.5 py-1.5 rounded-sm bg-cta-bg text-cta-fg">
          <Marked text={texts.cta} />
        </span>
      )}
    </div>
  );
}

/**
 * What is known of the traffic before go live, for the one warning under the
 * test line: visits per page and in all over the last 7 days (the Results
 * reads), and the weeks a test would need (the lift report's `start`). Each
 * read is silent: a tag that is minutes old has no numbers, and then there
 * is no warning.
 */
function useGoLiveTraffic(customerId: string): {
  pages: PageRow[] | null;
  total: number | null;
  weeks: number | null;
} {
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [weeks, setWeeks] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = encodeURIComponent(customerId);
    apiFetch<AnalyticsBreakdown>(`/admin/analytics/breakdown?customer_id=${id}&window=7d`)
      .then((b) => {
        if (!cancelled) setPages(Array.isArray(b.pages?.pages) ? b.pages.pages : null);
      })
      .catch(() => {});
    apiFetch<AnalyticsOverview>(`/admin/analytics/overview?customer_id=${id}&window=7d`)
      .then((o) => {
        const n = o.hero?.total_visits;
        if (!cancelled) setTotal(typeof n === "number" ? n : null);
      })
      .catch(() => {});
    apiFetch<LiftReport>(`/admin/analytics/lift?customer_id=${id}`)
      .then((r) => {
        const w = r.start?.estimate?.weeks;
        if (!cancelled) setWeeks(typeof w === "number" ? w : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  return { pages, total, weeks };
}

interface LookProps {
  customer: CustomerListItem;
  result: QuickstartResponse;
  onReread: () => void;
  /** Whether go live started a test (the Live screen's one line). */
  onLive: (testStarted: boolean) => void;
  /** A free audit: one line under Go live (mock section 03). */
  audit?: boolean;
}

function Look({ customer, result, onReread, onLive, audit = false }: LookProps) {
  const { refresh: refreshCustomers } = useCustomerList();
  const { user } = useCurrentUser();
  const superadmin = user?.role === "superadmin";
  const [brief, setBrief] = useState<BusinessDNA>(result.brief);
  const [manifest, setManifest] = useState<Manifest>(result.manifest);
  const [uncertain, setUncertain] = useState<string[]>(result.uncertain_paths);
  const [showParts, setShowParts] = useState(false);
  // The customer's consent per language (docs/specs/per-language.md).
  const [enabledLangs, setEnabledLangs] = useState<Set<string>>(
    () => new Set(enabledWithPage(result.languages)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The button to count and the test (docs/specs/measure-at-go-live.md):
  // Rawuser's proposal, the switch On unless this is a test customer.
  const [chosen, setChosen] = useState<MeasureButton | null>(result.measure?.proposal ?? null);
  const [switchOn, setSwitchOn] = useState(() => switchDefault(customer.plan));
  // Your pages (site-shaped intents): read again with every fresh result,
  // since the quickstart reads the menus beside the preview.
  const siteMap = useSiteMap(customer.id, result);
  const [mapOpen, setMapOpen] = useState(false);
  const pagesRow = lookRow(siteMap.loaded ? siteMap.view : null);
  // The page's buttons and their switches, off unless the operator turns one
  // on (docs/specs/button-rewrite.md). Null from a worker that lists none.
  const {
    buttons,
    busy: buttonBusy,
    refusal: buttonRefusal,
    toggle: toggleButton,
    reload: reloadButtons,
  } = useButtons({ customerId: customer.id, pagePath: result.page_path, initial: result.buttons });
  const buttonsWords = buttonsLine(buttons);

  // A fresh read replaces everything on screen.
  useEffect(() => {
    setBrief(result.brief);
    setManifest(result.manifest);
    setUncertain(result.uncertain_paths);
    setEnabledLangs(new Set(enabledWithPage(result.languages)));
    setChosen(result.measure?.proposal ?? null);
  }, [result]);

  const ticked = tickedPaths(result.languages, enabledLangs, result.page_path);
  const test = goLiveTest({
    plan: customer.plan,
    chosen,
    lowTraffic: result.measure?.low_traffic === true,
    switchOn,
  });

  // One warning before the click (mock pilot-gaps, screen 05): the counted
  // button's page gets a small share of visits, or the result is far off.
  const traffic = useGoLiveTraffic(customer.id);
  const [countSignal, setCountSignal] = useState(0);
  const warning = goLiveWarning({
    test,
    share: shareLine({
      pages: countedPages(result.measure, chosen, ticked, result.page_path),
      rows: traffic.pages,
      total: traffic.total,
    }),
    wait: resultWaitLine(traffic.weeks ?? result.measure?.estimate_weeks),
  });

  // The readiness list above Go live (readiness-check mock, sections 01 and
  // 02): the customer's view, red first. An older worker gives no list and
  // the screen is as it was. One line blocks (check 3); its sentence sits
  // under the closed button.
  const readiness = useReadiness(customer.id, result);
  const checks = readiness.answer ? visibleChecks(readiness.answer.checks, false) : [];
  const blocked = readiness.answer?.blocks_go_live === true;
  const stopLine = blocked ? blockingLine(checks) : null;
  // Which line's action is open in place: the tag with Copy (A5), the question (A12).
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const partsRef = useRef<HTMLDivElement>(null);
  // "Mark it" on a Yes not yet marked (superadmin only): the sensitive
  // dialog in place (site-wide-and-sensitive mock, section 06).
  const sensitive = useSensitive(customer.id, superadmin);
  const [marking, setMarking] = useState(false);
  const inPlace = (c: ReadinessCheck): (() => void) | null => {
    switch (c.id) {
      case "category":
        // Opened once the flag and the list are read; until then the API's link.
        if (isMarkIt(c)) return superadmin && sensitive.view ? () => setMarking(true) : null;
        return () => setOpenCheck((o) => (o === c.id ? null : c.id));
      case "tag":
        return () => setOpenCheck((o) => (o === c.id ? null : c.id));
      case "counted":
        return () => setCountSignal((n) => n + 1);
      case "buttons":
        return () => {
          setShowParts(true);
          const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          partsRef.current?.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
        };
      default:
        return null;
    }
  };
  const openContent =
    openCheck === "tag" ? (
      <div className="max-w-[560px]">
        <TagCopy label={TAG_LABEL} content={buildSnippet(customer.id)} />
      </div>
    ) : openCheck === "category" ? (
      <QuestionRow
        customerId={customer.id}
        prompt={promptLine(checkById(checks, "category"))}
        onAnswered={() => {
          setOpenCheck(null);
          readiness.reload();
          refreshCustomers();
        }}
      />
    ) : null;

  const numbers = [...brief.proof_points, ...brief.value_props].filter((t) => /\d/.test(t));
  const gaps = new Set(result.brief_gaps);
  const uncertainOnPage = uncertain.filter((p) => manifest[p]);

  function dropNumber(text: string) {
    setBrief((b) => ({
      ...b,
      proof_points: b.proof_points.filter((t) => t !== text),
      value_props: b.value_props.filter((t) => t !== text),
    }));
  }

  async function goLive() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<GoLiveResponse>("/admin/onboard/go-live", {
        method: "POST",
        body: JSON.stringify({
          customer_id: customer.id,
          page_path: result.page_path,
          dna: brief,
          // Each button says its switch as the screen shows it.
          manifest: withSwitches(manifest, buttons),
          languages: Array.from(enabledLangs),
          ...measureBody(chosen, test),
        }),
      });
      refreshCustomers();
      onLive(r.test?.started === true);
    } catch (e) {
      // A 409 carries the blocking readiness line as `error`, shown as written.
      setError(
        errorSentence(e) ??
          auditRefusal(e)?.message ??
          (e instanceof Error ? e.message : "Going live failed. Try again."),
      );
      setBusy(false);
      readiness.reload();
    }
  }

  const partsCount = Object.keys(manifest).length;
  // Parts Rawuser will not write: the operator's "leave it", split text
  // without a decision, text that changes by itself.
  const leftAlone = Object.values(manifest).filter((e) => !writesPart(e)).length;

  return (
    <>
      <h1 className="text-[17px] font-semibold text-fg tracking-tight mb-1 text-balance">
        Here is {bareDomain(customer)}, and one version of it.
      </h1>
      <p className="text-sm text-fg-muted mb-5 max-w-[62ch]">
        Left, your page as it is. Right, how Rawuser rewrites it for someone who is comparing
        options. The other versions are written after you go live.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <HeroPane title="Your page now" texts={result.current} />
        {result.preview ? (
          <HeroPane title="For a visitor comparing options" texts={result.preview} after />
        ) : (
          <div className="rounded-md border border-border p-4 text-sm text-fg-muted">
            The first version could not be written yet. Go live anyway and it is written with the
            others, or read the page again.
          </div>
        )}
      </div>

      <h2 className="text-sm font-semibold text-fg mb-2">{checksTitle(pagesRow)}</h2>
      <div className="rounded-md border border-border overflow-hidden mb-5">
        <div
          ref={partsRef}
          className={cn(
            "px-4 py-3 border-b border-border",
            uncertainOnPage.length > 0 && WARN_WASH,
          )}
        >
          <div className="grid grid-cols-[24px_1fr_auto] gap-3 items-center">
            <Tick warn={uncertainOnPage.length > 0} />
            <div>
              <p className="text-sm font-medium text-fg">Parts of the page</p>
              <p className="text-[13px] text-fg-muted">
                {partsCount} found
                {uncertainOnPage.length > 0
                  ? `, ${uncertainOnPage.length} we are not sure about`
                  : ", every one matched exactly once"}
                {leftAlone > 0 ? `, ${leftAlone} left alone` : ""}.
                {buttonsWords ? ` ${buttonsWords}` : ""}
              </p>
            </div>
            <button
              type="button"
              className="text-xs text-fg-muted underline decoration-dotted underline-offset-[3px]"
              onClick={() => setShowParts((v) => !v)}
            >
              {showParts ? "Hide" : "See"}
            </button>
          </div>
          {showParts && (
            <div className="mt-3 sm:ml-9">
              <ul className="border-t border-border">
                {Object.entries(manifest).map(([path, entry]) => {
                  const check = uncertainOnPage.includes(path) && (
                    <span className="ml-2 text-xs text-state-warn">check on the page</span>
                  );
                  const words = (
                    <>
                      {entry.text[0] ?? entry.css[0] ?? ""}
                      {check}
                    </>
                  );
                  // A button keeps the page's words until its own switch is on
                  // (mock pilot-gaps, screen 04).
                  const button = buttons?.find((b) => b.path === path);
                  if (button) {
                    return (
                      <ButtonPartRow
                        key={path}
                        button={{ ...button, text: button.text || (entry.text[0] ?? "") }}
                        chosen={chosen}
                        busy={buttonBusy === path}
                        onToggle={(at, on) => void toggleButton(at, on)}
                      >
                        {check}
                      </ButtonPartRow>
                    );
                  }
                  const line = shapeLine(entry.inline, entry.skip, entry.plain);
                  return (
                    <PartRow
                      key={path}
                      name={SLOT_LABELS[path] ?? path}
                      words={words}
                      note={line.text}
                      caution={Boolean(line.ask)}
                    >
                      {line.ask === "split" && (
                        <span className="mt-1 inline-flex overflow-hidden rounded-sm border border-border-strong text-xs">
                          <button
                            type="button"
                            className={cn(
                              "px-2 py-0.5",
                              !entry.plain ? "bg-cta-bg text-cta-fg" : "text-fg-muted",
                            )}
                            onClick={() =>
                              setManifest((m) => ({
                                ...m,
                                [path]: { ...entry, skip: true, plain: false },
                              }))
                            }
                          >
                            Leave it
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "px-2 py-0.5",
                              entry.plain ? "bg-cta-bg text-cta-fg" : "text-fg-muted",
                            )}
                            onClick={() =>
                              setManifest((m) => ({
                                ...m,
                                [path]: { ...entry, skip: false, plain: true },
                              }))
                            }
                          >
                            Replace as plain text
                          </button>
                        </span>
                      )}
                    </PartRow>
                  );
                })}
              </ul>
              <ButtonRefusal line={buttonRefusal} />
            </div>
          )}
          {uncertainOnPage.length > 0 && (
            <div className="mt-3 ml-9">
              <PickOnPage
                customerId={customer.id}
                pagePath={result.page_path}
                onPicked={(picked) => {
                  setManifest(picked);
                  setUncertain([]);
                  void reloadButtons();
                }}
              />
            </div>
          )}
        </div>

        <YourPagesRow row={pagesRow} onChange={() => setMapOpen(true)} />

        <ButtonToCount
          customerId={customer.id}
          pagePath={result.page_path}
          measure={result.measure}
          chosen={chosen}
          onChoose={setChosen}
          ticked={ticked}
          openSignal={countSignal}
        />

        <div
          className={cn(
            "px-4 py-3 border-b border-border",
            (gaps.size > 0 || numbers.length > 0) && WARN_WASH,
          )}
        >
          <div className="grid grid-cols-[24px_1fr] gap-3 items-start">
            <Tick warn={gaps.size > 0 || numbers.length > 0} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Numbers and names we read</p>
              <p className="text-[13px] text-fg-muted">
                {numbers.length > 0
                  ? "Used as written on your page. Untick anything we should not repeat."
                  : "None on the page, so none will appear in any version."}
              </p>
              {numbers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
                  {numbers.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-fg">
                      <input
                        type="checkbox"
                        checked
                        onChange={() => dropNumber(t)}
                        className="h-3.5 w-3.5"
                      />
                      {t}
                    </label>
                  ))}
                </div>
              )}
              {gaps.size > 0 && (
                <div className="mt-3 space-y-2">
                  {gaps.has("product") && (
                    <label className="block text-[13px]">
                      <span className="text-fg-muted">What you offer, in one sentence</span>
                      <textarea
                        value={brief.product}
                        onChange={(e) => setBrief((b) => ({ ...b, product: e.target.value }))}
                        rows={2}
                        className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
                      />
                    </label>
                  )}
                  {gaps.has("icp") && (
                    <label className="block text-[13px]">
                      <span className="text-fg-muted">Who it is for</span>
                      <textarea
                        value={brief.icp}
                        onChange={(e) => setBrief((b) => ({ ...b, icp: e.target.value }))}
                        rows={2}
                        className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <LanguageRow
          languages={result.languages}
          sameAddress={sameAddressLangs(result)}
          language={brief.target_language}
          languageSource={result.language_source}
          enabled={enabledLangs}
          onToggle={(lang, on) =>
            setEnabledLangs((prev) => {
              const next = new Set(prev);
              if (on) next.add(lang);
              else next.delete(lang);
              return next;
            })
          }
          onLanguage={(lang) => setBrief((b) => ({ ...b, target_language: lang }))}
        />
      </div>

      <BeforeGoLive
        checks={checks}
        inPlace={inPlace}
        openId={openCheck}
        openContent={openContent}
      />
      {superadmin && marking && sensitive.view && (
        <SensitiveDialog
          customerId={customer.id}
          view={sensitive.view}
          onClose={() => setMarking(false)}
          onSaved={(saved) => {
            sensitive.apply(saved);
            setMarking(false);
            readiness.reload();
            refreshCustomers();
          }}
        />
      )}

      {error && <p className="text-state-err text-sm mb-3">{error}</p>}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          type="button"
          size="lg"
          onClick={goLive}
          disabled={busy || blocked}
          className="w-full sm:w-auto"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Go live
        </Button>
        <span className="w-full text-xs text-fg-faint sm:w-auto">
          Then the other versions are written, about a minute.
        </span>
      </div>
      {/* The blocking line under the closed button (mock A13). */}
      {stopLine && (
        <p
          className="mt-2 flex max-w-[62ch] items-start gap-2 text-[13px] text-[color:color-mix(in_srgb,var(--state-err)_85%,black)]"
          data-line="go-live-stop"
        >
          <Dot state="red" className="mt-[7px]" />
          <span>{stopLine}</span>
        </p>
      )}
      {audit && <GoLiveAuditLine />}
      {/* In plain view beside Go live at every width, never in the hatch
          (privacy review, measure-at-go-live.md section 9, conditions 1 and 2). */}
      <GoLiveTestLine test={test} onToggle={() => setSwitchOn((v) => !v)} />
      <GoLiveWarning line={warning} onCountAnother={() => setCountSignal((n) => n + 1)} />
      <SiteMapDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        view={siteMap.view}
        onSaved={siteMap.setView}
      />

      <Hatch>
        <div>
          Wrong element highlighted? Fix it on the page: you click the right one.
          <div className="mt-1">
            <PickOnPage
              customerId={customer.id}
              pagePath={result.page_path}
              onPicked={(picked) => {
                setManifest(picked);
                setUncertain([]);
                void reloadButtons();
              }}
            />
          </div>
        </div>
        <p>
          The description of your product is off?{" "}
          <Link
            href={`/dna?customer_id=${encodeURIComponent(customer.id)}`}
            className="underline decoration-dotted"
          >
            Edit it
          </Link>
          , or{" "}
          <button
            type="button"
            className="underline decoration-dotted"
            onClick={onReread}
            disabled={busy}
          >
            read the page again
          </button>
          .
        </p>
      </Hatch>
    </>
  );
}

// ---------------------------------------------------------------------------
// Screen 3: Live
// ---------------------------------------------------------------------------

/**
 * Whether a test is running for the Live screen's one line: the go live's
 * answer when it just happened, else the lift report (a reload). A failed
 * read adds nothing.
 */
function useTestRunning(customerId: string, known: boolean | null): boolean {
  const [running, setRunning] = useState(known ?? false);
  useEffect(() => {
    if (known !== null) {
      setRunning(known);
      return;
    }
    let cancelled = false;
    apiFetch<LiftReport>(`/admin/analytics/lift?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => {
        if (!cancelled) {
          setRunning(r.test?.started_by === "go_live" && r.test.ended_at === null);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [customerId, known]);
  return running;
}

function Live({
  customer,
  testStarted,
  audit = null,
}: {
  customer: CustomerListItem;
  /** From the go live just made; null after a reload. */
  testStarted: boolean | null;
  /** A free audit's state (GET /admin/audit); null for anyone else. */
  audit?: AuditStatus | null;
}) {
  const testRunning = useTestRunning(customer.id, testStarted);
  // Page groups for the Pages card (docs/specs/page-groups.md): a silent
  // read; an older worker leaves the card as it was.
  const { user } = useCurrentUser();
  const superadmin = user?.role === "superadmin";
  const pageGroups = usePageGroups(customer.id, superadmin);
  // The two-part tag, only after go live (the founder's decision 1, 2026-10-26).
  const prePaste = usePrePaste(customer.id);
  // The tag withheld: never for a live customer in practice (go live is
  // blocked while it is), read once so this door follows the same rule.
  const readiness = useReadiness(customer.id);
  // Pages to write come from the confirmed manifests (docs/specs/first-run.md
  // §6), so an extra same-language page is written without being a
  // "language". Until they load, the enabled language paths stand in.
  // A language on the same address has no page and is never a path to write.
  const langPaths = withPage(customer.languages)
    .filter((l) => l.enabled)
    .map((l) => l.path);
  const [pages, setPages] = useState<ManifestResponse[] | null>(null);
  const [readyByPath, setReadyByPath] = useState<Record<string, number>>({});
  const [pagesKey, setPagesKey] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pagesKey is a refresh trigger, bumped to reload the manifests
  useEffect(() => {
    let cancelled = false;
    apiFetch<ManifestsAllResponse>(
      `/admin/onboard/manifest?customer_id=${encodeURIComponent(customer.id)}&all=true`,
    )
      .then((d) => {
        if (!cancelled) setPages((d.manifests ?? []).filter((m) => m.confirmed_at));
      })
      .catch(() => {
        if (!cancelled) setPages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customer.id, pagesKey]);
  // The last day's problems per page for the Pages card. The endpoint is
  // scoped to the customer; a 403 or any other failure resolves to null and
  // the card stays as it is. Loading and errors are silent.
  const [health, setHealth] = useState<HealthIssuesResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadHealth(customer.id, apiFetch).then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [customer.id]);
  // Visits per page over the last 7 days (the Results read), for the Pages
  // card's one line about pages without versions. Silent: no row yet, an
  // older worker or a failure leaves the card without the line.
  const [visited, setVisited] = useState<PagesBreakdown | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<AnalyticsBreakdown>(
      `/admin/analytics/breakdown?customer_id=${encodeURIComponent(customer.id)}&window=7d`,
    )
      .then((b) => {
        if (!cancelled) setVisited(b.pages ?? null);
      })
      .catch(() => {
        if (!cancelled) setVisited(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customer.id]);
  const confirmedPaths = pages ? pages.map((p) => p.page_path) : [];
  const paths =
    confirmedPaths.length > 0 ? confirmedPaths : langPaths.length > 0 ? langPaths : ["/"];
  // The intents this site serves (site-shaped intents §7.3): the write loop,
  // Rewrite everything and every count ask for those only. Until the map
  // answers the loop waits; a failed read means all six.
  const siteMap = useSiteMap(customer.id, pagesKey);
  const served = siteMap.view?.served ?? null;
  const servedKey = served ? served.join(",") : "*";
  const [mapOpen, setMapOpen] = useState(false);
  const [writingPending, setWritingPending] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  // Bumped when a button's switch marked a page's versions to be written again.
  const [runKey, setRunKey] = useState(0);
  const { ready, total, running, failed, stopped, refused, mode, rewriteAll } = useWriteVersions(
    customer.id,
    paths,
    pages !== null && siteMap.loaded,
    served,
    runKey,
  );
  const perPage = Math.round(total / Math.max(1, paths.length));
  // The versions as the worker lists them, with the summary once a write has
  // ended (docs/specs/refused-versions.md): the lines under the count read
  // both. A worker from before 2026-10-12 answers the array alone.
  const [listed, setListed] = useState<{
    items: VariantListItem[];
    summary: VariantSummary | null;
  }>({ items: [], summary: null });
  // Ready versions per page, for the Pages card; refreshed while writing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pagesKey is a refresh trigger and servedKey stands in for served
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch<VariantListAnswer>(
        `/admin/variants/list?customer_id=${encodeURIComponent(customer.id)}${running ? "" : "&summary=1"}`,
      )
        .then((raw) => {
          if (cancelled) return;
          const list = readVersionList(raw);
          const { items } = list;
          setListed(list);
          const counts: Record<string, number> = {};
          for (const p of new Set(items.map((i) => i.page_path))) {
            counts[p] = readyOnPage(items, p, served);
          }
          setReadyByPath(counts);
        })
        .catch(() => {});
    void load();
    if (!running) return;
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [customer.id, running, pagesKey, servedKey]);

  async function writePending() {
    setWritingPending(true);
    setPendingError(null);
    try {
      const v = await apiFetch<SiteMapView>("/admin/site-map/write", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id }),
      });
      siteMap.setView(v);
    } catch (e) {
      setPendingError(apiErrorLine(e, "Could not start the writing. Try again."));
    } finally {
      setWritingPending(false);
    }
  }
  const reread = pendingLine(siteMap.view?.pending ?? null);
  const [copied, setCopied] = useState(false);
  const [askRewrite, setAskRewrite] = useState(false);
  const link = seeItLink(customer.domain);
  const done = ready ?? 0;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const lines = versionLines({
    items: listed.items,
    summary: listed.summary,
    paths,
    served,
    ready,
    total,
    running,
  });
  const rewriteUsed = refused === AUDIT_REWRITE_LINE || audit?.caps.rewrite_used_up === true;
  const capWarn =
    refused && refused !== AUDIT_REWRITE_LINE
      ? refused
      : audit?.caps.spend_used_up && done < total
        ? AUDIT_SPEND_LINE
        : null;

  return (
    <>
      <h1 className="text-[17px] font-semibold text-fg tracking-tight mb-1">
        {bareDomain(customer)} is live.
      </h1>
      <p className="text-sm text-fg-muted mb-6 max-w-[62ch]">
        Visitors who arrive with a signal, a campaign link, a social app, an AI answer, now see the
        version written for them. Everyone else sees your page as it is.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div className="rounded-md border border-border p-4">
          <h2 className="text-sm font-semibold text-fg mb-1">
            {running
              ? mode === "all"
                ? "Rewriting every version"
                : "Writing the other versions"
              : done >= total
                ? "All versions written"
                : "Versions"}
          </h2>
          <p className="text-[13px] text-fg-muted mb-2">
            One for each kind of visitor and where they came from.
          </p>
          <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden mb-2">
            <div
              className="h-full bg-state-success transition-[width] duration-medium ease-smooth"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[13px] tabular-nums text-fg">
            {ready === null ? "…" : `${done} of ${total}`}
          </span>
          {/* Quiet lines, never a running count of failures (mock screen 01). */}
          <VersionLines lines={lines} />
          {stopped && <p className="mt-2 text-[13px] text-state-warn max-w-[62ch]">{stopped}</p>}
          {/* The audit's caps: spend is a warning, a used rewrite a quiet line (mock section 03). */}
          {capWarn && (
            <p
              className={cn(
                "mt-2 rounded-sm border border-[color-mix(in_srgb,var(--state-warn)_25%,transparent)] px-2.5 py-2 text-[13px] text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]",
                WARN_WASH,
              )}
            >
              {capWarn}
            </p>
          )}
          {!running && rewriteUsed && (
            <p className="mt-2.5 text-[13px] text-fg-faint">{AUDIT_REWRITE_LINE}</p>
          )}
          {/* Offered once the loop is done, even when a version is not
              written: one unwritten version must not hide the rewrite
              (a pilot site, 2026-09-15, 89 of 90 and no link). */}
          {!running && done + failed >= total && done > 0 && !askRewrite && !rewriteUsed && (
            <p className="mt-3 text-[13px] text-fg-muted">
              Changed the brief or the parts of the page?{" "}
              <button
                type="button"
                className="text-fg underline decoration-dotted underline-offset-[3px]"
                onClick={() => setAskRewrite(true)}
              >
                Rewrite everything
              </button>
            </p>
          )}
          {!running && askRewrite && (
            <div className="mt-3 rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px]">
              <p className="text-fg mb-2">
                Rewrite all {total} versions, about ${(total * 0.003).toFixed(2)}, roughly{" "}
                {Math.max(3, Math.round(total / 10))} to {Math.max(5, Math.round(total / 5))}{" "}
                minutes. Visitors keep seeing the old version of each page until its new one is
                written.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setAskRewrite(false);
                    void rewriteAll();
                  }}
                >
                  Rewrite
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setAskRewrite(false)}
                >
                  Keep them
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="rounded-md border border-border p-4">
          <h2 className="text-sm font-semibold text-fg mb-1">See it yourself</h2>
          <p className="text-[13px] text-fg-muted mb-2">
            Open this in a new tab and watch the headline change.
          </p>
          <div className="font-mono text-xs bg-surface-muted border border-border rounded-md px-2.5 py-2 overflow-x-auto whitespace-nowrap mb-2">
            {link}
          </div>
          <div className="flex gap-2">
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
            <Button asChild size="sm" variant="ghost">
              <a href={link} target="_blank" rel="noopener noreferrer">
                Open <ExternalLink size={12} />
              </a>
            </Button>
          </div>
        </div>
      </div>

      {audit && audit.stage !== "ended" && audit.stage !== "lapsed" && (
        <VisitorVersions
          customerId={customer.id}
          domain={bareDomain(customer)}
          pages={paths}
          served={served}
        />
      )}

      <div className="mb-6">
        <PagesCard
          customer={customer}
          pages={pages ?? []}
          readyByPath={readyByPath}
          perPage={perPage}
          writing={running}
          onPageAdded={() => setPagesKey((k) => k + 1)}
          onVersionsStale={() => {
            setPagesKey((k) => k + 1);
            setRunKey((k) => k + 1);
          }}
          health={health}
          visited={visited}
          groups={{ data: pageGroups, superadmin }}
          tagWithheld={readiness.answer?.tag_withheld === true}
          pre={{ answer: prePaste.answer, onAnswer: prePaste.set }}
          auditFull={audit ? audit.caps.pages_full || paths.length >= audit.caps.pages_max : false}
          reread={
            reread
              ? {
                  line: reread,
                  onWrite: () => void writePending(),
                  onChange: () => setMapOpen(true),
                  busy: writingPending,
                  error: pendingError,
                }
              : null
          }
        />
        <SiteMapDialog
          open={mapOpen}
          onOpenChange={setMapOpen}
          view={siteMap.view}
          onSaved={siteMap.setView}
        />
      </div>

      <section className="border-t border-border pt-5">
        <h2 className="text-sm font-semibold text-fg mb-1">What happens next</h2>
        <p className="text-sm text-fg-muted mb-3 max-w-[62ch]">
          First visits show up on Visitors within a day. The tag is checked every six hours; if it
          disappears you will see it here. You can change your product brief any time.
        </p>
        {audit && <LiveAuditLine status={audit} />}
        {/* Its own row with the dot Results uses for "Test: On" (mock section 05, call 5). */}
        {testRunning && (
          <p className="-mt-1 mb-3 flex items-start gap-2 text-sm text-fg sm:items-center">
            <span
              aria-hidden
              className="mt-[7px] h-[7px] w-[7px] flex-none rounded-full bg-fg sm:mt-0"
            />
            {LIVE_TEST_LINE}
          </p>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <Button asChild variant="secondary">
            <Link href={`/?customer_id=${encodeURIComponent(customer.id)}`}>
              Open the full dashboard
            </Link>
          </Button>
          <span className="text-xs text-fg-faint">
            Versions, visitors, campaign links, and everything else.
          </span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

function FirstRunInner() {
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const { customers, loading, refresh: refreshCustomers } = useCustomerList();
  const paramId = searchParams.get("customer_id");
  const customerId = user?.role === "customer" ? (user.customer_id ?? "") : (paramId ?? "");
  const customer = customers.find((c) => c.id === customerId) ?? null;

  const [result, setResult] = useState<QuickstartResponse | null>(null);
  const [step, setStep] = useState<FirstRunStep | null>(null);
  const [rereading, setRereading] = useState(false);
  const [testStarted, setTestStarted] = useState<boolean | null>(null);
  // A free audit (docs/specs/ai-traffic-audit.md §3.3): the strip and its lines.
  const { status: auditStatus, reload: reloadAudit } = useAuditStatus(customer);
  const isAudit = isAuditCustomer(customer);

  // The customers row decides the step on load; local events move it on
  // without waiting for the list to refresh.
  useEffect(() => {
    if (!customer || step !== null) return;
    setStep(firstRunStep(customer));
  }, [customer, step]);

  // Landing on Look after a refresh: the stored result comes back.
  useEffect(() => {
    if (step !== "look" || result !== null || !customer) return;
    let cancelled = false;
    apiFetch<QuickstartResponse>(
      `/admin/onboard/quickstart?customer_id=${encodeURIComponent(customer.id)}&page_path=%2F`,
    )
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setStep("connect");
      });
    return () => {
      cancelled = true;
    };
  }, [step, result, customer]);

  async function reread() {
    if (!customer || rereading) return;
    setRereading(true);
    try {
      const r = await apiFetch<QuickstartResponse>("/admin/onboard/quickstart", {
        method: "POST",
        body: JSON.stringify({ customer_id: customer.id, page_path: "/", allow_fetch: true }),
      });
      setResult(r);
      refreshCustomers();
    } catch {
      // The screen keeps the previous result; the hatch stays available.
    } finally {
      setRereading(false);
    }
  }

  if (loading && !customer) {
    return (
      <FirstRunShell domain="" current="connect">
        <Skeleton className="h-6 w-64 mb-3" />
        <Skeleton className="h-40 w-full" />
      </FirstRunShell>
    );
  }

  if (!customer) {
    return (
      <FirstRunShell domain="" current="connect">
        <p className="text-sm text-fg-muted">
          No customer selected.{" "}
          <Link href="/customers" className="underline decoration-dotted">
            Choose one
          </Link>
          .
        </p>
      </FirstRunShell>
    );
  }

  // An ended or lapsed audit shows one screen, nothing else (spec §3.8).
  if (isAudit && customer.status === "ended") return <AuditEndedScreen customer={customer} />;

  const current: FirstRunStep = step ?? "connect";
  const domain = bareDomain(customer);

  return (
    <FirstRunShell
      domain={domain}
      current={current}
      strip={isAudit ? <AuditStrip status={auditStatus} /> : undefined}
    >
      {current === "connect" && (
        <Connect
          customer={customer}
          onResult={(r) => {
            setResult(r);
            setStep("look");
          }}
        />
      )}
      {current === "look" &&
        (result ? (
          <div className={cn(rereading && "opacity-60 pointer-events-none")}>
            <Look
              customer={customer}
              result={result}
              onReread={() => void reread()}
              onLive={(started) => {
                setTestStarted(started);
                setStep("live");
                reloadAudit();
              }}
              audit={isAudit}
            />
          </div>
        ) : (
          <Skeleton className="h-40 w-full" />
        ))}
      {current === "live" && (
        <Live customer={customer} testStarted={testStarted} audit={isAudit ? auditStatus : null} />
      )}
    </FirstRunShell>
  );
}

export function FirstRun() {
  return (
    <FirstRunProviders>
      <FirstRunInner />
    </FirstRunProviders>
  );
}
