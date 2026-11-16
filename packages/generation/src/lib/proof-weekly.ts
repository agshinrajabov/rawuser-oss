/**
 * The weekly message as a DRAFT for the founder (docs/specs/proof-engine.md,
 * D; founder 2026-10-04): the card's own sentences, plain text, read from
 * the closed days to the Sunday before. The code never sends it: the
 * founder reads it on the dashboard (superadmin only), edits and forwards
 * it. A negative result is never sent automatically; the founder writes
 * first. Telegram hears only that a draft is ready (code, customer, link;
 * privacy review condition 7).
 *
 * Two parts come from the install (install-config.ts): the link to the
 * card (DASHBOARD_ORIGIN) and the name under the message (OPERATOR_NAME).
 * Without one, its paragraph is left out and the rest reads as it is.
 */

import type { LiftReport, WeeklyDraft } from "@rawuser/shared";
import { DAY_MS, dayOf, dayStart } from "../cron/exposure-rollup.ts";
import { dashboardLink } from "./proof-alerts.ts";
import { shortDate } from "./proof-report.ts";

/** Midnight UTC of the Monday on or before `now`: the draft reads closed days to the Sunday before. */
export function weekCut(now: number): { asOf: number; weekEnding: string } {
  const today = dayStart(dayOf(now));
  const dow = new Date(today).getUTCDay(); // 0 Sunday, 1 Monday
  const asOf = today - ((dow + 6) % 7) * DAY_MS;
  return { asOf, weekEnding: dayOf(asOf - DAY_MS) };
}

export function buildWeeklyDraft(
  report: LiftReport,
  domain: string,
  weekEnding: string,
  dashboardOrigin: string | undefined,
  /** Who signs the message; null, nobody. */
  operator: string | null,
): WeeklyDraft {
  const link = dashboardLink(dashboardOrigin, report.customer_id);
  /** Paragraphs with a blank line between; a part the install does not have is left out. */
  const message = (...parts: Array<string | null>) =>
    parts.filter((p): p is string => p !== null).join("\n\n");
  const what =
    report.metric.labels.length === 1
      ? (report.metric.labels[0] as string)
      : "your confirmed buttons";
  const t = report.test;
  const weekOf = t
    ? `week ${Math.max(1, Math.ceil(t.day / 7))}${t.weeks_total ? ` of ${t.weeks_total}` : ""}`
    : "";
  const readOn = t?.read_date ? ` The result is read on ${shortDate(t.read_date)}.` : "";
  let subject: string;
  let body: string;
  switch (report.state) {
    case "off":
    case "starting":
      subject = `${domain}: no result to send this week`;
      body = `No test has a closed day to read on ${domain} yet, so there is nothing to send this week.\n\n${report.sentence}`;
      break;
    case "not_enough":
    case "interim":
      subject = `${domain}, ${weekOf}`;
      body = message(
        "Hi,",
        `${weekOf[0]?.toUpperCase()}${weekOf.slice(1)} of the test on ${domain}.${readOn}`,
        report.sentence,
        link ? `The card with the counts: ${link}` : null,
        `${report.limits.split(". ")[0]}.`,
        operator,
      );
      break;
    case "held_back":
      subject = `${domain}: checking the test`;
      body = message("Hi,", report.sentence, "I will write when it is fixed.", operator);
      break;
    default: {
      const v = report.verdict;
      const lift = report.lift;
      subject =
        v === "positive" && lift
          ? `${domain}: the versions lifted ${what} by ${Math.round(lift.value * 100)}%`
          : v === "negative"
            ? `${domain}: the versions did worse, pausing them`
            : v === "no_difference"
              ? `${domain}: no difference found`
              : `${domain}: the test ended without a clear answer`;
      const draftNote =
        v === "negative"
          ? "DRAFT ONLY: write to the customer yourself before anything else goes out.\n\n"
          : "";
      body =
        draftNote +
        message(
          "Hi,",
          report.sentence,
          report.limits,
          link ? `The card, with the breakdown by source: ${link}` : null,
          operator,
        );
    }
  }
  return {
    customer_id: report.customer_id,
    week_ending: weekEnding,
    state: report.state,
    verdict: report.verdict,
    send: "draft",
    subject,
    text: body,
  };
}
