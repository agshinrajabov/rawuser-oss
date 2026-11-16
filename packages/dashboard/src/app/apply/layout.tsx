import type { Metadata } from "next";

// The apply page is reached only from an invite link (docs/specs/pilot-apply.md).
// Never indexed, and the token rides in the fragment (#t=), never in a query or a Referer.
export const metadata: Metadata = {
  title: "Apply for a pilot · Rawuser",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
