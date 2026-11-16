"use client";

import { CountWords } from "@/components/readiness/ReadinessList";
import { useReadiness } from "@/components/readiness/useReadiness";

/**
 * The customers list's one column (readiness-check mock, A19): the count of
 * red and amber lines, red first, "Ready" when neither. One read per card;
 * an older worker gives nothing and the card is as it was.
 */
export function CustomerReadiness({ customerId }: { customerId: string }) {
  const readiness = useReadiness(customerId);
  if (readiness.state !== "ok" || !readiness.answer) return null;
  return <CountWords checks={readiness.answer.checks} />;
}
