/**
 * The mock's example of a prospect's site (design/mock/sales-readiness/proof-engine.html)
 * as LiftReport and HoldoutControl answers, one per state. The sentences are
 * the generation worker's (packages/generation/src/lib/proof-report.ts) for
 * these counts. Used by proof.test.ts and by the browser check of the card.
 */

import type { HoldoutControl, LiftReport } from "../../src/types/api";

const LIMITS =
  "Counts clicks on your confirmed buttons, not signups or revenue. Covers visits that had a signal and a written version, not your whole site. Says what happened in this period, not what will happen.";

const STARTED = Date.parse("2026-09-07T09:20:00Z");

function base(over: Partial<LiftReport>): LiftReport {
  return {
    customer_id: "brisk",
    title: "What the versions did",
    computed_at: Date.parse("2026-10-03T12:00:00Z"),
    state: "off",
    verdict: null,
    held_back_reason: null,
    metric: { kind: "cta_clicks", labels: ["Start free"] },
    sentence: "",
    limits: LIMITS,
    test: null,
    arms: null,
    needs: null,
    lift: null,
    extra_clicks: null,
    as_treated: null,
    by_source: [],
    estimate: null,
    ...over,
  };
}

const CHECKS = {
  split_set: 0.2,
  split_seen: 0.201,
  split_p: 0.62,
  split_ok: true,
  uncounted_share: 0.009,
  uncounted_ok: true,
  mixed_visits: 4,
};

const TEST_RUNNING = {
  id: "ht_1",
  percent: 20,
  started_at: STARTED,
  ended_at: null,
  first_day: "2026-09-07",
  last_day: "2026-10-02",
  day: 27,
  read_date: "2026-11-16",
  read_date_fixed: true,
  weeks_total: 10,
  readable_lift: 0.2,
};

const BY_SOURCE: LiftReport["by_source"] = [
  {
    source_dim: "organic",
    treat: { visits: 4210, converting_visits: 391, rate: 0.0929 },
    holdout: { visits: 1046, converting_visits: 82, rate: 0.0784 },
    range: { low: -0.06, high: 0.49 },
  },
  {
    source_dim: "social",
    treat: { visits: 2980, converting_visits: 262, rate: 0.0879 },
    holdout: { visits: 752, converting_visits: 55, rate: 0.0731 },
    range: { low: -0.09, high: 0.59 },
  },
  {
    source_dim: "ai",
    treat: { visits: 1420, converting_visits: 182, rate: 0.128 },
    holdout: { visits: 351, converting_visits: 33, rate: 0.094 },
    range: { low: -0.04, high: 0.94 },
  },
  {
    source_dim: "direct",
    treat: { visits: 731, converting_visits: 65, rate: 0.0889 },
    holdout: { visits: 174, converting_visits: 8, rate: 0.046 },
    range: null,
  },
];

