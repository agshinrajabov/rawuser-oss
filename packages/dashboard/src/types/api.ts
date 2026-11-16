import type { AuditStatus, GoLiveMeasure, InlineShape, MeasureProposal } from "@rawuser/shared";
/**
 * Request / response shapes for the admin API.
 * Mirrors what the generation worker returns — no runtime validation,
 * these are TypeScript-only contracts.
 */

import type {
  ArmCounts,
  BusinessDNA,
  LiftRange,
  ResultsBreakdownFields,
  ResultsOverviewFields,
  VariantBody,
} from "@rawuser/shared";

export type { BusinessDNA, VariantBody };

export type OnboardingStage =
  | "new"
  | "dna_filled"
  | "variants_generated"
  | "snippet_installed"
  | "live";

export interface CustomerListItem {
  id: string;
  slug: string;
  domain: string;
  plan: string;
  status: string;
  created_at: number;
  onboarding_stage: OnboardingStage;
  last_activity_at: number | null;
  contact_email: string | null;
  contact_name: string | null;
  /** True when a confirmed (non-draft) brief exists. */
  has_dna: boolean;
  has_confirmed_manifest: boolean;
  /** Script-first funnel stamps (per customer, NULL until the step happens). */
  tag_seen_at?: number | null;
  preview_seen_at?: number | null;
  live_at?: number | null;
  /**
   * Languages discovered at quickstart, with the customer's consent flag.
   * Since 2026-10-12 also the languages the site serves on the same address
   * (`path: null`): read through `withPage` (lib/languages.ts), never
   * counted or ticked.
   */
  languages?: StoredLanguage[];
  variants_ready_count: number;
  variants_last_generated_at: number | null;
  events_24h: number;
  events_7d: number;
  last_event_at: number | null;
  // F17: snippet liveness — null until the probe has run at least once for this customer
  snippet_status?: "active" | "stale" | "removed" | "never" | "unknown";
  snippet_status_probed_at?: number | null;
  snippet_status_last_event_at?: number | null;
}

export interface VariantListItem {
  intent_dim: string;
  source_dim: string;
  /** The page this variant targets (A1 per-path). Defaults to '/'. */
  page_path: string;
  model: string;
  generated_at: number;
  cost_usd: number;
  /**
   * `pending`: no live body, a new one waits for the customer's OK;
   * `discarded`: no live body, the customer discarded the waiting one
   * (docs/specs/versions-approval.md §2). A cell with a live body stays
   * `ready` while a body waits.
   */
  status: "ready" | "stale" | "error" | "pending" | "discarded";
  kv_key: string;
  /** A new body waits for the OK (versions-approval.md §4). Absent from an older worker. */
  pending?: boolean;
  /** When the waiting body was written, unix ms. */
  pending_since?: number | null;
  /** The rule names stored on the row. Absent from a worker older than 2026-10-12. */
  lint_flags?: string[];
  /** Parts this version leaves as the page built them (docs/specs/refused-versions.md). */
  parts_as_built?: PartAsBuilt[];
}

/** A part a version leaves in the page's own words, and the rule it failed. */
export interface PartAsBuilt {
  path: string;
  /** Superadmin only: a customer's own session gets the path alone. */
  rule?: string;
}

/** What a visitor gets for a version that is not written: an earlier one, the closest, or the page. */
export type VersionServing = "older" | "nearest" | "original";

/** A version the copy checks refused (packages/generation/src/lib/variant-summary.ts). */
export interface RefusedVersion {
  intent_dim: string;
  source_dim: string;
  page_path: string;
  kv_key: string;
  /** As stored: "lint: 3 of 5 parts could not be written; ...". Never shown as it is. */
  error_reason: string;
  serving: VersionServing;
  /** When the queue tries it next, unix ms; absent when the worker has no time of its last try. */
  next_try?: number;
}

/** `summary` of GET /admin/variants/list?summary=1. */
export interface VariantSummary {
  written: number;
  with_parts_as_built: number;
  refused: number;
  failed: number;
  refused_rows: RefusedVersion[];
}

/**
 * GET /admin/variants/list?customer_id=X&summary=1. A worker from before
 * 2026-10-12 ignores `summary` and answers the array alone.
 */
export type VariantListAnswer =
  | VariantListItem[]
  | { items: VariantListItem[]; summary?: VariantSummary | null };

export interface VerifyResponse {
  ok: boolean;
}

