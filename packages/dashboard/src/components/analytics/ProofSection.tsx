"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import { apiFetch } from "@/lib/api";
import type { CountedLine } from "@/lib/page-groups";
import type { ReadinessCheck } from "@/lib/readiness";
import type { HoldoutControl as HoldoutControlData, LiftReport } from "@/types/api";
import { PROOF_CARD_TITLE } from "@rawuser/shared";
import { useCallback, useEffect, useState } from "react";
import { ProofCard } from "./ProofCard";

/**
 * The lift report (customer-scoped) and, for a superadmin, the holdout
 * control. Read from closed days only, so neither follows the page's period
 * switch. The Results page loads them once and hands them to the headline,
 * the steps or the card, and the Admin section.
 */
export interface ProofData {
  report: LiftReport | null;
  control: HoldoutControlData | null;
  state: "loading" | "ready" | "failed";
  reload: () => void;
  /** Show a report the API just answered with (Start test, Stop test), then reload. */
  apply: (report: LiftReport) => void;
}

export function useProof(customerId: string, superadmin: boolean): ProofData {
  const [report, setReport] = useState<LiftReport | null>(null);
  const [control, setControl] = useState<HoldoutControlData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [key, setKey] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);
  const apply = useCallback((r: LiftReport) => {
    setReport(r);
    setState("ready");
    setKey((k) => k + 1);
  }, []);

  // key: a holdout change reloads both.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the reload trigger
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    setState((s) => (s === "ready" ? s : "loading"));
    apiFetch<LiftReport>(`/admin/analytics/lift?customer_id=${encodeURIComponent(customerId)}`)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    if (superadmin) {
      apiFetch<HoldoutControlData>(
        `/admin/customers/holdout?customer_id=${encodeURIComponent(customerId)}`,
      )
        .then((c) => {
          if (!cancelled) setControl(c);
        })
        .catch(() => {
          if (!cancelled) setControl(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [customerId, superadmin, key]);

  return { report, control, state, reload, apply };
}

interface ProofSectionProps {
  proof: ProofData;
  superadmin: boolean;
  /** The counted buttons under the card's title (page-groups mock, A16). */
  counted?: CountedLine[];
  /** The day-3 traffic line under them (readiness-check mock, A14, A15). */
  traffic?: ReadinessCheck | null;
  onTrafficAction?: (() => void) | null;
}

/** The card while a test runs or after it ended; the three steps replace it before the first test. */
export function ProofSection({
  proof,
  superadmin,
  counted,
  traffic = null,
  onTrafficAction = null,
}: ProofSectionProps) {
  const { report, state } = proof;

  if (state === "loading" && !report) {
    return (
      <div className="rounded-md border border-border bg-surface p-5">
        <Skeleton className="mb-2 h-3.5 w-40" />
        <Skeleton className="mb-5 h-3 w-72" />
        <Skeleton className="mb-2 h-4 w-full max-w-[560px]" />
        <Skeleton className="h-4 w-2/3 max-w-[420px]" />
      </div>
    );
  }

  if (!report) {
    // A customer never sees a broken card; a superadmin sees why it is missing.
    if (!superadmin) return null;
    return (
      <div className="rounded-md border border-border bg-surface px-5 py-4">
        <p className="text-[13px] font-semibold text-fg">{PROOF_CARD_TITLE}</p>
        <p className="mt-1 text-[13px] text-fg-muted">
          The lift report could not be read just now. Reload in a minute.
        </p>
      </div>
    );
  }

  return (
    <ProofCard
      report={report}
      superadmin={superadmin}
      counted={counted}
      traffic={traffic}
      onTrafficAction={onTrafficAction}
    />
  );
}
