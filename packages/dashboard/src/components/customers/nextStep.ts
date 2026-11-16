import { formatDistanceToNow } from "@/lib/time";
import type { CustomerListItem } from "@/types/api";

export type NextStepIntent = "do" | "live";

export type NextStep = {
  label: string;
  detail?: string;
  href: string;
  intent: NextStepIntent;
};

export function nextStep(c: CustomerListItem): NextStep {
  const qs = `?customer_id=${encodeURIComponent(c.id)}`;
  // Script-first: the page comes first. One tag, one look at the page, one
  // preview; the brief is drafted from the page and confirmed on the same
  // screen (docs/specs/script-first-onboarding.md).
  if (!c.has_confirmed_manifest) {
    if (c.preview_seen_at)
      return {
        label: "Confirm three things and go live",
        detail: "Parts of the page, the numbers it read, the language",
        href: `/start${qs}`,
        intent: "do",
      };
    return {
      label: "Connect their page",
      detail: "Paste the tag, open the page once, see the first version",
      href: `/start${qs}`,
      intent: "do",
    };
  }
  if (!c.has_dna)
    return {
      label: "Fill in the product brief",
      detail: "Product, audience, value props, voice",
      href: `/dna${qs}`,
      intent: "do",
    };
  if (c.variants_ready_count === 0 && !c.live_at)
    return {
      label: "Go live",
      detail: "One button; the versions are written right after",
      href: `/start${qs}`,
      intent: "do",
    };
  // The probe fetches their page every six hours; a tag that was removed or
  // edited (another customer id) shows here until it is back.
  if (c.snippet_status === "removed")
    return {
      label: "The tag is missing from their page",
      detail: "Removed or edited since the last check; paste it again",
      href: `/onboard${qs}`,
      intent: "do",
    };
  if (c.variants_ready_count === 0)
    return {
      label: "Write the page versions (~$0.45)",
      detail: "One version per audience, written from the brief and the page",
      href: `/variants${qs}`,
      intent: "do",
    };
  if (c.events_7d === 0)
    return {
      label: "Share the snippet with the customer",
      detail: "One <script> tag to paste into their <head>",
      href: `/onboard${qs}`,
      intent: "do",
    };
  if (c.events_24h === 0)
    return {
      label: "Quiet day. No visits in the last 24h, but they're set up",
      detail: `${c.events_7d} visits in last 7d · last seen ${formatDistanceToNow(c.last_event_at ?? Date.now())}`,
      href: `/variants${qs}`,
      intent: "live",
    };
  // F12: the "Live traffic" checklist row already shows
  // "{events_24h} visits in last 24h" — so the footer must NOT repeat that
  // string. Surface complementary info (last-seen recency) instead.
  return {
    label: "Customer is live",
    detail: `Live · last seen ${formatDistanceToNow(c.last_event_at ?? Date.now())}`,
    href: `/variants${qs}`,
    intent: "live",
  };
}
