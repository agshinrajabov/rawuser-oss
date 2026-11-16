/**
 * The proof engine's API shapes (docs/specs/proof-engine.md, section G).
 *
 * Built by packages/generation/src/lib/proof-report.ts, read by the
 * dashboard's "What the versions did" card and the holdout control. Counts,
 * rates and intervals per customer only; nothing about a visitor.
 *
 * Every rate is a fraction (0.094 is 9.4%), every lift a relative change
 * (0.19 is +19%), every date a UTC 'YYYY-MM-DD'.
 */

/** The card's title in every state, the negative one included (founder, 2026-10-04). */
export const PROOF_CARD_TITLE = "What the versions did";

/** Holdout percents the control offers; 50 is for a small pilot, superadmin only. */
export const HOLDOUT_CHOICES = [0, 10, 20, 50] as const;

/** The only percent a customer starts on its own (POST /admin/proof/test). */
export const CUSTOMER_TEST_PERCENT = 20;

/** Past this many weeks to read, a customer is not offered a start ("within a year"). */
export const MAX_READ_WEEKS = 52;

/** Converting visits each arm needs before a range is shown. */
export const MIN_CONVERSIONS = 10;

/**
 * - off: no test is running and none has run (or the last one was cleared).
 * - starting: switched on; its first day has not closed yet, nothing to read.
 * - not_enough: running; an arm has fewer than 30 visits or 10 converting visits.
 * - interim: running, before the read date. Grey, hatched, no extra clicks.
 * - held_back: running; the split check or the uncounted share failed.
 *   Counts only, no rate and no range.
 * - result: the read date has come; read from the first day to the day
 *   before the read date, frozen.
 * - ended: switched off on or after its read date; the result as read.
 * - ended_early: switched off before its read date; labelled inconclusive.
 */
export type ProofState =
  | "off"
  | "starting"
  | "not_enough"
  | "interim"
  | "held_back"
  | "result"
  | "ended"
  | "ended_early";

/**
 * Only on result, ended and ended_early. positive: the range is above zero;
 * negative: below zero; no_difference: it crosses zero; inconclusive: the
 * test ended early, or the read came without 10 converting visits per arm.
 */
export type ProofVerdict = "positive" | "no_difference" | "negative" | "inconclusive";

export interface ArmCounts {
  visits: number;
  converting_visits: number;
  /** converting_visits / visits, null at 0 visits. */
  rate: number | null;
}

/** A relative lift with its 95% range (Wilson per arm, log-ratio). */
export interface LiftRange {
  value: number;
  low: number;
  high: number;
}

/**
 * Who started a test (migration 0036; docs/specs/measure-at-go-live.md):
 * go_live is the first go live with the switch On; customer and superadmin
 * are a start on Results or in the Admin control. Null on tests from before
 * 0036.
 */
export type TestStartedBy = "go_live" | "customer" | "superadmin";

/**
 * Why a test ended. read_date, low_traffic and limit are the automatic ends
 * of a go-live test (the hourly proof checks, actor `system`), audit_end the
 * fourth (an audit ending without a pilot, ADR 0022 amended); customer and
 * superadmin a stop; new_test a percent change that opened another period.
 * Null while running and on tests ended before 0036.
 */
export type TestEndReason =
  | "read_date"
  | "low_traffic"
  | "limit"
  | "customer"
  | "superadmin"
  | "new_test"
  /** The running test of a free audit that ended without a pilot (ai-traffic-audit.md §3.7). */
  | "audit_end";

/** A go-live test ends after this many days in any case (privacy review condition 4). */
export const GO_LIVE_TEST_LIMIT_DAYS = 365;

export interface TestPeriod {
  id: string;
  /** 10, 20 or 50. */
  percent: number;
  started_at: number;
  ended_at: number | null;
  /**
   * Null on a test from before migration 0036. Always sent by the report;
   * optional in the type only for fixtures written before it.
   */
  started_by?: TestStartedBy | null;
  /** Null while running, and on a test ended before migration 0036. Always sent. */
  end_reason?: TestEndReason | null;
  /** First UTC day the report reads. */
  first_day: string;
  /** Last closed UTC day the report read; null before the first day closed. */
  last_day: string | null;
  /** Day of the test at computed_at, 1 on its first day. */
  day: number;
  /**
   * Fixed on day 14 and never moved after. Before: an estimate from the 30
   * days before the test, and from day 7 one from the test's own visits per
   * day ("around"). Null at no traffic yet: "A date after a week of visits".
   */
  read_date: string | null;
  read_date_fixed: boolean;
  /** Start to read date, in weeks (rounded up). */
  weeks_total: number | null;
  /** The smallest relative lift this test can tell from none by its read date. */
  readable_lift: number | null;
}

