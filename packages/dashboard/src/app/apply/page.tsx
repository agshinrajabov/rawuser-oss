"use client";

/**
 * /apply/#t=<token>: the private pilot apply page (docs/specs/pilot-apply.md).
 *
 * Public: no AppShell, no AuthGuard, plain fetch (apiFetch would send an
 * applicant to /login on a 401). The quiet-ledger look lives inside
 * ApplyFlow only; the dashboard's own tokens stay as they are (ADR 0014).
 */

import { ApplyFlow, ApplyLoading } from "@/components/apply/ApplyFlow";
import { Suspense } from "react";

export default function ApplyPage() {
  return (
    <Suspense fallback={<ApplyLoading />}>
      <ApplyFlow />
    </Suspense>
  );
}