export interface RegenerateResponse {
  customer_id: string;
  generated: number;
  errors: number;
  cost_usd: number;
  cache_hit_rate: number;
  kv_keys: string[];
  failed_tuples: Array<{ intent_dim: string; source_dim: string; reason: string }>;
  aborted: boolean;
  abort_reason?: string;
}

// ---------------------------------------------------------------------------
// Onboard / element-detection
// ---------------------------------------------------------------------------

/**
 * One detected element: three selector tiers.
 * The key in Manifest is a dot-path, e.g. "hero.headline".
 */
export interface ElementTargets {
  css: string[];
  text: string[];
  structural: string;
  /** V2 Module 3: AI-detected conversion candidate flag. */
  conversion_candidate?: boolean;
  /** D6.2: original character count, used by length-aware generation. */
  original_char_length?: number;
  /** D6.2: original word count, used by length-aware generation. */
  original_word_count?: number;
  /** The original element's inline shape (docs/specs/design-preserving-rewrite.md). */
  inline?: InlineShape;
  /** Operator's "leave it": the snippet never writes this part. */
  skip?: boolean;
  /** Operator's "replace as plain text" on a split-text part. */
  plain?: boolean;
  /**
   * A button only (docs/specs/button-rewrite.md): the operator's switch.
   * Absent or anything but true is off, and the button keeps the page's words.
   */
  rewrite?: boolean;
}

export type Manifest = Record<string, ElementTargets>;

// ---------------------------------------------------------------------------
// Selector health (element-detection-v2 T1c) — advisory validation of the
// detected CSS selectors against the source HTML. Never blocks confirmation.
// ---------------------------------------------------------------------------

export type SelectorStatus = "ok" | "multiple" | "none" | "unsupported";

export interface SelectorCheck {
  selector: string;
  status: SelectorStatus;
}

/** Dot-path → per-CSS-selector checks, in manifest order. */
export type SelectorHealth = Record<string, SelectorCheck[]>;

/**
 * Shape returned by POST /admin/onboard/detect,
 * POST /admin/onboard/confirm, and GET /admin/onboard/manifest.
 */
export interface ManifestResponse {
  customer_id: string;
  /** The page this manifest targets (A1 per-path). Defaults to '/'. */
  page_path: string;
  manifest: Manifest;
  source_url: string;
  generated_at: number;
  confirmed_at: number | null;
  cost_usd: number;
  status: "unconfirmed" | "confirmed";
  /** Present only on fresh /detect responses (T1c) — advisory warnings. */
  selector_health?: SelectorHealth;
  /** Where the detected HTML came from (fresh /detect responses only, T2). */
  html_source?: "capture" | "fetch";
  /** Parts the live page no longer has, from the last live read (migration 0027). */
  missing_parts?: string[];
  health_checked_at?: number;
  /**
   * The page's buttons with their switch (GET /admin/onboard/manifest, one
   * page and each row of all=true). Absent from a worker older than 2026-10-12.
   */
  buttons?: ButtonRow[];
}

// ---------------------------------------------------------------------------
// Buttons stay as built until the operator turns one on
// (docs/specs/button-rewrite.md; packages/generation/src/admin/buttons.ts)
// ---------------------------------------------------------------------------

/** One button of a page. */
export interface ButtonRow {
  /** The manifest path, for example `hero.cta.label`. Never shown. */
  path: string;
  /** The slot's plain name ("Hero button"). */
  label: string;
  /** The page's own words on it, forty characters at most. */
  text: string;
  /** The operator's switch. Off: the button stays as on the page. */
  rewrite: boolean;
  /** Its clicks are counted, whatever `rewrite` says. */
  counted: boolean;
  /** A form's button: it sends the form, it opens no page. */
  form: boolean;
  /** Quickstart only: the button the "button to count" row proposes. */
  proposed?: boolean;
}

/** GET /admin/onboard/buttons?customer_id=X&page_path=/ */
export interface ButtonsAnswer {
  page_path: string;
  confirmed: boolean;
  test_running: boolean;
  buttons: ButtonRow[];
}

/** POST /admin/onboard/button { customer_id, page_path, path, rewrite }. */
export interface ButtonSetAnswer extends ButtonsAnswer {
  changed: boolean;
  /** Versions of the page marked to be written again. */
  stale: number;
}

// ---------------------------------------------------------------------------
// DOM capture (element-detection-v2 T2) — for CSR sites the plain fetch
// can't see. Operator runs a bookmarklet on their own page; the rendered
// DOM lands in KV for the next /detect to prefer.
// ---------------------------------------------------------------------------

