"use client";

/**
 * /audit/report/: with `#t=` the report a share link opens (public); without
 * it the customer's own released report, signed in
 * (docs/specs/ai-traffic-audit.md §6; mock sections 05 to 09).
 */

import { PublicReport, ReportLoading, SignedInReport } from "@/components/audit/ReportPage";
import { useFragmentMode } from "@/components/audit/useFragmentMode";
import { Suspense } from "react";

export default function AuditReportPage() {
  const mode = useFragmentMode();
  if (mode === null) return <div className="min-h-dvh bg-[#f5f5f5]" />;
  if (mode === "public") return <PublicReport />;
  return (
    <Suspense fallback={<ReportLoading />}>
      <SignedInReport />
    </Suspense>
  );
}
