"use client";

/**
 * /audit/report/: the frozen report on the quiet ledger.
 *
 * - With `#t=` (a share link): POST /admin/audit/report/public with the token
 *   in the body; the fragment is dropped from the address bar once read.
 * - Without: signed in, GET /admin/audit/report for the customer's own id
 *   (or ?customer_id= for a superadmin).
 *
 * The page shows the snapshot only, never anything else of the customer.
 */

import { AuthGuard } from "@/components/auth/AuthGuard";
import { CurrentUserProvider, useCurrentUser } from "@/components/shell/CurrentUserContext";
import { getAuditReport, readPublicReport, takeHashToken } from "@/lib/audit-api";
import type { AuditReport } from "@rawuser/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ReportView } from "./ReportView";
import { LedgerMessage, ledgerLink, usePaper } from "./ledger";

const KICKER = "Rawuser · audit report";

export type ReportScreen =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "gone" }
  | { kind: "not_ready" }
  | { kind: "unreachable" }
  | { kind: "report"; report: AuditReport };

export function ReportLoading() {
  return (
    <LedgerMessage kicker={KICKER} title="Where your visits came from" body="Opening the report…" />
  );
}

export function ReportScreenView({
  screen,
  back,
}: {
  screen: ReportScreen;
  /** Signed in: a way back to the Audit page. */
  back?: string;
}) {
  switch (screen.kind) {
    case "loading":
      return <ReportLoading />;
    case "missing":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="This page opens from a report link."
          body="Use the link your report came with."
        />
      );
    case "gone":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="This link no longer works."
          body="Reply to the email it came with for a new one."
        />
      );
    case "not_ready":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="Your report is not ready yet."
          body={
            back ? (
              <Link href={back} className={ledgerLink}>
                See where your audit stands
              </Link>
            ) : (
              "It comes a week after you go live."
            )
          }
        />
      );
    case "unreachable":
      return (
        <LedgerMessage
          kicker={KICKER}
          title="We couldn't open this report."
          body="Rawuser did not answer. Reload the page in a minute."
        />
      );
    case "report":
      return <ReportPaper report={screen.report} back={back} />;
  }
}

function ReportPaper({ report, back }: { report: AuditReport; back?: string }) {
  usePaper();
  return (
    <main className="min-h-dvh bg-[#f5f5f5] text-[#171717] antialiased selection:bg-[#1E4737] selection:text-[#f5f5f5] print:bg-white">
      {back && (
        <div className="mx-auto max-w-[48rem] px-4 pt-5 sm:px-8 print:hidden">
          <Link href={back} className={`font-mono text-[12px] ${ledgerLink}`}>
            Back to Audit
          </Link>
        </div>
      )}
      <ReportView report={report} />
    </main>
  );
}

/** The share link: the token from the fragment, POSTed once. */
export function PublicReport() {
  const [screen, setScreen] = useState<ReportScreen>({ kind: "loading" });
  useEffect(() => {
    const t = takeHashToken();
    if (!t) {
      setScreen({ kind: "missing" });
      return;
    }
    let cancelled = false;
    readPublicReport(t)
      .then(({ status, data }) => {
        if (cancelled) return;
        if (status === 200 && data?.ok && data.report)
          setScreen({ kind: "report", report: data.report });
        else if (status === 404 || status === 400 || status === 410) setScreen({ kind: "gone" });
        else setScreen({ kind: "unreachable" });
      })
      .catch(() => {
        if (!cancelled) setScreen({ kind: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <ReportScreenView screen={screen} />;
}

function SignedInReportInner() {
  const { user, loading } = useCurrentUser();
  const params = useSearchParams();
  const customerId =
    user?.role === "customer" ? (user.customer_id ?? "") : (params.get("customer_id") ?? "");
  const [screen, setScreen] = useState<ReportScreen>({ kind: "loading" });
  useEffect(() => {
    if (loading) return;
    if (!customerId) {
      setScreen({ kind: "not_ready" });
      return;
    }
    let cancelled = false;
    getAuditReport(customerId)
      .then((r) => {
        if (!cancelled) setScreen({ kind: "report", report: r.report });
      })
      .catch((e) => {
        if (cancelled) return;
        setScreen(
          e instanceof Error && /^API error 404/.test(e.message)
            ? { kind: "not_ready" }
            : { kind: "unreachable" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [loading, customerId]);
  const back =
    user?.role === "customer" ? "/audit/" : `/audit/?customer_id=${encodeURIComponent(customerId)}`;
  return <ReportScreenView screen={screen} back={back} />;
}

export function SignedInReport() {
  return (
    <AuthGuard>
      <CurrentUserProvider>
        <SignedInReportInner />
      </CurrentUserProvider>
    </AuthGuard>
  );
}
