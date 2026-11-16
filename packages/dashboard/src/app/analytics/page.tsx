"use client";

import { MeasureSetup, Said, useButtons, useTestAction } from "@/components/analytics/MeasureSetup";
import { NextSteps } from "@/components/analytics/NextSteps";
import { ProofSection, useProof } from "@/components/analytics/ProofSection";
import { ResultsAdmin } from "@/components/analytics/ResultsAdmin";
import { ResultsAdvanced } from "@/components/analytics/ResultsAdvanced";
import { ResultsHeadline } from "@/components/analytics/ResultsHeadline";
import { SensitiveDialog, useSensitive } from "@/components/analytics/SensitiveControl";
import { TestStatus } from "@/components/analytics/TestStatus";
import { TrafficBand } from "@/components/analytics/TrafficBand";
import { WhoComes } from "@/components/analytics/WhoComes";
import { ButtonsDialog } from "@/components/conversions/ButtonList";
import { TagCopy } from "@/components/onboard/TagCopy";
import { TrafficLine } from "@/components/readiness/TrafficLine";
import { useReadiness } from "@/components/readiness/useReadiness";
import { AppShell } from "@/components/shell/AppShell";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { OldRoute } from "@/components/shell/OldRoute";
import { ScreenEmpty } from "@/components/shell/ScreenEmpty";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api";
import { resultsLayout, testIsOn } from "@/lib/measure";
import { countedLines } from "@/lib/page-groups";
import { type ReadinessCheck, TAG_LABEL, trafficLine } from "@/lib/readiness";
import { type ResultsWindow, nextSteps, parseWindow } from "@/lib/results";
import { isMarkIt } from "@/lib/sensitive";
import { buildSnippet } from "@/lib/snippet-tag";
import type {
  AnalyticsBreakdown,
  AnalyticsOverview,
  AnalyticsTimeseries,
  ManifestsAllResponse,
  TimeSeriesPoint,
} from "@/types/api";
import { BarChart2, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { Suspense } from "react";

/**
 * Results (/analytics), rebuilt around three questions: is it working, who
 * comes and why, what to do next (mock design/mock/sales-readiness/
 * results-page.html, approved 2026-10-04). The test answers the first and
 * keeps its own period; the period switch sits on "Your traffic" and moves
 * everything below it. Cohorts, the daily chart, natural lift and each
 * version's numbers are in Advanced, closed by default.
 *
 * Before the first test, "Is it working?" is three steps the customer takes
 * alone: choose the button to count, start the test, get the result
 * (measure-setup.html, approved 2026-10-04). Every operator tool sits in
 * Admin at the page's foot.
 *
 * With too little traffic to read a test within a year (measure-at-go-live
 * mock, section 06 D), "Who comes to your site, and why?" leads and "Is it
 * working?" keeps one line and Start anyway.
 */

// The dialog carries the edge's classifier; it loads on the first click, not with the page.
const TaggedLinkDialog = dynamic(
  () => import("@/components/analytics/TaggedLinkDialog").then((m) => m.TaggedLinkDialog),
  { ssr: false },
);

function useJson<T>(path: string | null): { data: T | null; loading: boolean } {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<T | { empty: true }>(path)
      .then((d) => {
        if (!cancelled) setData(d && typeof d === "object" && "empty" in d ? null : (d as T));
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { data, loading };
}

function updatedAgo(computedAt: number | null): string | null {
  if (!computedAt) return null;
  const min = Math.round((Date.now() - computedAt) / 60_000);
  if (min < 2) return "updated just now";
  if (min < 60) return `updated ${min} min ago`;
  return `updated ${Math.round(min / 60)} h ago`;
}

function ResultsInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useCurrentUser();
  const { customers } = useCustomerList();
  const superadmin = user?.role === "superadmin";

  const customerId =
    user?.role === "customer" && user.customer_id
      ? user.customer_id
      : (searchParams.get("customer_id") ?? "");
  const window_ = parseWindow(searchParams.get("window"), superadmin);
  const setWindow = (w: ResultsWindow) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("window", w);
    router.replace(`/analytics?${params.toString()}`, { scroll: false });
  };

  const q = customerId ? `customer_id=${encodeURIComponent(customerId)}` : null;
  const overview = useJson<AnalyticsOverview>(
    q ? `/admin/analytics/overview?${q}&window=${window_}` : null,
  );
  const breakdown = useJson<AnalyticsBreakdown>(
    q ? `/admin/analytics/breakdown?${q}&window=${window_}` : null,
  );
  const series = useJson<AnalyticsTimeseries>(q ? `/admin/analytics/timeseries?${q}` : null);
  const manifests = useJson<ManifestsAllResponse>(
    q ? `/admin/onboard/manifest?${q}&all=true` : null,
  );
  const proof = useProof(customerId, superadmin);
  const buttons = useButtons(customerId);
  const test = useTestAction(customerId, proof);

  const [tagOpen, setTagOpen] = React.useState(false);
  const [chooseOpen, setChooseOpen] = React.useState(false);
  // The readiness check (readiness-check mock, sections 04 and 05): the
  // day-3 traffic line in the test card, the full list in Admin. An older
  // worker gives nothing and the page is as it was.
  const readiness = useReadiness(customerId);
  const traffic = trafficLine(readiness.answer);
  const [openCheck, setOpenCheck] = React.useState<string | null>(null);
  // The sensitive-site control (site-wide-and-sensitive mock, sections 05 to
  // 07), superadmin only: the row in Admin and the readiness list's "Mark it".
  const sensitive = useSensitive(customerId, superadmin);
  const [sensitiveOpen, setSensitiveOpen] = React.useState(false);
  const readinessInPlace = (c: ReadinessCheck): (() => void) | null => {
    switch (c.id) {
      case "tag":
        return () => setOpenCheck((o) => (o === "tag" ? null : "tag"));
      case "counted":
      case "contact_hint":
        return () => setChooseOpen(true);
      case "category":
        // Opened once the flag and the list are read; until then the API's link.
        return superadmin && isMarkIt(c) && sensitive.view ? () => setSensitiveOpen(true) : null;
      default:
        return null;
    }
  };
  const readinessOpenContent =
    openCheck === "tag" ? (
      <div className="max-w-[560px]">
        <TagCopy label={TAG_LABEL} content={buildSnippet(customerId)} />
      </div>
    ) : null;

  const domain = (customers.find((c) => c.id === customerId)?.domain ?? customerId)
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!customerId) {
    return (
      <ScreenEmpty
        icon={BarChart2}
        title="Pick a customer to see their results"
        body="Choose a customer from the top bar."
      />
    );
  }

  const ov = overview.data;
  const bd = breakdown.data;
  const report = proof.report;
  const total = bd?.lead?.total_visits ?? ov?.hero.total_visits ?? 0;
  const unknownVisits = bd?.unknown?.visits ?? ov?.cohorts.no_signal.visits ?? 0;
  const steps = nextSteps({
    report,
    total,
    unknownVisits,
    pages: bd?.pages,
    manifests: manifests.data?.manifests ?? null,
  });
  const ago = updatedAgo(ov?.computed_at ?? null);
  const series30: TimeSeriesPoint[] = series.data?.series ?? [];
  const layout = report ? resultsLayout(report) : "card";
  const tooLittle = layout === "too-little";
  const whoComes = (
    <WhoComes
      breakdown={bd}
      overview={ov}
      loading={breakdown.loading}
      report={report}
      first={tooLittle}
    />
  );

  return (
    <div className="flex flex-col animate-fade-in">
      <div>
        <h1 className="text-lg font-semibold text-fg">Results</h1>
        <p className="mt-0.5 text-xs text-fg-faint">
          {domain}
          {ago ? ` · ${ago}` : ""}
        </p>
      </div>

      {tooLittle && whoComes}

      <section
        aria-labelledby="working-h"
        className={tooLittle ? "mt-10 border-t border-border pt-5" : "mt-5 sm:mt-7"}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 id="working-h" className="text-[15px] font-semibold tracking-[-0.005em] text-fg">
            Is it working?
          </h2>
          {report && (
            <TestStatus
              report={report}
              test={test}
              onChoose={() => setChooseOpen(true)}
              noAction={tooLittle}
            />
          )}
        </div>
        {report && layout === "card" && !testIsOn(report) && test.said && (
          <div aria-live="polite" className="text-right">
            <Said>{test.said}</Said>
          </div>
        )}
        <ResultsHeadline report={report} loading={proof.state === "loading"} small={tooLittle} />
        <div className="mt-4">
          {tooLittle ? (
            <div aria-live="polite">
              {/* The traffic line says it before Start anyway (readiness-check mock, A15). */}
              {traffic && <TrafficLine check={traffic} className="mb-3" />}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={test.busy !== null}
                onClick={() => void test.run("start", { anyway: true })}
              >
                {test.busy === "start" && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                )}
                Start anyway
              </Button>
              {test.said && <Said>{test.said}</Said>}
            </div>
          ) : report && layout === "setup" ? (
            <MeasureSetup
              report={report}
              items={buttons.items}
              test={test}
              onChoose={() => setChooseOpen(true)}
            />
          ) : (
            <ProofSection
              proof={proof}
              superadmin={superadmin}
              counted={countedLines(buttons.items, bd?.pages)}
              traffic={traffic}
            />
          )}
        </div>
      </section>

      <TrafficBand
        window={window_}
        onWindow={setWindow}
        superadmin={superadmin}
        overview={ov}
        loading={overview.loading}
        report={report}
      />

      {!tooLittle && whoComes}

      <NextSteps steps={steps} customerId={customerId} onTag={() => setTagOpen(true)} />

      <ResultsAdvanced
        window={window_}
        overview={ov}
        series={series30}
        byTuple={bd?.by_tuple ?? []}
        report={report}
        superadmin={superadmin}
      />

      {superadmin && (
        <ResultsAdmin
          customerId={customerId}
          domain={domain}
          proof={proof}
          afterAdvanced={!!ov}
          readiness={readiness.answer}
          readinessInPlace={readinessInPlace}
          readinessOpenId={openCheck}
          readinessOpenContent={readinessOpenContent}
          sensitive={{ data: sensitive, onOpen: () => setSensitiveOpen(true) }}
        />
      )}
      {superadmin && sensitiveOpen && sensitive.view && (
        <SensitiveDialog
          customerId={customerId}
          view={sensitive.view}
          onClose={() => setSensitiveOpen(false)}
          onSaved={(saved) => {
            sensitive.apply(saved);
            setSensitiveOpen(false);
            readiness.reload();
          }}
        />
      )}

      {tagOpen && <TaggedLinkDialog open={tagOpen} onOpenChange={setTagOpen} domain={domain} />}
      {chooseOpen && (
        <ButtonsDialog
          customerId={customerId}
          items={buttons.items}
          blocked={report ? testIsOn(report) : false}
          onClose={() => setChooseOpen(false)}
          onChanged={(items) => {
            buttons.setItems(items);
            proof.reload();
            readiness.reload();
          }}
        />
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <OldRoute>
          <Suspense fallback={null}>
            <ResultsInner />
          </Suspense>
        </OldRoute>
      </Suspense>
    </AppShell>
  );
}