export const REPORTS = {
  off: base({
    state: "off",
    sentence:
      "No test is running, so there is no measured result yet. A test shows your original page to 1 in 5 of the visits that would get a version, picked at random, and compares the two groups. At your traffic it takes about 10 weeks to read.",
    estimate: {
      percent: 20,
      weeks: 10,
      eligible_per_month: 6000,
      baseline_rate: 0.08,
      rate_source: "measured",
    },
  }),
  not_enough: base({
    state: "not_enough",
    sentence:
      "Not enough clicks yet to say anything. 7 of the 118 visits that saw your original clicked Start free, and 41 of the 489 that saw a version. A range means something once each group has 10 clicks.",
    test: {
      ...TEST_RUNNING,
      first_day: "2026-09-30",
      last_day: "2026-10-02",
      day: 3,
      read_date: "2026-12-07",
      read_date_fixed: false,
    },
    arms: {
      treat: { visits: 489, converting_visits: 41, rate: 0.0838 },
      holdout: { visits: 118, converting_visits: 7, rate: 0.0593 },
    },
    needs: { treat: 0, holdout: 3 },
    checks: { ...CHECKS, split_seen: 0.194, uncounted_share: 0.007, mixed_visits: 0 },
  }),
  interim: base({
    state: "interim",
    sentence:
      "Interim, week 4 of 10. Versions 9.4%, original 7.8%, so far +19% (range -5% to +50%). This moves week to week, so do not decide on it yet.",
    test: TEST_RUNNING,
    arms: {
      treat: { visits: 4154, converting_visits: 389, rate: 0.0936 },
      holdout: { visits: 1046, converting_visits: 82, rate: 0.0784 },
    },
    lift: { value: 0.19, low: -0.05, high: 0.5, interim: true },
    by_source: BY_SOURCE,
    checks: CHECKS,
  }),
  positive: base({
    state: "result",
    verdict: "positive",
    sentence:
      "Visits that saw Rawuser's versions clicked Start free 25% more often than visits that saw your original page (likely between 8% and 44% more). 14,000 visits from 7 Sep to 15 Nov; 1 in 5 saw the original, picked at random.",
    test: { ...TEST_RUNNING, day: 71, last_day: "2026-11-15" },
    arms: {
      treat: { visits: 11206, converting_visits: 1076, rate: 0.096 },
      holdout: { visits: 2794, converting_visits: 215, rate: 0.077 },
    },
    lift: { value: 0.25, low: 0.08, high: 0.44, interim: false },
    extra_clicks: { value: 210, low: 80, high: 340 },
    as_treated: {
      applied: { visits: 10758, converting_visits: 1040, rate: 0.0967 },
      left_out_visits: 448,
      lift: { value: 0.26, low: 0.1, high: 0.45 },
    },
    by_source: BY_SOURCE,
    checks: { ...CHECKS, split_seen: 0.2, uncounted_share: 0.008, mixed_visits: 11 },
  }),
  no_difference: base({
    state: "result",
    verdict: "no_difference",
    sentence:
      "We did not find a difference. The effect is somewhere between -8% and +21%, so the versions may help a little, do nothing, or hurt a little. 14,000 visits from 7 Sep to 15 Nov; 1 in 5 saw the original, picked at random.",
    test: { ...TEST_RUNNING, day: 71, last_day: "2026-11-15" },
    arms: {
      treat: { visits: 11206, converting_visits: 934, rate: 0.0833 },
      holdout: { visits: 2794, converting_visits: 221, rate: 0.0791 },
    },
    lift: { value: 0.05, low: -0.08, high: 0.21, interim: false },
    as_treated: {
      applied: { visits: 10758, converting_visits: 900, rate: 0.0837 },
      left_out_visits: 448,
      lift: { value: 0.06, low: -0.07, high: 0.22 },
    },
    checks: { ...CHECKS, split_seen: 0.2, uncounted_share: 0.008, mixed_visits: 9 },
  }),
  negative: base({
    state: "result",
    verdict: "negative",
    sentence:
      "Visits that saw the versions clicked Start free less often, 15% fewer (between 2% and 27% fewer). We recommend pausing the versions while we look at why. 14,000 visits from 7 Sep to 15 Nov; 1 in 5 saw the original, picked at random.",
    test: { ...TEST_RUNNING, day: 71, last_day: "2026-11-15" },
    arms: {
      treat: { visits: 11206, converting_visits: 768, rate: 0.0685 },
      holdout: { visits: 2794, converting_visits: 226, rate: 0.0809 },
    },
    lift: { value: -0.15, low: -0.27, high: -0.02, interim: false },
    extra_clicks: { value: -140, low: -270, high: -20 },
    checks: { ...CHECKS, split_seen: 0.2, uncounted_share: 0.008, mixed_visits: 7 },
  }),
  held_back: base({
    state: "held_back",
    held_back_reason: "split",
    sentence:
      "The split looks off. We are checking it before showing a result. The test is set to show your original to 1 in 5 visits; so far 1,239 of 5,200 did.",
    test: TEST_RUNNING,
    arms: {
      treat: { visits: 3961, converting_visits: 370, rate: null },
      holdout: { visits: 1239, converting_visits: 98, rate: null },
    },
    checks: {
      ...CHECKS,
      split_seen: 0.238,
      split_p: 0.00001,
      split_ok: false,
      mixed_visits: 0,
    },
  }),
  ended: base({
    state: "ended",
    verdict: "positive",
    sentence:
      "Test ended on 16 Nov. Every visit with a signal gets a version again. The result as read on 16 Nov: Visits that saw Rawuser's versions clicked Start free 25% more often than visits that saw your original page (likely between 8% and 44% more). 14,000 visits from 7 Sep to 15 Nov; 1 in 5 saw the original, picked at random.",
    test: {
      ...TEST_RUNNING,
      ended_at: Date.parse("2026-11-16T10:00:00Z"),
      day: 71,
      last_day: "2026-11-15",
    },
    arms: {
      treat: { visits: 11206, converting_visits: 1076, rate: 0.096 },
      holdout: { visits: 2794, converting_visits: 215, rate: 0.077 },
    },
    lift: { value: 0.25, low: 0.08, high: 0.44, interim: false },
    extra_clicks: { value: 210, low: 80, high: 340 },
    by_source: BY_SOURCE,
  }),
  ended_early: base({
    state: "ended_early",
    verdict: "inconclusive",
    sentence:
      "Inconclusive at the end of the test. The test stopped on 2 Nov, before its read date, with the effect somewhere between -3% and +33%. Every visit with a signal gets a version again.",
    test: {
      ...TEST_RUNNING,
      ended_at: Date.parse("2026-11-02T10:00:00Z"),
      day: 57,
      last_day: "2026-11-01",
    },
    arms: {
      treat: { visits: 8970, converting_visits: 780, rate: 0.087 },
      holdout: { visits: 2230, converting_visits: 171, rate: 0.077 },
    },
    lift: { value: 0.13, low: -0.03, high: 0.33, interim: false },
  }),
} satisfies Record<string, LiftReport>;

export const CONTROL_OFF: HoldoutControl = {
  customer_id: "brisk",
  stored_percent: 0,
  since: null,
  choices: [0, 10, 20, 50],
  running: null,
  history: [],
  basis: { eligible_per_month: 6000, baseline_rate: 0.08, rate_source: "measured", days: 30 },
  options: [
    {
      percent: 10,
      weeks: 18,
      visits_given_up_per_month: 600,
      clicks_given_up_per_month: 10,
      readable_lift_8w: 0.31,
    },
    {
      percent: 20,
      weeks: 10,
      visits_given_up_per_month: 1200,
      clicks_given_up_per_month: 19,
      readable_lift_8w: 0.24,
    },
    {
      percent: 50,
      weeks: 7,
      visits_given_up_per_month: 3000,
      clicks_given_up_per_month: 48,
      readable_lift_8w: 0.17,
    },
  ],
};

export const CONTROL_RUNNING: HoldoutControl = {
  ...CONTROL_OFF,
  stored_percent: 20,
  since: STARTED,
  running: {
    id: "ht_1",
    percent: 20,
    started_at: STARTED,
    read_date: "2026-11-16",
    read_date_fixed: true,
  },
  history: [
    { id: "ht_1", percent: 20, started_at: STARTED, ended_at: null, read_date: "2026-11-16" },
  ],
};
