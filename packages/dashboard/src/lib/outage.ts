/**
 * A write loop meets a dead writing service (docs/specs/NEXT.md, provider
 * outage handling, 2026-09-14: the model endpoint's chat route hung for an
 * hour and "Rewrite everything" burned 45 s per attempt saying "4 to retry
 * later" without a reason). Three failures in a row that look like the
 * service, not the words, stop the loop and say why.
 */

/** True when a failed write looks like the service (timeout, dead request, 5xx), not a lint verdict. */
export function looksLikeOutage(reason: string | undefined | null): boolean {
  if (!reason) return true; // the request itself failed
  return /timeout|timed out|request failed|HTTP 5\d\d|not configured|fetch failed|network|unreachable|not answering|service_down/i.test(
    reason,
  );
}

export const OUTAGE_STOP_AFTER = 3;

export const OUTAGE_MESSAGE =
  "Stopped: the writing service is not answering (three failures in a row). Visitors keep the versions already written. Rawuser tries again by itself within six hours, or reload this page to try now.";