/** Response of POST /admin/onboard/capture-token. */
export interface CaptureTokenResponse {
  token: string;
  page_path: string;
  expires_in_s: number;
}

/** Response of GET /admin/onboard/capture-status. */
export interface CaptureStatusResponse {
  captured: boolean;
  page_path: string;
}

/** Hero texts, before (the page) or after (the preview). */
export interface HeroTexts {
  headline: string | null;
  body: string | null;
  cta: string | null;
}

/**
 * Response of POST/GET /admin/onboard/quickstart (script-first onboarding):
 * one pass over the operator's captured page.
 */
export interface QuickstartResponse {
  customer_id: string;
  page_path: string;
  source_url: string;
  generated_at: number;
  language: string;
  language_source: "html-lang" | "page-read" | "fallback";
  current: HeroTexts;
  preview: HeroTexts | null;
  preview_error: string | null;
  brief: BusinessDNA;
  brief_gaps: string[];
  manifest: Manifest;
  selector_health: SelectorHealth;
  uncertain_paths: string[];
  cost_usd: number;
  html_source?: "capture" | "fetch";
  /** Every language the site publishes at its own address, as discovered from the page. */
  languages: LanguagePage[];
  /**
   * Languages the site also serves on the same address (per-language.md
   * section 6). Nothing is written for them. Absent from a worker older
   * than 2026-10-12 and on an extra page.
   */
  same_address?: SameAddressLanguage[];
  /**
   * The page's buttons with their switch as stored now (the record's own
   * `manifest` is a snapshot of the read). Absent from a worker older than
   * 2026-10-12.
   */
  buttons?: ButtonRow[];
  /**
   * The button to count (docs/specs/measure-at-go-live.md section 12). Null
   * on an extra page after go live; absent from a worker older than
   * 2026-10-05.
   */
  measure?: MeasureProposal | null;
}

/** One language of the customer's site (docs/specs/per-language.md). */
export interface LanguagePage {
  lang: string;
  path: string;
  source: "hreflang" | "html-lang" | "nav";
  status: "primary" | "ready" | "unreachable";
  parts: number;
  brief_drafted: boolean;
  enabled: boolean;
}

/**
 * A language the site serves on the same address as another one, found
 * through its language switch. No page of its own: never enabled, never
 * written, never a path.
 */
export interface SameAddressLanguage {
  lang: string;
  path: null;
  source: "switch";
  status: "same_address";
  parts: 0;
  brief_drafted: false;
  enabled: false;
}

/** An entry of the customer's `languages`. */
export type StoredLanguage = LanguagePage | SameAddressLanguage;

/** Response of POST /admin/onboard/pick-token (pick on the page). */
export interface PickTokenResponse {
  token: string;
  page_path: string;
  expires_in_s: number;
  /** The one-time link the operator opens on their own site. */
  link: string;
}

/** Response of GET /admin/onboard/pick-status. */
export interface PickStatusResponse {
  landed: boolean;
  page_path: string;
  manifest?: Manifest;
  generated_at?: number;
}

// ---------------------------------------------------------------------------
// Install friction (docs/specs/install-friction.md, "Build notes"). Mirrors
// packages/generation/src/lib/{csp,platform,tag-position,install-facts}.ts;
// closed enums plus the CSP lines, which are rebuilt on every probe.
// ---------------------------------------------------------------------------

export type InstallPlatform =
  | "webflow"
  | "framer"
  | "wix"
  | "squarespace"
  | "shopify"
  | "wordpress"
  | "lovable"
  | "nextjs"
  | "vercel"
  | "other";

export type InstallHosting = "vercel" | "netlify" | "cloudflare_pages" | "cloudflare";

/**
 * head_first: no external script holds ours up (inline scripts, stylesheets
 * and async, defer or module scripts before it are fine). head_late: a classic
 * external script without async or defer before it (blocking_script_before).
 * body_top: before the first h1 (Webflow free). body_late: after the hero.
 * not_found: not in the HTML.
 */
export type TagPosition = "head_first" | "head_late" | "body_top" | "body_late" | "not_found";

export type TagFlag =
  | "async"
  | "defer"
  | "module"
  | "rocket_loader"
  | "gtm"
  | "blocking_script_before";

export type CspNote =
  | "frames_blocked"
  | "hash_only"
  | "style_nonce"
  | "style_attr_blocked"
  | "trusted_types";

