/**
 * The audit mock's made-up customer, Quoteloom at quoteloom.example
 * (design/mock/sales-readiness/ai-traffic-audit.html), as API answers. The
 * numbers add up as the mock's do: 1,240 visits, the groups sum to it.
 * Shared by the tests and the screenshot fixture server.
 */
import type { AuditReport, AuditStatus } from "@rawuser/shared";

const DAY = 24 * 60 * 60 * 1000;
/** Wed 7 Oct 2026 15:00 UTC, the window's start. */
export const START = Date.UTC(2026, 9, 7, 15);
export const SIGNED_UP = Date.UTC(2026, 9, 6, 10);

export const FULL: AuditReport = {
  v: 1,
  domain: "quoteloom.example",
  window: { start: START, end: START + 7 * DAY },
  built_at: START + 7 * DAY + 3600_000,
  state: "full",
  visits: 1240,
  answers: {
    ai: {
      visits: 52,
      share: { pct: 4, under_one: false, low: 3, high: 6 },
      names: [
        { name: "chatgpt", label: "ChatGPT", visits: 31 },
        { name: "perplexity", label: "Perplexity", visits: 9 },
      ],
      other: 12,
    },
    in_app: {
      visits: 112,
      share: { pct: 9, under_one: false, low: 7, high: 11 },
      named: 61,
      probably: 51,
    },
    no_referrer: { visits: 71, share: { pct: 6, under_one: false, low: 4, high: 8 } },
  },
  groups: [
    {
      key: "ai",
      visits: 52,
      share: { pct: 4, under_one: false, low: 3, high: 6 },
      names: [
        { name: "chatgpt", label: "ChatGPT", visits: 31 },
        { name: "perplexity", label: "Perplexity", visits: 9 },
      ],
      other: 12,
    },
    {
      key: "social",
      visits: 96,
      share: { pct: 8, under_one: false, low: 6, high: 10 },
      names: [
        { name: "instagram", label: "Instagram", visits: 34 },
        { name: "linkedin", label: "LinkedIn", visits: 27 },
        { name: "whatsapp", label: "WhatsApp", visits: 18 },
        { name: "x", label: "X", visits: 9 },
      ],
      other: 8,
    },
    {
      key: "community",
      visits: 38,
      share: { pct: 3, under_one: false, low: 2, high: 5 },
      names: [
        { name: "reddit", label: "Reddit", visits: 22 },
        { name: "hacker-news", label: "Hacker News", visits: 11 },
      ],
      other: 5,
    },
    {
      key: "search",
      visits: 310,
      share: { pct: 25, under_one: false, low: 22, high: 28 },
      names: [
        { name: "google", label: "Google", visits: 281 },
        { name: "bing", label: "Bing", visits: 18 },
      ],
      other: 11,
    },
    {
      key: "ads",
      visits: 24,
      share: { pct: 2, under_one: false, low: 1, high: 3 },
      names: [{ name: "google-ads", label: "Google Ads", visits: 19 }],
      other: 5,
    },
    {
      key: "other",
      visits: 46,
      share: { pct: 4, under_one: false, low: 2, high: 5 },
      names: [],
      other: null,
    },
    {
      key: "none",
      visits: 674,
      share: { pct: 54, under_one: false, low: 51, high: 58 },
      names: [],
      other: null,
      probably: 51,
    },
  ],
  landing: {
    ai: {
      visits: 52,
      pages: [
        { path: "/", visits: 21 },
        { path: "/vs-spreadsheets", visits: 11 },
        { path: "/pricing", visits: 9 },
        { path: "/templates", visits: 6 },
      ],
      other: 5,
    },
    no_referrer: {
      visits: 71,
      pages: [
        { path: "/", visits: 38 },
        { path: "/pricing", visits: 12 },
        { path: "/templates", visits: 9 },
        { path: "/blog/pricing-your-work", visits: 6 },
      ],
      other: 6,
    },
    all: {
      visits: 1240,
      pages: [
        { path: "/", visits: 702 },
        { path: "/pricing", visits: 188 },
        { path: "/templates", visits: 121 },
        { path: "/vs-spreadsheets", visits: 84 },
        { path: "/blog/pricing-your-work", visits: 61 },
      ],
      other: 84,
    },
  },
  sample: {
    form: "saw",
    source: { kind: "name", name: "chatgpt", label: "ChatGPT" },
    page_path: "/",
    body_id: "a1b2c3d4e5f60718",
    page_from: "page",
    versions_total: 90,
    headline: { page: "Quotes your clients *sign*.", version: "Send quotes, get a *yes* back." },
    body: {
      page: "Build a clear quote in minutes, send it as one link, and see the moment it is opened.",
      version: "Line items, terms and a sign button in one link your client can open on a phone.",
    },
    cta: { page: "Start free", version: "Make a quote" },
  },
  versions_did: { state: "too_early", visits_needed: 14400, weeks: 20 },
  saw_version: 589,
  test_running: true,
  consent_banner: true,
  versions_at_start: { written: 90, total: 90 },
};

