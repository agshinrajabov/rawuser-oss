"use client";

/**
 * Test (design/mock/dashboard-v2/app.html, section 04): one sentence and two
 * bars. Three states: running, answer ready, not started. The buttons that
 * count live here, because they exist for the test and lock while it runs.
 * Every call is the one Results made: GET /admin/analytics/lift, POST
 * /admin/proof/test, and the conversions list and its switches.
 */

import { type TestAction, useButtons, useTestAction } from "@/components/analytics/MeasureSetup";
import { useProof } from "@/components/analytics/ProofSection";
import { StopDialog } from "@/components/analytics/TestStatus";
import { ButtonList } from "@/components/conversions/ButtonList";
import { useSitePick } from "@/components/conversions/useSitePick";
import { TrafficLine } from "@/components/readiness/TrafficLine";
import { useReadiness } from "@/components/readiness/useReadiness";
import { Button } from "@/components/ui/Button";
import { countedButtons, resultsLayout, setupSteps, testIsOn, testStatus } from "@/lib/measure";
import { armRows, figureFor, heldBackBox, howItWorks, timelineFor } from "@/lib/proof";
import { trafficLine } from "@/lib/readiness";
import { TOO_LITTLE_HEADLINE, headlineFor } from "@/lib/results";
import { withCustomer } from "@/lib/routes";
import { LIST_EMPTY } from "@/lib/site-pick";
import { footLine, offLine, testPill } from "@/lib/test-screen";
import { cn } from "@/lib/utils";
import type { ConversionTarget, LiftReport } from "@/types/api";
import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BigLine, Card, How, PageHead, Pill, SectionHead, StateLine, TONE } from "./parts";

