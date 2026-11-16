"use client";

import { ReadinessList } from "@/components/readiness/ReadinessList";
import { checksItems } from "@/lib/proof";
import {
  AS_CUSTOMER_SEES,
  NO_TAG_UNTIL_MARKED,
  type ReadinessCheck,
  type ReadinessResponse,
  SUPERADMIN_ONLY,
  visibleChecks,
} from "@/lib/readiness";
import { cn } from "@/lib/utils";
import type { LiftReport } from "@/types/api";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { BackfillControl } from "./BackfillControl";
import { ChoiceKill } from "./ChoiceKill";
import { TestSizeControl, WeeklyDraftButton } from "./HoldoutControl";
import type { ProofData } from "./ProofSection";
import {
  type SensitiveData,
  SensitiveRowLines,
  SensitiveRowValue,
  hasSensitiveLines,
} from "./SensitiveControl";

/**
 * Admin, the last block on Results, closed by default and never rendered
 * for a customer (measure-setup mock, section 05 and decision 5): the test
 * size with its cost dialog, the checks that used to sit in the card's
 * foot, Monday's draft, and the two rebuilds with plain names.
 */
export function ResultsAdmin({
  customerId,
  domain,
  proof,
  afterAdvanced,
  readiness = null,
  readinessInPlace,
  readinessOpenId = null,
  readinessOpenContent,
  sensitive = null,
  defaultOpen = false,
}: {
  customerId: string;
  domain: string;
  proof: ProofData;
  /** Sits flush under Advanced; alone it keeps the page's section gap. */
  afterAdvanced: boolean;
  /**
   * The readiness answer (readiness-check mock, A18 and A20): the full
   * list with the superadmin lines, in its own row. Null (an older
   * worker): no row.
   */
  readiness?: ReadinessResponse | null;
  readinessInPlace?: (c: ReadinessCheck) => (() => void) | null;
  readinessOpenId?: string | null;
  readinessOpenContent?: React.ReactNode;
  /**
   * The sensitive-site row (site-wide-and-sensitive mock, A14 and A17 to
   * A20): the flag, the kept sections, one button that opens the dialog.
   * Null, or a worker without the endpoint: no row.
   */
  sensitive?: { data: SensitiveData; onOpen: () => void; howOpen?: boolean } | null;
  /** For the fixtures and tests: open on arrival. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { report, control, reload } = proof;
  const checks = readiness ? visibleChecks(readiness.checks, true) : [];
  const marksFor = (c: ReadinessCheck): string[] => {
    const out: string[] = [];
    if (c.superadmin_only) out.push(SUPERADMIN_ONLY);
    if (c.id === "category" && c.state === "red" && readiness?.tag_withheld) {
      out.push(NO_TAG_UNTIL_MARKED);
    }
    return out;
  };

  return (
    <section
      className={cn(
        "border-t border-dashed border-border-strong",
        afterAdvanced ? "mt-0" : "mt-8 sm:mt-10",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="admin-body"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-baseline gap-x-3 py-3.5 text-left sm:flex-nowrap"
      >
        <span className="text-[15px] font-semibold text-fg">Admin</span>
        <span className="order-3 basis-full text-[12.5px] text-fg-muted sm:order-none sm:flex-1 sm:basis-auto">
          Only superadmins see this
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "ml-auto self-center text-fg-muted transition-transform duration-medium ease-smooth sm:ml-0",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id="admin-body"
          className="mb-2 rounded-md border border-dashed border-border-strong bg-[color-mix(in_srgb,var(--surface-muted)_55%,var(--surface))]"
        >
          <Row k="Test size">
            {control ? (
              <TestSizeControl
                customerId={customerId}
                domain={domain}
                control={control}
                report={report}
                onChanged={reload}
              />
            ) : (
              <span className="text-[12.5px] text-fg-muted">Could not be read just now.</span>
            )}
          </Row>
          {sensitive && sensitive.data.state !== "missing" && (
            <Row
              k="Sensitive site"
              below={
                hasSensitiveLines(sensitive.data) ? (
                  <SensitiveRowLines data={sensitive.data} howOpen={sensitive.howOpen} />
                ) : null
              }
            >
              <SensitiveRowValue data={sensitive.data} onOpen={sensitive.onOpen} />
            </Row>
          )}
          {readiness && checks.length > 0 && (
            <Row k="Readiness" warn={AS_CUSTOMER_SEES} top>
              <ReadinessList
                checks={checks}
                inPlace={readinessInPlace}
                openId={readinessOpenId}
                openContent={readinessOpenContent}
                marksFor={marksFor}
                className="w-full"
              />
            </Row>
          )}
          <ChoiceKill customerId={customerId}>
            {(value, below) => (
              <Row k="Visitor choice" warn="Overrides the customer" below={below}>
                {value}
              </Row>
            )}
          </ChoiceKill>
          <Row k="Checks">
            <Checks report={report} />
          </Row>
          <Row k="Weekly draft">
            <WeeklyDraftButton customerId={customerId} />
          </Row>
          <Row k="Rebuild" warn="Writes to production">
            <BackfillControl customerId={customerId} domain={domain} superadmin />
          </Row>
        </div>
      )}
    </section>
  );
}

function Row({
  k,
  warn,
  top = false,
  below = null,
  children,
}: {
  k: string;
  warn?: string;
  /** A row of lines: the key and the note sit at the top (mock .ar.top). */
  top?: boolean;
  /** A line under the row's value, across the value and the note (mock .ar .ln). */
  below?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-2 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[132px_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5",
        top ? "items-start" : "items-center",
      )}
    >
      <span
        className={cn(
          "font-mono text-[10.5px] uppercase tracking-[0.12em] text-fg-muted",
          top && "sm:pt-[5px]",
        )}
      >
        {k}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2">{children}</span>
      {warn ? (
        <span className="whitespace-nowrap text-[11px] text-fg-faint">{warn}</span>
      ) : (
        <span className="hidden sm:block" />
      )}
      {below && <div className="min-w-0 sm:col-start-2 sm:col-end-4 sm:-mt-0.5">{below}</div>}
    </div>
  );
}

function Checks({ report }: { report: LiftReport | null }) {
  const items = report?.checks ? checksItems(report.checks) : [];
  if (items.length === 0) {
    return <span className="text-[12.5px] text-fg-muted">Nothing to check until a test runs.</span>;
  }
  return (
    <span className="flex flex-col gap-0.5 font-mono text-[11.5px] tabular-nums text-fg-muted sm:flex-row sm:flex-wrap sm:gap-x-3.5 sm:gap-y-1">
      {items.map((c) => (
        <span
          key={c.text}
          style={
            c.tone === "ok"
              ? { color: "color-mix(in srgb, var(--state-success) 70%, black)" }
              : c.tone === "warn"
                ? { color: "color-mix(in srgb, var(--state-warn) 70%, black)" }
                : undefined
          }
        >
          {c.text}
        </span>
      ))}
    </span>
  );
}