export type CspWhere =
  | "next_config"
  | "next_middleware"
  | "next_layout"
  | "vercel_json"
  | "netlify_headers"
  | "cloudflare_headers"
  | "meta_tag"
  | "header";

export interface CspKindVerdicts {
  script: "ok" | "missing_host" | "needs_nonce" | "hash_only";
  connect: "ok" | "missing_host";
  style: "ok" | "blocked";
  frames: "ok" | "blocked";
}

export interface InstallCsp {
  verdict: {
    source: "header" | "meta" | "both" | "none";
    enforced: CspKindVerdicts | null;
    report_only: CspKindVerdicts | null;
    trusted_types: boolean;
  };
  /** The enforced policy stops the tag outright. */
  blocks: boolean;
  /** The tag runs, but the hide style is blocked (a flash before the swap). */
  degrades: boolean;
  /** The report-only policy would stop the tag once enforced. */
  report_only_blocks: boolean;
  /** Whole new directives, the site's own sources kept, our origin added at the end. */
  lines: string[];
  report_only_lines: string[];
  notes: CspNote[];
  /** Where the screen tells the customer to edit the policy; null when nothing needs changing. */
  where: CspWhere | null;
}

export interface InstallFacts {
  platform: InstallPlatform;
  hosting: InstallHosting | null;
  tag_position: TagPosition;
  tag_flags: TagFlag[];
  csp: InstallCsp;
}

/** Response of POST /admin/snippet-status/probe: is the tag on their page right now. */
export interface ProbeResponse {
  customer_id: string;
  status: "active" | "stale" | "removed" | "never" | "unknown";
  reason: string;
  /** Which tag form carried this customer's id; "generic" is the older tag with no quiet swap. */
  tag_form?: "script" | "generic" | null;
  probed_at: number;
  /** The page the probe read (the one being connected). */
  page_path?: string;
  /**
   * ok, or the site's bot protection answered, or the page redirects to
   * another host (never followed), or the fetch failed.
   */
  read?: "ok" | "bot_protection" | "off_host" | "failed";
  /** A capture landed or an event arrived: the tag has run. The probe is a hint, this is proof. */
  tag_runs?: boolean;
  /** Null when the page could not be read. */
  install?: InstallFacts | null;
  /**
   * The two-part tag's pasted style on the page read (faster-tag.md step 6,
   * "API contract (generation)"); null when the page was not read. Absent
   * from a worker older than 2026-10-26.
   */
  pre?: { state: PreState | null; policy: PrePolicy | null; lines: string[] } | null;
}

/** The pasted style against the paste now (faster-tag.md step 6). */
export type PreState = "none" | "current" | "stale";
/** The site's enforced policy for the pasted style at the last read. */
export type PrePolicy = "none" | "inline" | "nonce" | "listed" | "needs_hash";
/** Why the two-part tag is not offered. */
export type PreBlocked = "not_live" | "audit" | "inactive" | "no_parts";
/** The install forms the two-part tag knows, in order. */
export type PreFormId = "html" | "webflow" | "framer" | "lovable" | "nextjs";
/** Where a form goes; the steps are the dashboard's copy. */
export type PreWhere = "head_first" | "head_code" | "body_embed_top" | "start_of_head";

/**
 * Response of GET /admin/install/pre and POST /admin/install/pre/check
 * (docs/specs/faster-tag.md, step 6, "API contract (generation)").
 */
export interface PrePasteResponse {
  customer_id: string;
  available: boolean;
  blocked: PreBlocked | null;
  paste: { css: string; style: string; script: string; html: string } | null;
  csp: {
    hash: string;
    needed: boolean | null;
    policy: PrePolicy | null;
    refused: boolean;
    lines: string[];
    lines_read: boolean;
  } | null;
  state: PreState | null;
  stale: boolean;
  probed_at: number | null;
  platform: {
    detected: InstallPlatform | null;
    form: "html" | "webflow" | "framer" | null;
    ready: boolean | null;
  };
  platforms: { id: PreFormId; status: "ready" | "not_yet"; where: PreWhere[] }[];
}

/** Response of POST /admin/onboard/go-live (`count` and `test`: measure-at-go-live.md section 12). */
export interface GoLiveResponse extends Partial<GoLiveMeasure> {
  ok: boolean;
  page_path: string;
  confirmed_at: number;
  promoted: boolean;
}

/** Response of POST /admin/conversions/pick-token (visual-picker.md section 9.3). */
export interface CountPickTokenResponse {
  token: string;
  page_path: string;
  expires_in_s: number;
  /** https://{domain}{page_path}#rawuser_pick={token} */
  link: string;
}