export const COUNTS: AuditReport = {
  ...FULL,
  window: { start: START, end: START + 14 * DAY },
  state: "counts",
  visits: 184,
  answers: {
    ai: {
      visits: 9,
      share: null,
      names: [{ name: "chatgpt", label: "ChatGPT", visits: 6 }],
      other: "<5",
    },
    in_app: { visits: 14, share: null, named: 8, probably: 6 },
    no_referrer: { visits: 11, share: null },
  },
  groups: [
    {
      key: "ai",
      visits: 9,
      share: null,
      names: [{ name: "chatgpt", label: "ChatGPT", visits: 6 }],
      other: "<5",
    },
    {
      key: "social",
      visits: 21,
      share: null,
      names: [{ name: "instagram", label: "Instagram", visits: 12 }],
      other: 9,
    },
    { key: "community", visits: "<5", share: null, names: [], other: null },
    {
      key: "search",
      visits: 52,
      share: null,
      names: [{ name: "google", label: "Google", visits: 47 }],
      other: 5,
    },
    { key: "ads", visits: 0, share: null, names: [], other: null },
    { key: "other", visits: 6, share: null, names: [], other: null },
    { key: "none", visits: 92, share: null, names: [], other: null, probably: 6 },
  ],
  landing: {
    ai: { visits: 9, pages: [{ path: "/", visits: 6 }], other: "<5" },
    no_referrer: { visits: 11, pages: [{ path: "/", visits: 7 }], other: "<5" },
    all: {
      visits: 184,
      pages: [
        { path: "/", visits: 121 },
        { path: "/pricing", visits: 33 },
      ],
      other: 30,
    },
  },
  versions_did: { state: "low_traffic" },
  saw_version: 131,
  test_running: false,
  consent_banner: false,
};

export const TOO_FEW: AuditReport = {
  ...FULL,
  window: { start: START, end: START + 14 * DAY },
  state: "too_few",
  visits: 18,
  answers: null,
  groups: [],
  landing: null,
  sample: {
    ...(FULL.sample as NonNullable<AuditReport["sample"]>),
    form: "would_see",
    body_id: null,
  },
  versions_did: { state: "low_traffic" },
  saw_version: 0,
  test_running: false,
  consent_banner: false,
  versions_at_start: { written: 64, total: 90 },
};

/** The sample with a word-split headline (mock section 06 C). */
export const TEMPLATE_SAMPLE: NonNullable<AuditReport["sample"]> = {
  ...(FULL.sample as NonNullable<AuditReport["sample"]>),
  source: { kind: "group", group: "search" },
  headline: {
    page: "Quotes for designers in one link",
    template: "Quotes {g1} for {rot:designers|studios|builders}{br}{s1}in one link{/s1}",
    version: "Templates {g1} for {rot:designers|studios|builders}{br}{s1}signed online{/s1}",
  },
  body: { page: null, version: null },
  cta: { page: "Start free", version: "Pick a template" },
};

export const RESULT_LINE: AuditReport["versions_did"] = {
  state: "result",
  sentence: "Visits that saw the versions clicked Start free 25% more often.",
  lift: { value: 0.25, low: 0.1, high: 0.4 },
  labels: ["Start free"],
};

const CAPS = {
  pages_used: 3,
  pages_max: 3,
  rewrites_used: 0,
  rewrites_max: 1,
  spend_usd: 0.18,
  spend_max: 1,
  spend_used_up: false,
  pages_full: true,
  rewrite_used_up: false,
};