function Arms({ report }: { report: LiftReport }) {
  const rows = armRows(report);
  if (!rows) return null;
  return (
    <div className="grid max-w-[640px] grid-cols-[92px_minmax(40px,1fr)_44px] items-center gap-x-3 gap-y-2.5 sm:grid-cols-[132px_minmax(0,1fr)_52px_auto]">
      {rows.map((r) => (
        <div key={r.name} className="contents">
          <span className="text-[13px]">{r.original ? "Your original page" : "Saw a version"}</span>
          <span className="relative h-2 overflow-hidden rounded-pill bg-surface-muted">
            <i
              className={cn(
                "absolute inset-y-0 left-0 rounded-pill",
                r.original ? "bg-fg-faint" : "bg-fg",
              )}
              style={{ width: `${r.width}%` }}
            />
          </span>
          <span className="text-right font-mono text-[13px] font-medium">{r.value}</span>
          <span className="col-start-2 col-end-[-1] -mt-1.5 whitespace-nowrap font-mono text-xs text-fg-muted sm:col-auto sm:mt-0">
            {r.counts.includes(" of ") ? `${r.counts} visits` : r.counts}
          </span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ report }: { report: LiftReport }) {
  const t = timelineFor(report);
  if (!t) return null;
  return (
    <div className="mt-[22px] max-w-[640px]">
      <div className="relative h-3.5">
        <span className="absolute inset-x-0 top-1.5 h-0.5 bg-border" />
        <span className="absolute left-0 top-1.5 h-0.5 bg-fg" style={{ width: `${t.done}%` }} />
        <span
          className="absolute top-0.5 -ml-[5px] h-2.5 w-2.5 rounded-full bg-fg"
          style={{ left: `${t.done}%` }}
        />
        <span
          className={cn(
            "absolute right-0 top-0.5 h-2.5 w-2.5 rounded-full border-[1.5px] bg-surface",
            t.ring === "estimate"
              ? "border-dashed border-fg"
              : t.ring === "fixed"
                ? "border-fg"
                : "border-fg-faint",
          )}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 font-mono text-[11px] text-fg-muted">
        <span>{t.start}</span>
        {t.mid && <span className="hidden sm:inline">{t.mid}</span>}
        <span className="text-right">{t.end}</span>
      </div>
    </div>
  );
}

function Figure({ report }: { report: LiftReport }) {
  const f = figureFor(report);
  if (!f) return null;
  return (
    <div>
      <p className="text-xs text-fg-muted">{f.key}</p>
      <p
        className={cn(
          "mt-1 font-mono text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]",
          f.ink === "ok" && TONE.OK_TEXT,
          f.ink === "muted" && "text-fg-muted",
          f.ink === "err" && "text-state-err",
        )}
      >
        {f.big ?? "Not yet"}
        {f.small && (
          <small className="ml-1.5 font-sans text-[13px] font-medium tracking-normal text-fg-muted">
            {f.small}
          </small>
        )}
      </p>
      <p className="mt-1 text-xs text-fg-muted">{f.range}</p>
      {f.earn && (
        <p className="mt-3.5 border-t border-border pt-3 text-[13px] leading-normal">
          {f.earn.strong && <b className="font-medium">{f.earn.strong}</b>}
          {f.earn.rest}
        </p>
      )}
    </div>
  );
}

export function ResultCard({
  report,
  onStop,
  onStartAgain,
  busy,
}: {
  report: LiftReport;
  onStop: () => void;
  onStartAgain: (() => void) | null;
  busy: boolean;
}) {
  const held = heldBackBox(report);
  const on = testIsOn(report);
  return (
    <Card className="mt-5">
      <div className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-[minmax(0,1fr)_260px] sm:gap-10 sm:px-5 sm:py-[18px]">
        <div>
          {held ? (
            <p
              className={cn("rounded-sm px-3 py-2.5 text-[12.5px]", TONE.WARN_TINT, TONE.WARN_TEXT)}
            >
              {held.text}
            </p>
          ) : (
            <Arms report={report} />
          )}
          <Timeline report={report} />
          <How summary="How sure is this?">
            {howItWorks(report).map((h) => (
              <p key={h.k}>{h.text}</p>
            ))}
          </How>
        </div>
        <Figure report={report} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-fg-muted sm:px-5">
        <span>{footLine(report)}</span>
        {on ? (
          <button
            type="button"
            onClick={onStop}
            className="text-fg underline decoration-dotted underline-offset-[3px]"
          >
            Stop test
          </button>
        ) : onStartAgain ? (
          <button
            type="button"
            onClick={onStartAgain}
            disabled={busy}
            className="text-fg underline decoration-dotted underline-offset-[3px] disabled:opacity-50"
          >
            {busy ? "Starting" : "Run a new test"}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

export function SetupSteps({
  report,
  items,
  test,
}: {
  report: LiftReport;
  items: ConversionTarget[] | null;
  test: TestAction;
}) {
  const s = setupSteps(report, items, Date.now());
  const counted = countedButtons(items).length;
  const step = (
    n: number,
    done: boolean,
    title: string,
    line: string,
    action?: React.ReactNode,
  ) => (
    <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:px-5 [&+&]:border-t [&+&]:border-border">
      <span
        className={cn(
          "flex h-[22px] w-[22px] items-center justify-center rounded-full border font-mono text-[11px]",
          done ? "border-fg bg-fg text-cta-fg" : "border-border-strong text-fg-muted",
        )}
      >
        {done ? <Check size={12} aria-hidden /> : n}
      </span>
      <div>
        <p className="text-[13.5px] font-medium">{title}</p>
        <p className="mt-px text-[12.5px] text-fg-muted">{line}</p>
      </div>
      {action && <div className="col-start-2 justify-self-start sm:col-start-3">{action}</div>}
    </div>
  );
  return (
    <Card className="mt-5 py-1">
      {step(
        1,
        s.choose.mode === "done",
        "Choose the buttons that count",
        counted > 0
          ? `${counted} ${counted === 1 ? "button" : "buttons"} chosen, below.`
          : s.choose.line,
      )}
      {step(
        2,
        false,
        "Start the test",
        s.start.line,
        s.start.button ? (
          <Button
            type="button"
            variant={s.start.button.primary ? "default" : "secondary"}
            disabled={!s.start.button.enabled || test.busy !== null}
            onClick={() => void test.run("start")}
          >
            {test.busy === "start" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Start test
          </Button>
        ) : undefined,
      )}
      {step(3, false, "Get the answer", s.result.line)}
    </Card>
  );
}

/** The screen with its reads. */
export function Test({ customerId, superadmin }: { customerId: string; superadmin: boolean }) {
  const proof = useProof(customerId, false);
  const buttons = useButtons(customerId);
  const test = useTestAction(customerId, proof);
  const readiness = useReadiness(customerId);
  const pick = useSitePick(customerId, buttons.items, (items) => {
    buttons.setItems(items);
    proof.reload();
  });
  const [stopping, setStopping] = useState(false);
  const report = proof.report;

  const head = (
    <PageHead title="Test" sub="Do your versions bring more clicks than your original page?" />
  );
  if (!report) {
    return (
      <div className="flex flex-col">
        {head}
        {proof.state === "failed" ? (
          <StateLine kind="error">Could not read the test. Reload to try again.</StateLine>
        ) : (
          <StateLine kind="loading">Reading the test</StateLine>
        )}
      </div>
    );
  }

  const layout = resultsLayout(report);
  const pill = testPill(report);
  const status = testStatus(report, Date.now());
  const traffic = trafficLine(readiness.answer);
  const locked = testIsOn(report);

  let body: React.ReactNode;
  if (layout === "too-little") {
    body = (
      <>
        <BigLine className="mt-5 sm:mt-6" lead={TOO_LITTLE_HEADLINE} quiet />
        <div className="mt-4" aria-live="polite">
          {traffic && <TrafficLine check={traffic} className="mb-3" />}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={test.busy !== null}
            onClick={() => void test.run("start", { anyway: true })}
          >
            {test.busy === "start" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Start anyway
          </Button>
        </div>
      </>
    );
  } else if (layout === "setup") {
    const l = offLine(report, Date.now());
    body = (
      <>
        <BigLine className="mt-5 sm:mt-6" lead={l.lead} tail={l.tail} />
        <SetupSteps report={report} items={buttons.items} test={test} />
      </>
    );
  } else {
    const h = headlineFor(report);
    body = (
      <>
        {pill && (
          <div className="mt-6">
            <Pill tone={pill.tone} live={pill.live}>
              {pill.text}
            </Pill>
          </div>
        )}
        <BigLine className="mt-2.5" lead={h.lead} tail={h.tail} quiet={!h.final} />
        {traffic && locked && <TrafficLine check={traffic} className="mt-3" />}
        <ResultCard
          report={report}
          onStop={() => setStopping(true)}
          onStartAgain={status.action === "start-again" ? () => void test.run("start") : null}
          busy={test.busy !== null}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col animate-fade-in">
      {head}
      {body}
      {test.said && !stopping && (
        <p aria-live="polite" className={cn("mt-2 text-[12.5px]", TONE.WARN_TEXT)}>
          {test.said}
        </p>
      )}

      <SectionHead
        title="Buttons that count"
        side="A click on any of these counts here and on Visitors"
      />
      <Card className="mt-3 px-4 pb-3 sm:px-5 [&>ul]:mt-0 [&>ul]:border-t-0 [&>ul>li:last-child]:border-b-0">
        {buttons.items === null ? (
          <p className="py-3 text-[13px] text-fg-muted">Reading your buttons</p>
        ) : (
          <>
            {buttons.items.length === 0 && (
              <p className="pt-3 text-[13px] text-fg-muted">{LIST_EMPTY}</p>
            )}
            <ButtonList
              customerId={customerId}
              items={buttons.items}
              blocked={locked}
              onItems={(items) => {
                buttons.setItems(items);
                proof.reload();
                readiness.reload();
              }}
              pick={pick}
              here
            />
          </>
        )}
      </Card>

      <How summary="How the test works">
        <p>
          1 in 5 visits we would show a version to sees your original page instead, chosen at
          random.
        </p>
        <p>We compare how often each group clicks a button that counts.</p>
        <p>We give the answer only when it is unlikely to be luck.</p>
      </How>

      {superadmin && (
        <p className="mt-6 text-xs text-fg-muted">
          Admin: test size, checks and the weekly draft are on{" "}
          <Link
            href={withCustomer("/analytics", customerId)}
            className="text-fg underline decoration-dotted underline-offset-[3px]"
          >
            Results, full
          </Link>
          .
        </p>
      )}

      {stopping && (
        <StopDialog
          report={report}
          test={test}
          onClose={() => {
            setStopping(false);
            test.clear();
          }}
        />
      )}
    </div>
  );
}