/** Response of GET /admin/conversions/pick-status (visual-picker.md section 9.3). */
export type CountPickStatusResponse =
  | { landed: false; page_path: string }
  | { landed: true; page_path: string; target: ConversionTarget; items: ConversionTarget[] };

/** Response of GET /admin/onboard/manifest?all=true — every path's manifest (A1). */
export interface ManifestsAllResponse {
  manifests: ManifestResponse[];
}

// ---------------------------------------------------------------------------
// Conversions (V2 Module 3)
// ---------------------------------------------------------------------------

/**
 * One conversion target — a CTA the snippet listens for clicks on.
 * Returned by /admin/conversions/list and /admin/conversions/upsert.
 */
export interface ConversionTarget {
  id: string;
  customer_id: string;
  section_path: string;
  label: string;
  conversion_label: string;
  enabled: boolean;
  css_selectors: string[];
  text_selectors: string[];
  structural_selector: string;
  created_at: number;
  updated_at: number;
  /**
   * A group's button (docs/specs/page-groups.md, API): the pattern it counts
   * on, `/products/*`, and the mark. Absent on every other target and from a
   * worker older than 2026-10-12.
   */
  page?: string;
  group?: boolean;
  /** A group's button: the pages the aggregator counted; null before it has. */
  pages?: number | null;
  /**
   * A button on every page (a navbar or footer link added by hand with a CSS
   * selector): the worker marks it. Absent from a worker older than
   * 2026-10-13; then the dashboard reads the shape of `section_path`.
   */
  site?: boolean;
}

// ---------------------------------------------------------------------------
// Page groups, phase 1 (docs/specs/page-groups.md, API): one button counted
// across the pages that share a layout. Every field optional: the dashboard
// may be deployed before the workers, and renders nothing it is not given.
// ---------------------------------------------------------------------------

/** A pattern with the counts the aggregator has for it; null or absent when it has none. */
export interface PageGroupCounts {
  pattern: string;
  /** Distinct pages with visits in the last 30 days. */
  pages?: number | null;
  visits?: number | null;
}

/** An accepted group: its counted button, or null before the pick. */
export interface PageGroupView extends PageGroupCounts {
  counted?: ConversionTarget | null;
  /**
   * Pages of the group the button was not found on. Phase 1 sends none
   * (the spec, Health); drawn only if a later worker ever sends it.
   */
  missing?: { pages: number; paths?: string[] } | null;
}

/** GET /admin/pages/groups?customer_id= */
export interface PageGroupsResponse {
  groups?: PageGroupView[];
  proposals?: PageGroupCounts[];
  max?: number;
  /** Assumed, optional: the lift report decides when it is absent. */
  test_running?: boolean;
  /** Assumed, optional: the superadmin's sensitive read decides when it is absent. */
  sensitive?: boolean;
}

/** Why the second line's lift is null (proof-engine.md, `groups.*.waits_for`). */
export type OnVersionedWait = "read_date" | "clicks" | "split" | "held_back" | "ended_early";

/**
 * The second result line on the lift report (proof-engine.md, "Visits that
 * never met a version", as built 2026-10-12): visits whose first exposure
 * with an arm was on a page with versions of its own, under their own gate,
 * a lift on the read date only. Null with no test; absent from a worker
 * without it.
 */
export interface OnVersioned {
  treat?: ArmCounts;
  holdout?: ArmCounts;
  /** The gate: 30 visits and 10 converting visits per arm in this population. */
  enough?: boolean;
  /** Only on result and ended, past the gate. */
  lift?: LiftRange | null;
  waits_for?: OnVersionedWait | null;
  /** One plain line, "On pages that have versions: ...", shown as it comes. */
  sentence?: string;
}

/** Allowed conversion_label enum values (server enforces). */
export const CONVERSION_LABELS = [
  "signup",
  "demo_request",
  "trial_start",
  "purchase",
  "contact",
  "waitlist",
  "download",
  "other",
] as const;
export type ConversionLabel = (typeof CONVERSION_LABELS)[number];

/**
 * Human descriptions for each conversion_label enum value (F14).
 * Surfaced next to the raw enum in the conversion-label dropdowns so a
 * first-time operator doesn't have to guess what `trial_start` vs `signup`
 * means. Kept short enough to fit a single helper line.
 */