export const STATUS: Record<AuditStatus["stage"], AuditStatus> = {
  before_go_live: {
    customer_id: "quoteloom-example",
    domain: "quoteloom.example",
    plan: "audit",
    stage: "before_go_live",
    signed_up_at: SIGNED_UP,
    live_at: null,
    window_start: null,
    window_end: null,
    extended: false,
    day: null,
    of_days: null,
    visits_counted: null,
    written: 0,
    total: 0,
    report_due: null,
    report_built_at: null,
    report_released_at: null,
    ends_at: null,
    ends_at_latest: null,
    ended_at: null,
    delete_at: null,
    lapse_at: SIGNED_UP + 14 * DAY,
    consent_banner: true,
    pilot_terms_at: null,
    caps: { ...CAPS, pages_used: 0, spend_usd: 0, pages_full: false },
  },
  writing: {} as AuditStatus,
  counting: {} as AuditStatus,
  checking: {} as AuditStatus,
  ready: {} as AuditStatus,
  ended: {} as AuditStatus,
  lapsed: {} as AuditStatus,
  pilot: {} as AuditStatus,
};

const live = START - 3600_000;
STATUS.writing = {
  ...STATUS.before_go_live,
  stage: "writing",
  live_at: live,
  lapse_at: null,
  written: 64,
  total: 90,
  caps: { ...CAPS, spend_usd: 0.04 },
};
STATUS.counting = {
  ...STATUS.writing,
  stage: "counting",
  window_start: START,
  window_end: START + 7 * DAY,
  day: 3,
  of_days: 7,
  visits_counted: 412,
  written: 90,
  report_due: START + 7 * DAY,
  ends_at: START + 28 * DAY,
  ends_at_latest: START + 28 * DAY,
  caps: { ...CAPS, spend_usd: 0.09 },
};
STATUS.checking = {
  ...STATUS.counting,
  stage: "checking",
  day: null,
  visits_counted: 1240,
  report_built_at: START + 7 * DAY + 3600_000,
  caps: CAPS,
};
STATUS.ready = {
  ...STATUS.checking,
  stage: "ready",
  report_released_at: START + 7 * DAY + 5 * 3600_000,
  ends_at: START + 14 * DAY,
};
STATUS.ended = {
  ...STATUS.ready,
  stage: "ended",
  ended_at: START + 14 * DAY,
  delete_at: START + 67 * DAY,
};
STATUS.lapsed = {
  ...STATUS.before_go_live,
  stage: "lapsed",
  lapse_at: null,
  ended_at: SIGNED_UP + 14 * DAY,
  delete_at: SIGNED_UP + 60 * DAY,
};
STATUS.pilot = { ...STATUS.ready, stage: "pilot", plan: "pilot", pilot_terms_at: START + 11 * DAY };

/** A counting audit in its second week (the day-7 extension). */
export const EXTENDED: AuditStatus = {
  ...STATUS.counting,
  extended: true,
  day: 9,
  of_days: 14,
  visits_counted: 214,
  window_end: START + 14 * DAY,
  report_due: START + 14 * DAY,
};

/** A writing audit stopped at its $1.00. */
export const SPEND_CAP: AuditStatus = {
  ...STATUS.writing,
  written: 71,
  caps: { ...CAPS, spend_usd: 1, spend_used_up: true },
};

export const REVIEW = {
  status: STATUS.checking,
  report: FULL,
  review: {
    no_marker_rows: 26,
    rows: 1312,
    checks: [
      { id: "adds_up" as const, ok: true, line: "Groups add up to 1,240." },
      { id: "floors" as const, ok: true, line: "Every name and page has 5 visits or more." },
      { id: "sample" as const, ok: true, line: "The sample's words are the version served most." },
      { id: "page_read" as const, ok: true, line: "The page's own hero was read from the page." },
      { id: "no_lift" as const, ok: true, line: "No lift shown; the test is too early." },
    ],
  },
  built_at: STATUS.checking.report_built_at,
  released_at: null,
  expires_at: null,
  revoked_at: null,
  can_make_pilot: false,
};

/** Now for the fixtures: day 3 of the counting window. */
export const NOW = START + 2 * DAY + 6 * 3600_000;
