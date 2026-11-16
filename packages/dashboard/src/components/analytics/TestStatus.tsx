"use client";

import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { showsChangeButton, stopConfirm, testStatus } from "@/lib/measure";
import { cn } from "@/lib/utils";
import type { LiftReport } from "@/types/api";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { QuietButton, type TestAction } from "./MeasureSetup";

/**
 * "Test: On" and "Test: Off" in the "Is it working?" row, the only test
 * words a customer sees (measure-setup mock, section 03 and decision 4).
 * Beside On, a quiet Stop test that asks once; beside Off after a test, a
 * quiet Start again (founder's call 7), and a quiet Change button that
 * opens the button list (privacy review, measure-at-go-live.md section 9,
 * item 8).
 */
export function TestStatus({
  report,
  test,
  onChoose,
  noAction = false,
}: {
  report: LiftReport;
  test: TestAction;
  onChoose: () => void;
  /** Too little traffic: Start anyway sits under the line instead (measure-at-go-live mock 06 D). */
  noAction?: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const full = testStatus(report, Date.now());
  const status = noAction ? { ...full, action: null } : full;
  const change = showsChangeButton(report, noAction, Date.now());

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-fg-muted">
      <i
        aria-hidden
        className={cn(
          "inline-block h-[7px] w-[7px] rounded-full border-[1.5px]",
          status.on ? "border-fg bg-fg" : "border-fg-faint",
        )}
      />
      <span>
        Test: <b className="font-medium text-fg">{status.on ? "On" : "Off"}</b>
      </span>
      {status.action && (
        <span aria-hidden className="text-border-strong">
          ·
        </span>
      )}
      {status.action === "stop" && (
        <QuietButton onClick={() => setStopping(true)}>Stop test</QuietButton>
      )}
      {status.action === "start-again" && (
        <QuietButton onClick={() => void test.run("start")} disabled={test.busy !== null}>
          {test.busy === "start" ? "Starting" : "Start again"}
        </QuietButton>
      )}
      {status.action === "choose" && <QuietButton onClick={onChoose}>Choose button</QuietButton>}
      {change && (
        <>
          <span aria-hidden className="text-border-strong">
            ·
          </span>
          <QuietButton onClick={onChoose}>Change button</QuietButton>
        </>
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
    </span>
  );
}

export function StopDialog({
  report,
  test,
  onClose,
}: {
  report: LiftReport;
  test: TestAction;
  onClose: () => void;
}) {
  const c = stopConfirm(report);
  const busy = test.busy === "stop";

  async function stop() {
    if (await test.run("stop")) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-[380px] p-5">
        <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">Stop the test?</DialogTitle>
        <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
          {c.line}
        </DialogDescription>
        {test.said && (
          <p
            aria-live="polite"
            className="mt-2 text-[12.5px] leading-normal text-[color:color-mix(in_srgb,var(--state-warn)_70%,black)]"
          >
            {test.said}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={busy}>
            Keep it running
          </Button>
          <Button
            type="button"
            size="sm"
            variant={c.danger ? "destructive" : "default"}
            onClick={() => void stop()}
            disabled={busy}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Stop test
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
