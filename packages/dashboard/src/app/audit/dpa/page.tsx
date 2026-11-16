import { AuditDpaView } from "@/components/audit/AuditDpa";
import type { Metadata } from "next";

// Under the /audit layout: never indexed, no referrer (and /audit/* in _headers).
export const metadata: Metadata = {
  title: "Data processing agreement · Rawuser",
};

/** /audit/dpa/: the DPA the audit terms' term 2 makes part of the audit. */
export default function AuditDpaPage() {
  return <AuditDpaView />;
}