/** "If a test started now": the read time for the off state and the dialog. */
export interface ReadEstimate {
  percent: number;
  /** Weeks to read a 20% relative lift; null when there is no eligible traffic. */
  weeks: number | null;
  /** Visits with a signal and a version, per 30 days. */
  eligible_per_month: number;
  /** Their conversion rate over the last 30 days, or 3% by default. */
  baseline_rate: number;
  rate_source: "measured" | "default";
}

export interface SourceRow {
  source_dim: string;
  treat: ArmCounts;
  holdout: ArmCounts;
  /** Only when each arm in the row has 10 converting visits. No significance marks. */
  range: { low: number; high: number } | null;
}

/** The checks row: superadmin only (founder, 2026-10-04). */
export interface ProofChecks {
  /** The set holdout share, 0.2 for 20%. */
  split_set: number;
  /** Holdout visits over all visits in the test, null at none. */
  split_seen: number | null;
  /** Chi-square, one degree of freedom; below 0.001 the result is held back. */
  split_p: number | null;
  split_ok: boolean;
  /** Visits with a signal and a version but no arm, over all such visits. Over 5% holds the result back. */
  uncounted_share: number | null;
  uncounted_ok: boolean;
  /** Visits that carried both arms (a change mid-visit), left out. */
  mixed_visits: number;
}

/**
 * Why a customer's start would be refused:
 * - running: a test runs (Stop it first; the same 20% again is no change);
 * - no_button: no enabled conversion target, a test would count nothing;
 * - too_little_traffic: a 20% test would read in more than MAX_READ_WEEKS.
 */
export type StartBlock = "running" | "no_button" | "too_little_traffic";

/** What the setup steps and Start test need (docs/specs/proof-engine.md, "The customer's own test"). */
export interface TestStart {
  /** Enabled conversion targets: the buttons a test counts. */
  counted_buttons: number;
  /** POST /admin/proof/test {action: "start"} would start a test now. */
  can_start: boolean;
  /** Why not, or null when it would. The first that applies, in the order of StartBlock. */
  blocked: StartBlock | null;
  /** A 20% test at the last 30 days' traffic. `weeks` null: no eligible traffic yet (start allowed). */
  estimate: ReadEstimate;
  /**
   * The read date a 20% test started now would get, UTC 'YYYY-MM-DD', by the
   * same rule the running test uses (so it equals `test.read_date` right after
   * the start). Null while a test runs or with no eligible traffic yet.
   * An estimate: it moves with traffic and is fixed only on the test's day 14.
   */
  read_date: string | null;
}

/** GET /admin/analytics/lift?customer_id= (customer-scoped). */
export interface LiftReport {
  customer_id: string;
  title: typeof PROOF_CARD_TITLE;
  computed_at: number;
  state: ProofState;
  verdict: ProofVerdict | null;
  held_back_reason: "split" | "uncounted" | null;
  /** The confirmed buttons the test counts (their display labels). */
  metric: { kind: "cta_clicks"; labels: string[] };
  /** The card's answer in plain words, the founder-approved drafts. No dashes. */
  sentence: string;
  /** The one line under the card in every state. */
  limits: string;
  test: TestPeriod | null;
  /** Intent-to-treat: every visit as the coin assigned it. Null when there is no test. */
  arms: { treat: ArmCounts; holdout: ArmCounts } | null;
  /** not_enough only: converting visits still missing to reach 10, per arm. */
  needs: { treat: number; holdout: number } | null;
  /** Null until both arms have 30 visits and 10 converting visits, and while held back. */
  lift: (LiftRange & { interim: boolean }) | null;
  /**
   * result and ended, positive or negative verdict only: the difference in
   * rates (Newcombe) times the treat visits. Negative values are fewer clicks.
   */
  extra_clicks: { value: number; low: number; high: number } | null;
  /** result and ended: only the treat visits where the version was written, against the holdout. Runs high. */
  as_treated: { applied: ArmCounts; left_out_visits: number; lift: LiftRange | null } | null;
  /** By source: a look, not a result. */
  by_source: SourceRow[];
  /** off and starting: the read time if a 20% test started now. */
  estimate: ReadEstimate | null;
  /** Present only for a superadmin session. */
  checks?: ProofChecks;
  /** Every state. Absent only from a generation worker older than 2026-10-04. */
  start?: TestStart;
}