export const CONVERSION_LABEL_DESCRIPTIONS: Record<ConversionLabel, string> = {
  signup: "Visitor creates an account",
  demo_request: "Visitor asks for a demo",
  trial_start: "Visitor starts a free trial",
  purchase: "Visitor completes a paid purchase",
  contact: "Visitor clicks the button of a contact or sales form",
  waitlist: "Visitor joins a waitlist",
  download: "Visitor downloads an app or file",
  other: "Any other primary action you want to track",
};

/** Body for POST /admin/conversions/upsert. */
export interface ConversionUpsertBody {
  customer_id: string;
  id?: string;
  section_path: string;
  label: string;
  conversion_label?: ConversionLabel;
  enabled?: boolean;
  css_selectors?: string[];
  text_selectors?: string[];
  structural_selector?: string;
}

/** Body for POST /admin/conversions/confirm. */
export interface ConversionsConfirmBody {
  customer_id: string;
  targets: Array<{
    section_path: string;
    label: string;
    conversion_label?: ConversionLabel;
    enabled?: boolean;
  }>;
}

export interface ConversionsConfirmResponse {
  accepted: ConversionTarget[];
  rejected: Array<{ section_path: string; reason: string }>;
}

export interface ConversionsListResponse {
  items: ConversionTarget[];
}

// ---------------------------------------------------------------------------
// The proof engine (docs/specs/proof-engine.md, section G): the "What the
// versions did" card, the superadmin holdout control and the weekly draft.
// The shapes live in @rawuser/shared so the generation worker builds the
// same types the dashboard reads.
// ---------------------------------------------------------------------------

export type {
  ArmCounts,
  CustomerTestRefusal,
  GoLiveMeasure,
  GoLiveTestReason,
  MeasureButton,
  MeasureProposal,
  TestEndReason,
  TestStartedBy,
  CustomerTestResult,
  HoldoutControl,
  HoldoutOption,
  HoldoutSetResult,
  LiftRange,
  LiftReport,
  ProofChecks,
  ProofState,
  ProofVerdict,
  ReadEstimate,
  SourceRow,
  StartBlock,
  TestPeriod,
  TestStart,
  WeeklyDraft,
} from "@rawuser/shared";

// ---------------------------------------------------------------------------
// The free AI-traffic audit (docs/specs/ai-traffic-audit.md §17.4)
// ---------------------------------------------------------------------------

export type {
  AuditAnswers,
  AuditCheck,
  AuditCount,
  AuditGroup,
  AuditGroupKey,
  AuditLandingList,
  AuditName,
  AuditReport,
  AuditReview,
  AuditSample,
  AuditSamplePart,
  AuditShare,
  AuditStage,
  AuditStatus,
  AuditTestLine,
} from "@rawuser/shared";

// ---------------------------------------------------------------------------
// The Results page's reads (docs/specs/results-data.md): the period and its
// comparison, visits per source with the period before (N2), pages without
// versions (N4). The shapes live in @rawuser/shared. N1 (source names) and
// N3 (tagged links) are optional and absent until built.
// ---------------------------------------------------------------------------

export type {
  AnalyticsComparison,
  AnalyticsPeriod,
  PageRow,
  PagesBreakdown,
  PreviousTotals,
  ResultsBreakdownFields,
  ResultsLead,
  ResultsOverviewFields,
  SourceBreakdownRow,
  SourceNameCount,
  TaggedLinks,
  UnknownRow,
} from "@rawuser/shared";
// ---------------------------------------------------------------------------
// Analytics (V2 Module 3 Batch C P6)
// ---------------------------------------------------------------------------

/**
 * Response shape for GET /admin/analytics/overview
 * Hero metrics + cohort breakdown + Wilson lift CI.
 */
