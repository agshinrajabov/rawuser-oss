import type { Metadata } from "next";

// The audit's pages (docs/specs/ai-traffic-audit.md §3.2, §6): the sign-up and
// the report open from links whose token rides in the fragment (#t=), never in
// a query or a Referer. Never indexed, no referrer, no third-party script.
export const metadata: Metadata = {
  title: "Free audit · Rawuser",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return children;
}