export interface HoldoutOption {
  percent: number;
  /** Weeks to read a 20% lift at this percent. */
  weeks: number | null;
  /** Eligible visits that would see the original, per 30 days. */
  visits_given_up_per_month: number;
  /** Clicks given up per 30 days if the versions lift clicks by 20%. */
  clicks_given_up_per_month: number;
  /** The smallest relative lift readable in eight weeks. */
  readable_lift_8w: number | null;
}

/** GET /admin/customers/holdout?customer_id= (superadmin). */
export interface HoldoutControl {
  customer_id: string;
  /** customers.holdout_percent; null means the edge's env default. */
  stored_percent: number | null;
  since: number | null;
  choices: readonly number[];
  running: {
    id: string;
    percent: number;
    started_at: number;
    read_date: string | null;
    read_date_fixed: boolean;
    /** Sent from migration 0036 on (optional only for older fixtures). */
    started_by?: TestStartedBy | null;
    /** The dashboard account id, "superadmin" or null (before 0036). */
    started_actor?: string | null;
  } | null;
  history: Array<{
    id: string;
    percent: number;
    started_at: number;
    ended_at: number | null;
    read_date: string | null;
    /** The next four are sent from migration 0036 on (optional only for older fixtures). */
    started_by?: TestStartedBy | null;
    started_actor?: string | null;
    end_reason?: TestEndReason | null;
    /** The dashboard account id, "superadmin", "system" (an automatic end) or null. */
    ended_actor?: string | null;
  }>;
  basis: {
    eligible_per_month: number;
    baseline_rate: number;
    rate_source: "measured" | "default";
    days: number;
  };
  options: HoldoutOption[];
}

/** POST /admin/customers/holdout { customer_id, percent } (superadmin). */
export interface HoldoutSetResult {
  ok: true;
  customer_id: string;
  percent: number;
  /** When the new test starts reading (the change plus 10 minutes); null when switched off. */
  since: number | null;
  test_id: string | null;
  ended_test_id: string | null;
}

/** POST /admin/proof/test { customer_id, action: "start" | "stop" } (customer-scoped). */
export interface CustomerTestResult extends HoldoutSetResult {
  /** The lift report after the change. */
  report: LiftReport;
}

/** A refused start: 409 with one plain sentence. */
export interface CustomerTestRefusal {
  error: string;
  reason: StartBlock;
}

/** GET /admin/analytics/weekly?customer_id= (superadmin): a draft, never sent by the code. */
export interface WeeklyDraft {
  customer_id: string;
  /** The Sunday whose closed days the draft reads to. */
  week_ending: string;
  state: ProofState;
  verdict: ProofVerdict | null;
  send: "draft";
  subject: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Measure at go live (docs/specs/measure-at-go-live.md, section 12)
// ---------------------------------------------------------------------------

/** One button Rawuser could count: a conversion slot of the page and its own words. */
export interface MeasureButton {
  section_path: string;
  label: string;
}

/** The quickstart record's `measure` (first go live only; an extra page has null). */
export interface MeasureProposal {
  /** Rawuser's pick; null: "No main button found". */
  proposal: MeasureButton | null;
  /** The other candidates, best first, in their own words. */
  others: MeasureButton[];
  /**
   * Each other language page the chain read. `found`: the proposed slot is on
   * that page with a selector that matched once. `slots`: every candidate slot
   * found there, so the Look row can answer for another choice.
   */
  per_language: Array<{ lang: string; path: string; found: boolean; slots: string[] }>;
  /** Closed days with rows in the 30 days before now (the tag sat on the site). */
  baseline_days: number;
  /** Weeks a 20% test would need to read; only when baseline_days >= 7. */
  estimate_weeks: number | null;
  /** True when a test at go live would be refused for traffic (estimate_weeks over 52). */
  low_traffic: boolean;
}

/**
 * Why the go live did or did not start a test, in the order the server checks:
 * extra_page, test_customer, already_ran, already_live, off, no_button,
 * low_traffic, then started.
 */
export type GoLiveTestReason =
  | "started"
  | "off"
  | "no_button"
  | "low_traffic"
  | "already_ran"
  | "already_live"
  | "extra_page"
  | "test_customer";

/** POST /admin/onboard/go-live answers these next to its other fields. */
export interface GoLiveMeasure {
  /** The counted button written at this go live, or null. */
  count: (MeasureButton & { not_found_on: string[] }) | null;
  test: {
    started: boolean;
    percent: 0 | 20;
    /** When the test starts reading (go live plus 10 minutes); null when none started. */
    since: number | null;
    reason: GoLiveTestReason;
  };
}