export interface AnalyticsOverview extends Partial<ResultsOverviewFields> {
  /** Versions waiting for the customer's OK (versions-approval.md §4). */
  pending_versions?: number;
  customer_id: string;
  window: "1h" | "24h" | "7d" | "30d";
  /** Unix ms — dashboard formats to local time. */
  computed_at: number;
  cohorts: {
    personalized: { visits: number; conversions: number; cr: number };
    /**
     * The holdout ARM since 2026-10-04 (intent-to-treat, proof engine): the
     * visits the coin held out and how many of them converted on any page.
     */
    holdout: { visits: number; conversions: number; cr: number };
    no_signal: {
      visits: number;
      conversions: number;
      cr: number;
      /** Untagged visits the edge flagged as probable dark social (mobile, referrer stripped). L2 Layer D. */
      dark_social_probable?: number;
      /** Untagged visits kept original because the page language differs from the versions' language. */
      language_mismatch?: number;
    };
    /** Visitors who had signal but personalization couldn't apply (manifest gap).
     *  An operator metric; in the holdout lift they count in the treat arm
     *  (intent-to-treat, 2026-10-04), never in the natural lift. */
    skipped?: { visits: number; conversions: number; cr: number };
  };
  hero: {
    /** The treat arm against the holdout arm, null until each has 30 visits and 10 converting. */
    holdout_lift: {
      value: number | null;
      ci_lower: number | null;
      ci_upper: number | null;
      significance: "not_yet" | "sig_90" | "sig_95" | "sig_99";
    };
    natural_lift: {
      value: number | null;
      ci_lower: number | null;
      ci_upper: number | null;
      significance: "not_yet" | "sig_90" | "sig_95" | "sig_99";
    };
    total_visits: number;
    total_conversions: number;
  };
  /**
   * Against the period before (`comparison.previous`), like-for-like since
   * 2026-10-04. Null when that period is not comparable (the 30-day window:
   * its rows have lost the visit marker), when it had under 30 visits (10
   * converting visits for conversions), or on a row from before the change.
   */
  delta: {
    vs_previous_period_visits_pct: number | null;
    vs_previous_period_conversions_pct: number | null;
  };
}

/** One row in the per_variant breakdown. */
export interface VariantBreakdownItem {
  intent_dim: string | null;
  source_dim: string | null;
  visits: number;
  conversions: number;
}

/** One row in the per_intent breakdown. */
export interface IntentBreakdownItem {
  intent_dim: string;
  visits: number;
  conversions: number;
}

/**
 * Response shape for GET /admin/analytics/breakdown
 */
export interface AnalyticsBreakdown extends Partial<ResultsBreakdownFields> {
  by_intent: IntentBreakdownItem[];
  by_tuple: VariantBreakdownItem[];
}

/** One data point in the 30d time series. */
export interface TimeSeriesPoint {
  date: string; // 'YYYY-MM-DD' UTC
  visits: number;
  conversions: number;
}

/**
 * Response shape for GET /admin/analytics/timeseries
 */
export interface AnalyticsTimeseries {
  customer_id: string;
  computed_at: number;
  series: TimeSeriesPoint[];
}

// ---------------------------------------------------------------------------
// Portfolio (V2 Module 3 Batch C P6 — superadmin only)
// ---------------------------------------------------------------------------

/** Operator portfolio view: one card per active customer. */
export interface PortfolioItem {
  customer_id: string;
  customer_slug: string;
  customer_domain: string;
  snippet_status: "active" | "stale" | "removed" | "never" | "unknown";
  /** Computed from snippet_status + lift + skipped_rate. */
  health: "green" | "yellow" | "red";
  holdout_lift_7d: number | null;
  visits_24h: number;
  signals: Array<"snippet-removed" | "snippet-stale" | "skipped-rate-high" | "lift-trend-down">;
}

/** One attention signal emitted by GET /admin/portfolio/attention. */
export interface AttentionSignal {
  customer_id: string;
  type: "snippet-removed" | "snippet-stale" | "skipped-rate-high" | "lift-trend-down";
  /** Numeric value associated with the signal (e.g. skipped_rate or holdout_lift). */
  value?: number;
  label: string;
}

/** One pilot lead row from GET /admin/pilot-requests/list (migration 0016). */
export interface PilotRequest {
  id: string;
  email: string;
  site_url: string | null;
  note: string | null;
  /** Server-stamped epoch ms. */
  created_at: number;
  status: "new" | "contacted" | "closed";
}

// ── Pilot apply (docs/specs/pilot-apply.md) ──────────────────────────────

/** GET /admin/apply/invite?t= (public, token-gated). */
export interface ApplyInviteResponse {
  ok: boolean;
  status: "invited" | "applied" | "expired";
  invited_name?: string | null;
  invited_site?: string | null;
  /** Present on an already-used invite when the worker can say which customer it made. */
  customer_id?: string | null;
  /** The tag withheld for a special-category site not yet marked (readiness-check.md). */
  tag_withheld?: boolean;
}

/** POST /admin/apply/read (public, token-gated, 3 reads per token). */
export interface ApplyReadResponse {
  ok: boolean;
  suggestions: {
    product?: string | null;
    icp?: string | null;
    differentiators?: string[];
    proof_points?: string[];
    value_props?: string[];
    language?: string | null;
  };
  /** Pages the worker read; optional, the page says 1 when absent. */
  pages?: number;
  /** server: the page's own HTML; render: built in a browser first. */
  source?: "server" | "render";
}

/** POST /admin/apply/submit (public, token-gated, single use). */
export interface ApplySubmitResponse {
  ok: boolean;
  customer_id: string;
  tag: string;
  /** What the read of the site says about installing the tag; null when it could not be read. */
  install?: InstallFacts | null;
  /** The tag withheld for a special-category site not yet marked (readiness-check.md). */
  tag_withheld?: boolean;
}

/**
 * POST /admin/apply/read, the 422 codes; each gives the read back.
 * client_rendered: the render is off. render_failed: rendered, but empty,
 * failed or too slow. bot_protection: the site's bot check answered.
 * off_host: the address redirects to another host, never followed.
 */
export type ApplyReadErrorCode =
  | "client_rendered"
  | "render_failed"
  | "bot_protection"
  | "off_host";

/** The applicant's answers as stored on the application. */
export interface PilotApplicationAnswers {
  url?: string;
  product?: string;
  icp?: string;
  differentiator?: string;
  numbers?: string;
  sources?: string[];
  name?: string;
  email?: string;
}

/** GET /admin/applications/list (superadmin). */
export interface PilotApplication {
  id: string;
  status: "invited" | "applied" | "archived";
  invited_name: string | null;
  invited_site: string | null;
  /** Epoch ms. */
  created_at: number;
  expires_at: number | null;
  submitted_at: number | null;
  contact_name: string | null;
  contact_email: string | null;
  site_url: string | null;
  customer_id: string | null;
  /** JSON object; a raw JSON string is tolerated in case the worker passes the column through. */
  answers: PilotApplicationAnswers | string | null;
  tag_seen_at: number | null;
  live_at: number | null;
  /** 'pilot' (the apply page) or 'audit' (docs/specs/ai-traffic-audit.md §3.1). */
  kind?: "pilot" | "audit";
  /** An audit with a customer: where it stands; else null. */
  audit?: AuditStatus | null;
}

/** POST /admin/applications/invite (superadmin). */
export interface PilotApplicationInvite {
  id: string;
  kind?: "pilot" | "audit";
  link: string;
  expires_at: number;
  /** True when Cloudflare accepted the email (docs/specs/invite-email.md §2). */
  emailed?: boolean;
  /** Only when an address was given and the send did not happen. */
  email_error?: InviteEmailError;
}

/** Why an invite email did not go out (invite-email.md §2, a closed set). */
export type InviteEmailError =
  | "limit"
  | "unavailable"
  | "sender"
  | "recipient"
  | "quota"
  | "failed";

// ---------------------------------------------------------------------------
// Site-shaped intents (docs/specs/site-shaped-intents.md §18.2)
// ---------------------------------------------------------------------------

/** A page kind in the customer's map; `none` is the operator's "Not a page to use". */
export type SiteMapKind =
  | "price"
  | "vs"
  | "compare"
  | "proof"
  | "features"
  | "docs"
  | "how"
  | "learn"
  | "start"
  | "about"
  | "none";

export interface SiteMapPath {
  path: string;
  /** The page's language where it was read; null for an operator's row. */
  lang: string | null;
  kind: SiteMapKind;
  /** The link text, only when it named the kind (privacy review condition 2); else show the path alone. */
  label: string | null;
  /** No mark in the UI (founder decision 6). */
  confidence: "high" | "medium" | "model" | "operator";
  found_on: string;
  /** A re-read no longer finds it; it keeps working and goes after 30 days. */
  missing: boolean;
}

/** GET /admin/site-map, and the answer of both POSTs. */
export interface SiteMapView {
  customer_id: string;
  on: boolean;
  paths: SiteMapPath[];
  /** Tab order: most rows first. */
  languages: string[];
  served: string[];
  folded: Array<{ intent: string; to: string; reason: string }>;
  reasons: { pricing: string; competitor: string } | null;
  /** served.length × 5. */
  versions_per_page: number;
  pages: number;
  pending: {
    intents: string[];
    paths: Array<{ path: string; kind: SiteMapKind }>;
    since: number;
    /** Epoch ms: written by itself then (since + 7 days). */
    auto_at: number;
    versions: number;
  } | null;
}

/** POST /admin/site-map. */
export interface SiteMapSetBody {
  customer_id: string;
  on?: boolean;
  paths?: Array<{ path: string; kind: SiteMapKind }>;
  delete?: string[];
}
