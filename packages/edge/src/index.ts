/**
 * Rawuser edge worker: visitor request path.
 *
 * Hard rule (ADR 0003): this bundle MUST contain no model call,
 * no PII write path, no synchronous external call. The whole job is:
 *   1. Extract signals from the HTTP request
 *   2. Classify into an IntentVector (pure function, no I/O)
 *   3. Snap to (intent_dim, source_dim) via selectVariantKey
 *   4. KV cascade: primary key → intent-only sentinel → in-bundle template
 *   5. Return the variant (or fallback) JSON
 *
 * The bundle-invariant test in test/bundle.test.ts enforces this by
 * reading the wrangler dry-run output for the model layer's own strings.
 *
 * KV cascade (for non-bot, non-preview visitors):
 *   1. v1:variant:{customer_id}:{intent_dim}:{source_dim}       → KV hit
 *      (a paid visit from a feed ad reads `:social`, ads-platforms.md §4)
 *   2. v1:variant:{customer_id}:{intent_dim}:default            → sentinel hit
 *   3. nothing in KV → original page, not_ready: true (never a template)
 *   Bot UAs → source: "fallback-canonical-bot", variant null (page left as built)
 *   Browser Run (cf-brapi-* headers, its Signature-Agent, HeadlessChrome/)
 *   takes the same bot path, and /event and /carry refuse it too (no fake
 *   visit, @rawuser/shared no-fake-visit.ts)
 *
 * Events: /select writes none; the snippet posts them to /event.
 *
 * The ad keyword (docs/specs/keyword-intent.md §3.4; privacy review sections 9
 * and 10): `utm_term` leaves the signals the moment they are built, before
 * the classifier, the learning counters or any answer sees them. It waits
 * in one local until the visitor bundle is in hand, is matched against the
 * customer's own lexicon (`kl`) to one intent word, and is then forgotten.
 * No `kl` (none built, off, sensitive, a special-category yes, an old or
 * unread bundle): the keyword is dropped unread. Neither the keyword nor the
 * lexicon is ever logged, stored or answered.
 *
 * A sensitive customer (docs/specs/sensitive-customers.md, sensitive.ts):
 * /select stores nothing that holds a page path. It writes no row, and the
 * one key it writes (the bundle write-back) is named by the customer id; the
 * path only picks which KV keys are read. So the grouping of paths is
 * /event's alone. Here the flag only stops the two learning counters, and
 * no answer differs by it (privacy review condition 5).
 *
 * The holdout (docs/specs/proof-engine.md, section A): decided after the
 * cascade found a version, from the tab's visit marker and the customer's
 * percent in the visitor bundle; no marker, no arm. Every human answer
 * carries the confirmed conversion targets, so both arms and the no-signal
 * visits can convert. No answer echoes the intent vector (privacy review
 * condition 6): the edge classifies to pick the cell and keeps the rest.
 *
 * Privacy guarantees:
 * - UA is consumed for classification and never stored or echoed.
 * - Referrer is reduced to host only before any processing.
 * - Country is country-level only from cf.country (never region/city/IP).
 * - No cookies, no cross-session IDs, no PII in responses or event writes.
 * - Response always carries Cache-Control: private, no-store so per-visitor
 *   selections are never cached by any CDN/proxy.
 */

import {
  DEFAULT_VARIANT_TEMPLATES,
  type FoundBy,
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
  type SourceName,
  campaignRefused,
  classify,
  extractSignals,
  foldIntentDim,
  foldVector,
  foundBy,
  hasMeaningfulSignal,
  hasSourceSignal,
  isOwnTagged,
  isRenderBrowser,
  kindCarriesIntent,
  maskPath,
  matchKeywordIntent,
  normalizePath,
  readableKeywordLexicon,
  selectVariantKey,
  sourceNameFor,
  variantKey,
  variantKeyForPath,
  versionSourceDim,
  withSiteMap,
} from "@rawuser/shared";
import {
  type ChoiceClient,
  type ChoiceConfig,
  HELD_ORIGINAL,
  type VisitorBundle,
  choiceClient,
  choiceRecalled,
  choiceSlotOf,
  conversionTargetsForPage,
  customerLangKey,
  parseBodyId,
  visitorBundleKey,
  writtenManifest,
} from "@rawuser/shared";
import type {
  AiSource,
  IntentDim,
  IntentVector,
  Manifest,
  Signals,
  SourceDim,
  VariantBody,
} from "@rawuser/shared/types";
import { type AuditFields, auditOf, refusedByAudit } from "./audit.ts";
import { handleCarry, isCarryOff } from "./body-carry.ts";
import { writeBundleFromD1 } from "./bundle-writeback.ts";
import { capturePreflight, handleCapture } from "./capture.ts";
import { isClosed } from "./closed.ts";
import { coreHash, handleCore } from "./core-script.ts";
import { customerScriptId, handleCustomerScript } from "./customer-script.ts";
import { type WordTarget, choiceOn, nextWordCarry, pageOneFields, planDirect } from "./direct.ts";
import { etagMatches } from "./etag.ts";
import { eventPreflight, handleEvent } from "./event.ts";
import { parseVisit } from "./event.ts";
import { type Arm, bundleHoldout, decideArm } from "./holdout.ts";
import {
  type CopyFrom,
  type CopyIo,
  type CopyRead,
  batchWord,
  bodyKeepable,
  keep,
  readThrough,
} from "./kv-copy.ts";
import { handlePick, handlePickerAsset, pickPreflight } from "./pick.ts";
import { handlePilotRequest, pilotPreflight } from "./pilot.ts";
import { RICH_ETAG, RICH_JS } from "./rich-asset.ts";
import { mayCountAcrossCustomers } from "./sensitive.ts";
import { countSignalTokens } from "./signal-tokens.ts";
import { SNIPPET_ETAG, SNIPPET_JS } from "./snippet-asset.ts";
import { countUaTokens } from "./ua-tokens.ts";
import { bodyForVisitors, forVisitors, ownSiteCustomer } from "./visitor-manifest.ts";

interface Env {
  VARIANTS: KVNamespace;
  DB: D1Database;
  ENVIRONMENT: string;
  PREVIEW_TOKEN: string;
  /** "on" enables aggregate UA token counting (L2 Layer E, ADR 0029). Default off. */
  UA_TOKEN_LEARNING?: string;
  /** "on" counts utm/referrer values the vocabulary did not recognise (Layer F). Default off. */
  SOURCE_LEARNING?: string;
  /** The holdout percent when the customer has none set, "0" to "50". Default 10; production "0". */
  HOLDOUT_PERCENT?: string;
  /** /event spam guard, Workers rate-limit binding (docs/specs/event-capacity.md, A). */
  EVENT_LIMITER?: RateLimit;
  /**
   * "off" turns the warm /select copy off (kv-copy.ts): every read goes to
   * KV, nothing is kept. Unset: on.
   */
  SELECT_COPY?: string;
  /** Origins the pilot form may post from, a comma list (pilot.ts). Unset: no such route. */
  PILOT_FORM_ORIGINS?: string;
  /** The dashboard's origin, for the link in the pilot form's ops line. Unset: no link. */
  APP_ORIGIN?: string;
  /**
   * The customer id of the operator's own site, when that site reads its
   * versions itself (visitor-manifest.ts, /select-bulk). Unset: no such
   * customer, and /select-bulk answers 404.
   */
  OWN_SITE_CUSTOMER?: string;
  /**
   * "on" lets the returning-visitor memory run on a site marked sensitive
   * (bundle-writeback.ts, `rm`). Anything else, unset included: it does not.
   */
  REMEMBER_ON_SENSITIVE?: string;
}

/**
 * One conversion target as emitted to the snippet: selectors only,
 * no operator-display label (the snippet doesn't render UI).
 */
interface ConversionTargetForClient {
  section_path: string;
  conversion_label: string;
  css: string[];
  text: string[];
  structural: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The copy's Cache API keys live under /_kv/ (kv-copy.ts): never answered,
    // before any cache match or fetch (privacy review condition 2, 2026-10-26).
    if (url.pathname.startsWith("/_kv/")) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/health") {
      // Don't echo env.ENVIRONMENT: anyone can reach /health and there's
      // no reason to advertise which env they hit.
      return json({ ok: true });
    }

    if (url.pathname === "/select") {
      // Server-Timing per stage (the /select tail, 2026-10-01): durations of
      // our own reads only, no visitor data; lets a browser trace name the
      // stage that took the time.
      const lap = lapper();
      const res = await handleSelect(request, url, env, ctx, lap);
      lap("total", true);
      res.headers.set("server-timing", lap.header());
      res.headers.set("timing-allow-origin", "*");
      return res;
    }

    if (url.pathname === "/carry") {
      // The segment's copy for the visit's later pages (body carry).
      return handleCarry(request, url, env, ctx);
    }

    if (url.pathname === "/select-bulk") {
      return handleSelectBulk(request, url, env);
    }

    if (url.pathname === "/event") {
      // CORS preflight: snippet is cross-origin and POSTs application/json.
      if (request.method === "OPTIONS") return eventPreflight();
      return handleEvent(request, url, env, ctx);
    }

    if (url.pathname === "/snippet.js") {
      return crossOrigin(handleSnippet(request));
    }

    if (url.pathname === "/picker.js") {
      return crossOrigin(handlePickerAsset(request));
    }

    if (url.pathname === "/rich.js") {
      // The rich writers, loaded only on the pages that need them.
      return crossOrigin(handleRichAsset(request, url));
    }

    // The shared core a customer's boot loads (faster-tag.md step 4), by build.
    const core = coreHash(url.pathname);
    if (core) {
      return crossOrigin(handleCore(request, core));
    }

    // The customer's own copy of the snippet with its hide rules (quiet swap).
    const scriptCustomer = customerScriptId(url.pathname);
    if (scriptCustomer) {
      return crossOrigin(
        await handleCustomerScript(request, env, scriptCustomer, {
          ctx,
          ...(env.SELECT_COPY === "off" ? { warm: false } : {}),
        }),
      );
    }

    if (url.pathname === "/onboard/pick") {
      // Operator-initiated element picking (docs/specs/visual-picker.md).
      if (request.method === "OPTIONS") return pickPreflight();
      return handlePick(request, env);
    }

    if (url.pathname === "/onboard/capture") {
      // Operator-initiated rendered-DOM capture (script-first onboarding).
      // Token-gated, one use, fifteen minutes; shares nothing with /select.
      if (request.method === "OPTIONS") return capturePreflight();
      return handleCapture(request, env, ctx);
    }

    if (url.pathname === "/pilot-request") {
      // First-party lead capture from the operator's own site
      // (packages/edge/src/pilot.ts); 404 unless the install names its origins.
      if (request.method === "OPTIONS") return pilotPreflight(request, env);
      return handlePilotRequest(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * `Cross-Origin-Resource-Policy: cross-origin` on the script routes only
 * (install-friction E2; the shared core since faster-tag.md step 4): a site that sends
 * `Cross-Origin-Embedder-Policy: require-corp` loads a cross-origin script
 * only when it says so. Never on /select or any JSON answer.
 */
function crossOrigin(res: Response): Response {
  res.headers.set("cross-origin-resource-policy", "cross-origin");
  return res;
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

interface SelectResponse {
  /**
   * How the variant was resolved.
   * - "original" means no meaningful signal arrived; snippet should leave
   *   the customer's page untouched. Variant is null in that case.
   * - "holdout" means the visit's coin put it in the holdout arm; the
   *   snippet leaves the page alone but fires analytics.
   */
  source:
    | "kv"
    | "kv-sentinel"
    | "fallback-template"
    | "fallback-canonical-bot"
    | "preview"
    | "original"
    | "holdout";
  /** Key used for the KV lookup ("in-bundle" for fallback, "" for original/holdout). */
  variant_key: string;
  /** Resolved variant body. NULL when source === "original" or "holdout". */
  variant: VariantBody | null;
  /**
   * What happened on this page.
   * - "personalized": signal present, visitor received a variant.
   * - "holdout":      the visit's arm is holdout; the original page is shown.
   * - "no_signal":    no meaningful signal (or no version, or another language); original page served.
   * Absent on the bot path (bots don't run the snippet).
   * "skipped" is NOT set here: the snippet derives it when applyVariant aborts.
   */
  cohort?: "personalized" | "holdout" | "no_signal";
  /**
   * What the coin said for the visit (docs/specs/proof-engine.md, A). Only
   * when the visit is in the experiment: a version exists for the page, the
   * tab sent a valid marker and the customer's percent is above 0.
   */
  arm?: Arm;
  /**
   * The id of the version served, or, on a holdout answer, of the version
   * the visit would have seen. Never the body itself on a holdout answer.
   */
  body_id?: string;
  /**
   * True when the visit carried a signal but no version exists yet for this
   * customer/path (tag installed before go-live). Original served; counted
   * as no_signal until versions land.
   */
  not_ready?: boolean;
  /**
   * True when the selection, or its source dim, came from the tab's carry:
   * a page with no signal of its own, or one whose only signal is its path
   * (docs/specs/session-carry.md). The snippet then keeps the landing's carry.
   */
  carried?: boolean;
  /** The path has a confirmed manifest: the snippet may keep its copy for the visit (body carry). */
  carryable?: boolean;
  /** The customer turned the carries off: the snippet removes what the tab kept. */
  carry_off?: boolean;
  /**
   * 1 when the customer was deleted (closed.ts): the snippet writes nothing,
   * sends no event and removes the tab's visit, carry and body keys.
   */
  off?: 1;
  /**
   * True when the customer's site map decided this page's intent
   * (docs/specs/site-shaped-intents.md §6.4). One bit; the snippet echoes it
   * on the page's exposure event. Never the path, the kind or a label.
   */
  site_path?: boolean;
  /**
   * Element manifest: CSS/text/structural selectors per section, injected
   * from D1.element_manifests when a confirmed manifest exists for the customer.
   * Absent when no confirmed manifest exists (bots, preview, or unconfirmed).
   * Sibling to `variant` so VariantBody (KV body) stays unchanged.
   */
  targets?: Manifest;
  /**
   * V2 Module 3: confirmed conversion targets the snippet should install
   * click listeners on. Absent when the customer has none enabled or on the
   * bot path. One indexed D1 read; ~1-3ms.
   */
  conversion_targets?: WordTarget[];
  /**
   * What the tab keeps in its carry for the visit (docs/specs/direct-visitors.md
   * §6): an `intent:source` pair, `none:direct`, or "" for nothing. Absent:
   * the snippet's own rule (a personalised selection that was not carried).
   */
  kc?: string;
  /** Why a visit with no signal got this answer: `l:{set}:{p}`, `m` or `c:{slot}` (§6). Echoed on events. */
  nd?: string;
  /** The visitor's own choice: the question and the answers' words, never their versions (§2). */
  q?: ChoiceClient;
  /** V1 snap: which intent dim and source dim won. Absent on the bot path. */
  selection?: {
    intent_dim: string;
    source_dim: string;
    confidence: number;
  };
  // No intent_vector on any answer (privacy review condition 6, founder
  // 2026-10-04): the snippet never read it, and a lead_probability readable
  // by every script on a customer's page is not ours to hand out.
  /**
   * Language gate (three-decisions §1, design C): the page is in another
   * language than the customer's versions, so the original was kept. The
   * snippet echoes it into the no_signal_passthrough event for reporting.
   */
  language_mismatch?: boolean;
  /**
   * L2 Layer D, reporting only: no meaningful signal, but the shape of the
   * visit (mobile, referrer stripped, a fresh navigation, or a low-confidence
   * webview guess) says the channel was probably an app that hid itself.
   * Never turns personalisation on; the snippet echoes it into the
   * no_signal_passthrough event so the Signal Coverage card can size the
   * dark-social share of the untagged bucket. Present only with source
   * "original".
   */
  dark_social_probable?: boolean;
  /**
   * N1 (docs/specs/results-data.md §7): the platform behind the chosen
   * source dimension, a word from SOURCE_NAMES, derived here from what the
   * request already carried. Absent when the list has no name for it. The
   * snippet echoes it on the page's events; the edge checks it again there.
   */
  source_name?: SourceName;
  /**
   * N3: the link carried campaign tags the customer set (not a platform's
   * own auto-tag). One bit, echoed on the page's events; never the tags.
   */
  tagged?: true;
  /**
   * Audit customers only (docs/specs/ai-traffic-audit.md §4.2): how this
   * request's own source was recognised, one word from FOUND_BY. Absent on
   * a path-only or carried page and for every other customer. The snippet
   * echoes it on the page's events; the edge checks it again there.
   */
  found_by?: FoundBy;
  /** Debug classifier block: only in development or with valid preview token. */
  classifier?: {
    ai_source: AiSource | null;
    /** L2: app whose in-app browser opened the page, or null. Name only. */
    app_source?: string | null;
    /** L2: platform named by a click-id parameter NAME, or null. */
    click_id?: string | null;
    is_bot: boolean;
  };
}

// ---------------------------------------------------------------------------
// /select handler
// ---------------------------------------------------------------------------

/** Stage timings for Server-Timing: lap(name) records the time since the last lap. */
function lapper() {
  const start = Date.now();
  let last = start;
  const parts: string[] = [];
  const lap = (name: string, total = false) => {
    const now = Date.now();
    parts.push(`${name};dur=${now - (total ? start : last)}`);
    last = now;
  };
  /** A fixed word beside the timings (`cache;desc=mem|hit|miss`), placed before the total. */
  lap.note = (part: string) => {
    parts.push(part);
  };
  lap.header = () => parts.join(", ");
  return lap;
}
type Lap = ReturnType<typeof lapper>;

async function handleSelect(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  lap: Lap = lapper(),
): Promise<Response> {
  const customerId = url.searchParams.get("customer_id");
  if (!customerId) {
    return jsonNoStore({ error: "customer_id is required" }, 400);
  }

  // Warm /select (kv-copy.ts, docs/specs/faster-tag.md §10): every KV value
  // below comes through the customer-level copy, served no later than 300 s
  // after its KV read counting KV's own cache. Nothing of this request goes
  // into a kept value or its key. `froms` names where each read came from,
  // for Server-Timing's `cache;desc=` only.
  const froms: CopyFrom[] = [];
  const copyOff = env.SELECT_COPY === "off";
  const copyIo: CopyIo = {
    cache: copyOff ? null : defaultCache(),
    origin: url.origin,
    defer: (p) => ctx.waitUntil(p),
    off: copyOff,
    onRead: (from) => froms.push(from),
  };
  /** Keep the bodies KV gave, only for `/` or a path the answer's bundle lists. */
  const keepBodies = (
    rows: Array<{ key: string; path: string; read: CopyRead | undefined }>,
    b: VisitorBundle | null,
  ): void => {
    for (const row of rows) {
      if (!row.read || row.read.from !== "miss") continue;
      if (!bodyKeepable(row.path, b)) continue;
      keep(env.VARIANTS, row.key, "body", row.read.kept, copyIo);
    }
  };

  // Extract signals. UA is consumed here: never stored or echoed.
  const cf = (request as Request & { cf?: { country?: string | null } }).cf;
  // Prefer the snippet-supplied self_host (visitor's own hostname) for
  // same-origin referrer detection. Falls back to the edge worker's
  // hostname when not provided (e.g. raw curl test calls).
  const snippetSelfHost = url.searchParams.get("self_host");
  // Visitor page path: normalized once here and reused for both the entry-path
  // intent signal (L1, ADR 0023) and the per-path KV/manifest cascade below.
  // The snippet sends location.pathname as `path`; absent (raw curl) → '/'.
  // Masked at once (docs/specs/event-paths.md): an identifier segment
  // becomes `:id` before any key is built from the path. A path without one
  // is unchanged, so it still finds its confirmed page; /select writes no row.
  // Masked before lowercasing, so a mixed-case token is still seen as one
  // (the snippet lowercases today; a raw caller may not).
  const pagePath = normalizePath(maskPath(url.searchParams.get("path") ?? "/"));
  const signals = extractSignals({
    url,
    headers: request.headers,
    cf: cf ? { country: cf.country } : undefined,
    selfHost: snippetSelfHost ?? url.hostname,
    entryPath: pagePath,
    // `ss=1`, presence only: the visitor came from this same site, so the
    // page's utm and click-id names are the site's own links. Left out: the
    // carry classifies the page and it is never a tagged link (results-data
    // §7). No storage; the bit is read here and nowhere else.
    sameSite: url.searchParams.get("ss") === "1",
  });

  // The ad keyword (keyword-intent.md §3.4): out of the signals at once,
  // before anything reads them. Four things read utm presence: the gate
  // (a tagged link is a reason to personalise), the own-source test, the
  // own-tag bit and the audit's `found_by`. A link tagged with utm_term alone
  // has always counted for all four, so they keep that from `termCame` or
  // are taken here, before the delete; none of them changes meaning, and
  // none holds the keyword.
  const ownTagged = isOwnTagged(signals.utm);
  const foundIfAudit = foundBy(signals);
  const termCame = signals.utm.term !== undefined;
  let adKeyword: string | null = signals.utm.term ?? null;
  // biome-ignore lint/performance/noDelete: the key itself must go, not only its value (privacy review condition 1).
  delete signals.utm.term;
  // A campaign name the special-category screen refuses
  // (docs/specs/ads-platforms.md §5, privacy review condition 2) goes here too,
  // before the gate, the classifier and the learning counters: it chooses
  // nothing, as if it never came. The own-tag bit above keeps its presence
  // (one bit, never the tag). Nothing logs it.
  if (campaignRefused(signals.utm.campaign)) {
    // biome-ignore lint/performance/noDelete: as absent, the key goes with its value.
    delete signals.utm.campaign;
  }
  /** The gate as before the delete: a utm_term is a tagged link, whatever it says. */
  const meaningfulSignal = (s: Signals): boolean => termCame || hasMeaningfulSignal(s);
  /**
   * The keyword's intent from this customer's lexicon, set on the signals
   * once the bundle is in hand, then the keyword forgotten. A bundle without
   * `kl` drops it unread. In memory only; a malformed lexicon chooses
   * nothing (the visit is classified as if no keyword came).
   */
  const readKeyword = (kb: VisitorBundle | null): void => {
    const keyword = adKeyword;
    adKeyword = null;
    const lexicon = readableKeywordLexicon(kb);
    if (keyword === null || !lexicon) return;
    try {
      const intent = matchKeywordIntent(keyword, lexicon);
      if (intent) signals.keywordIntent = intent;
    } catch {
      // Nothing logged: the line could only name the customer's lexicon.
    }
  };

  // Browser Run reading the customer's page during setup is a bot too: the
  // render blocks our hosts, this is the second layer (install-friction,
  // privacy review condition 3).
  const isBot = signals.device === "bot" || isRenderBrowser(request.headers);
  const includeClassifier = env.ENVIRONMENT === "development" || isPreviewAuthed(request, env);

  /**
   * The aggregate learning counters, run once the bundle and the tombstone
   * are in hand: never for a deleted customer, never for an audit customer
   * (no pilot data terms, ai-traffic-audit.md §3.4 and privacy review condition 1).
   * Until 2026-10-06 they ran before either was read.
   *
   * Never for a sensitive customer either (docs/specs/sensitive-customers.md,
   * the rule's point 3: its data enters no cross-customer count). Both
   * tables count across customers, so they run only when the bundle in hand
   * was read and does not say `s`; with no readable bundle nothing is known
   * and nothing is counted. No read is made for this, and with both
   * switches off (production today) the bundle is not even looked at.
   */
  const learn = (audit: AuditFields | null, learnBundle: VisitorBundle | null): void => {
    if (env.UA_TOKEN_LEARNING !== "on" && env.SOURCE_LEARNING !== "on") return;
    if (audit) return;
    if (!mayCountAcrossCustomers(learnBundle)) return;
    // L2 Layer E (ADR 0029): learn new in-app browser markers in aggregate.
    // Only when the flag is on, only for visits whose referrer was stripped
    // and whose app the table did not name. Fire-and-forget, never on the
    // response path, never a row per visit (see ua-tokens.ts).
    if (
      env.UA_TOKEN_LEARNING === "on" &&
      signals.referrerHost === null &&
      (signals.appSource === null || signals.appSource?.app === "unknown")
    ) {
      ctx.waitUntil(countUaTokens(env.DB, customerId, request.headers.get("user-agent")));
    }
    // L2 Layer F: learn the source vocabulary in aggregate. Only values the
    // vocabulary did not recognise, only when the flag is on, never a row
    // per visit (see signal-tokens.ts).
    if (env.SOURCE_LEARNING === "on") {
      ctx.waitUntil(countSignalTokens(env.DB, customerId, signals));
    }
  };

  // -----------------------------------------------------------------------
  // Bot path: leave the page exactly as the site built it (cloaking-safe).
  // No variant, no selection, no vector: the snippet then writes nothing,
  // stores no carry and fires no event, so a crawler that runs JavaScript
  // (Googlebot) renders the customer's own page and is never counted as a
  // visit. Until 2026-10-02 bots got the in-bundle brand template
  // ("[PLACEHOLDER] ..." copy); the snippet happened to skip it on every
  // live site checked, and logged each bot load as personalization_skipped
  // (530 rows in production), which the aggregator counts as visits.
  // -----------------------------------------------------------------------
  if (isBot) {
    const resp: SelectResponse = {
      source: "fallback-canonical-bot",
      variant_key: "",
      variant: null,
      ...(includeClassifier ? { classifier: { ai_source: signals.aiSource, is_bot: true } } : {}),
    };
    return jsonNoStore(resp);
  }

  // -----------------------------------------------------------------------
  // Preview path: intent_dim override gated by X-Rawuser-Preview token.
  // -----------------------------------------------------------------------
  const previewIntentDim = url.searchParams.get("intent_dim");
  const previewSourceDim = url.searchParams.get("source_dim") ?? "direct";
  if (previewIntentDim && isPreviewAuthed(request, env)) {
    const kvKey = variantKey(customerId, previewIntentDim, previewSourceDim);
    const variant = await env.VARIANTS.get<VariantBody>(kvKey, "json");
    const template =
      DEFAULT_VARIANT_TEMPLATES[previewIntentDim as keyof typeof DEFAULT_VARIANT_TEMPLATES] ??
      DEFAULT_VARIANT_TEMPLATES.brand;
    const resp: SelectResponse = {
      source: "preview",
      variant_key: kvKey,
      variant: variant ?? template,
      selection: { intent_dim: previewIntentDim, source_dim: previewSourceDim, confidence: 1.0 },
      classifier: {
        ai_source: signals.aiSource,
        app_source: signals.appSource?.app ?? null,
        click_id: signals.clickId ?? null,
        is_bot: false,
      },
    };
    return jsonNoStore(resp);
  }

  // -----------------------------------------------------------------------
  // Of where the visitor is, the edge reads the country and nothing finer.
  // The connection's time zone is not read (privacy review, 2026-11-16): it
  // is located from the address and is finer than a country, and the one
  // value it fed, context.offhours_context, chose nothing. classify() works
  // that value out on the UTC clock when it is given no zone.
  // -----------------------------------------------------------------------
  // Original-content guard: when no meaningful signal arrived (no UTM, no
  // external referrer, no AI source), the customer's hand-written page is
  // the best answer. Snapping every direct visitor to brand/direct snaps
  // the *absence* of signal into a snapped variant, which can serve the
  // wrong audience (e.g. a returning visitor who already knows the brand).
  //
  // Product rule (ADR pending): "personalize only when there's a reason."
  // -----------------------------------------------------------------------
  // Session carry (docs/specs/session-carry.md): the tab offers what the
  // edge decided for a signal-bearing landing. Used whole when this page
  // carries nothing itself, for its source word when the page's only signal
  // is its path (combineCarry), never when the customer turned it off; two
  // dimension names, never an identifier.
  const carried = parseCarry(url.searchParams.get("carry"));
  // A source of the page's own (utm, referrer, AI, app, click id). The
  // site map is a path, never a source (site-shaped-intents §11).
  const ownSource = termCame || hasSourceSignal(signals);

  /**
   * A deleted customer (closed.ts): the page as built and nothing recorded.
   * No bundle written back, no targets, no arm, no selection.
   */
  const closedAnswer = (): Response =>
    jsonNoStore({ source: "original", variant_key: "", variant: null, off: 1 } as SelectResponse);

  /**
   * An audit customer's request from another host or after the audit's end
   * (audit.ts, privacy review condition 1): the bot answer, so even a snippet that
   * predates `off` records nothing, and `off: 1`, so the snippet clears the
   * tab's visit, carry and body keys and asks nothing more. Nothing written
   * back, nothing logged.
   */
  const auditOffAnswer = (): Response =>
    jsonNoStore({
      source: "fallback-canonical-bot",
      variant_key: "",
      variant: null,
      off: 1,
    } as SelectResponse);

  /** The page as built: no signal of its own, and no carry the edge may use. */
  const noSignalAnswer = (
    nsBundle: VisitorBundle | null,
    extra: Partial<SelectResponse> = {},
  ): Response => {
    if (nsBundle?.v !== 1) ctx.waitUntil(writeBundleFromD1(env, customerId));
    // A picked button counts only on its own page (visual-picker.md §9); a
    // group's on a matching page that is not confirmed (page-groups.md).
    const pageTargets =
      nsBundle?.v === 1 ? conversionTargetsForPage(nsBundle.conv, pagePath, nsBundle.pages) : [];
    // Page one chooses page two (docs/specs/direct-visitors.md §4): the
    // page's word for the tab's carry and each counted button's word. Not
    // when the customer turned the carries off.
    // Nor over the visitor's own answer (§2), which holds for the tab.
    const pageOne: { kc?: string; targets: WordTarget[] } =
      extra.carry_off || choiceSlotOf(url.searchParams.get("carry"))
        ? { targets: pageTargets }
        : pageOneFields(nsBundle, pagePath, pageTargets);
    const nsTargets = pageOne.targets;
    // L2 Layer D: the snippet sends the navigation type it read from the
    // Performance API (navigate / reload / back_forward). A phone, an empty
    // referrer, no UTM and a fresh navigation is almost never a typed URL.
    const nav = url.searchParams.get("nav");
    const darkSocialProbable =
      signals.appSource?.confidence === "low" ||
      (signals.device === "mobile" &&
        signals.referrerHost === null &&
        Object.keys(signals.utm).length === 0 &&
        (nav === null || nav === "navigate"));
    const noSignalResp: SelectResponse = {
      source: "original",
      variant_key: "",
      variant: null,
      cohort: "no_signal",
      dark_social_probable: darkSocialProbable,
      ...(nsTargets.length > 0 ? { conversion_targets: nsTargets } : {}),
      selection: { intent_dim: "none", source_dim: "none", confidence: 0 },
      ...(pageOne.kc ? { kc: pageOne.kc } : {}),
      ...(includeClassifier
        ? {
            classifier: {
              ai_source: signals.aiSource,
              app_source: signals.appSource?.app ?? null,
              click_id: signals.clickId ?? null,
              is_bot: false,
            },
          }
        : {}),
      ...extra,
    };
    // V2 Module 3: /select no longer writes events. The snippet fires
    // 'no_signal_passthrough' via POST /event after observing this response.
    // This unifies the write path and means "event count" equals "personalization
    // outcomes actually reaching visitors" (the snippet failing to load or run
    // is NOT counted, which is the true metric we want).
    return jsonNoStore(noSignalResp);
  };

  /**
   * A visit with no signal of its own on a page confirmed for its own path
   * (docs/specs/direct-visitors.md §3, §5): a market version, else the
   * learned default's draw, else null and the page as built. KV only: one
   * more batch (the language, the carry switch, the version), through the
   * warm copy. The 20% test's coin first, as for every answer that would
   * show a version: a holdout visit gets the page as built, nothing drawn
   * shown and nothing kept. The draw is the edge's own random number, never
   * the visit marker.
   */
  const directVisit = async (
    b: VisitorBundle | null,
    extra: Partial<SelectResponse> = {},
  ): Promise<Response | null> => {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const plan = planDirect(b, pagePath, {
      country: cf?.country,
      lang: url.searchParams.get("lang"),
      carry: url.searchParams.get("carry"),
      r: (r[0] ?? 0) / 2 ** 32,
    });
    if (!plan || b?.v !== 1) return null;
    const manifest = b.pages[pagePath] as Manifest;
    const plang = primaryLang(url.searchParams.get("plang"));
    const key =
      plan.kind === "o" ? null : variantKeyForPath(customerId, pagePath, plan.intent, plan.source);
    froms.length = 0;
    const [langValue, offNow, bodyRead] = await Promise.all([
      plang
        ? readThrough(env.VARIANTS, customerLangKey(customerId), "lang", "text", copyIo).then(
            (r) => r.value as string | null,
          )
        : Promise.resolve(null),
      isCarryOff(env.VARIANTS, customerId, copyIo),
      key
        ? readThrough(env.VARIANTS, key, "body", "json", copyIo, { store: false })
        : Promise.resolve(null),
    ]);
    lap("kv2");
    if (key && bodyRead) keepBodies([{ key, path: pagePath, read: bodyRead }], b);
    // The learned default holds a visit on one arm through the tab's carry:
    // with the carry off it is not drawn at all (§3).
    if (plan.kind !== "m" && offNow) return null;
    // The versions of this path are in its language; a page shown in another
    // one keeps the page as built.
    const written = plang ? briefLangFor(langValue, pagePath) : null;
    if (plang && written && written !== plang) return null;
    const body = (bodyRead?.value ?? null) as VariantBody | null;
    if (key && !body) return null;
    const selection =
      plan.kind === "o"
        ? { intent_dim: "none", source_dim: "none", confidence: 0 }
        : { intent_dim: plan.intent, source_dim: "direct", confidence: 0.5 };
    const bodyId = body ? parseBodyId(body.body_id) : null;
    const targets = conversionTargetsForPage(b.conv, pagePath, b.pages);
    const targetsOut = targets.length > 0 ? { conversion_targets: targets } : {};
    const arm = await decideArm(
      customerId,
      parseVisit(url.searchParams.get("visit")),
      bundleHoldout(b, env.HOLDOUT_PERCENT),
    );
    if (arm === "holdout") {
      return jsonNoStore({
        source: "holdout",
        variant_key: "",
        variant: null,
        cohort: "holdout",
        arm,
        ...(bodyId ? { body_id: bodyId } : {}),
        // A held original keeps its carry; anything else keeps nothing.
        ...(plan.kind === "o" && plan.held ? {} : { kc: "" }),
        ...(offNow ? { carry_off: true } : {}),
        ...targetsOut,
        selection,
      } satisfies SelectResponse);
    }
    if (plan.kind === "o") {
      // The page as built, chosen: the passthrough and the clicks carry the
      // arm and `nd`; a fresh draw is kept for the visit as `none:direct`.
      return jsonNoStore({
        source: "original",
        variant_key: "",
        variant: null,
        cohort: "no_signal",
        ...(arm ? { arm } : {}),
        ...(plan.held ? {} : { kc: HELD_ORIGINAL, nd: plan.nd }),
        ...targetsOut,
        selection,
        ...extra,
      } satisfies SelectResponse);
    }
    return jsonNoStore({
      source: "kv",
      variant_key: key ?? "",
      variant: bodyForVisitors(customerId, body as VariantBody, manifest, ownSiteCustomer(env)),
      cohort: "personalized",
      ...(arm ? { arm } : {}),
      ...(bodyId ? { body_id: bodyId } : {}),
      targets: forVisitors(manifest),
      ...(offNow ? { carry_off: true } : { carryable: true }),
      ...targetsOut,
      // A market keeps nothing (the next page asks again and gets the same
      // market); a learned version is kept by the snippet's own rule as
      // `{intent}:direct`, so the visit stays on it.
      ...(plan.kind === "m" ? { kc: "" } : {}),
      nd: plan.nd,
      selection,
      ...extra,
    } satisfies SelectResponse);
  };

  /**
   * The answer a visitor chose (docs/specs/direct-visitors.md §2), kept in the
   * tab's carry as `q{slot}:direct`: the version it points to on this page,
   * its own then the base one, as a carried selection with `nd: "c:{slot}"`.
   * Null when the question is off or killed (the carry is then ignored and
   * the page is as built), the page has no versions of its own, or no body.
   */
  const choiceVisit = async (b: VisitorBundle | null): Promise<Response | null> => {
    const slot = choiceSlotOf(url.searchParams.get("carry"));
    if (!slot || !choiceOn(b) || !(b.qc || b.ql)) return null;
    const qc = await choiceForPage(b);
    const answer = qc?.a.find((x) => x[0] === slot);
    const manifest = b.pages[pagePath] as Manifest | undefined;
    if (!answer || !manifest) return null;
    const [, , intent, source] = answer;
    const keys = [...new Set([source, "default"])].map((src) =>
      variantKeyForPath(customerId, pagePath, intent, src),
    );
    const plang = primaryLang(url.searchParams.get("plang"));
    froms.length = 0;
    const [langValue, offNow, ...reads] = await Promise.all([
      plang
        ? readThrough(env.VARIANTS, customerLangKey(customerId), "lang", "text", copyIo).then(
            (r) => r.value as string | null,
          )
        : Promise.resolve(null),
      isCarryOff(env.VARIANTS, customerId, copyIo),
      ...keys.map((k) => readThrough(env.VARIANTS, k, "body", "json", copyIo, { store: false })),
    ]);
    lap("kv2");
    if (offNow) return null;
    const written = plang ? briefLangFor(langValue, pagePath) : null;
    if (plang && written && written !== plang) return null;
    keepBodies(
      keys.map((k, i) => ({ key: k, path: pagePath, read: reads[i] as CopyRead })),
      b,
    );
    const at = reads.findIndex((r) => (r as CopyRead).value);
    if (at < 0) return null;
    const body = (reads[at] as CopyRead).value as VariantBody;
    const bodyId = parseBodyId(body.body_id);
    const targets = conversionTargetsForPage(b.conv, pagePath, b.pages);
    const selection = { intent_dim: intent, source_dim: "direct", confidence: 0.6 };
    const arm = await decideArm(
      customerId,
      parseVisit(url.searchParams.get("visit")),
      bundleHoldout(b, env.HOLDOUT_PERCENT),
    );
    if (arm === "holdout") {
      return jsonNoStore({
        source: "holdout",
        variant_key: "",
        variant: null,
        cohort: "holdout",
        arm,
        ...(bodyId ? { body_id: bodyId } : {}),
        carried: true,
        ...(targets.length > 0 ? { conversion_targets: targets } : {}),
        selection,
      } satisfies SelectResponse);
    }
    return jsonNoStore({
      source: "kv",
      variant_key: keys[at] ?? "",
      variant: bodyForVisitors(customerId, body, manifest, ownSiteCustomer(env)),
      cohort: "personalized",
      ...(arm ? { arm } : {}),
      ...(bodyId ? { body_id: bodyId } : {}),
      carried: true,
      targets: forVisitors(manifest),
      carryable: true,
      ...(targets.length > 0 ? { conversion_targets: targets } : {}),
      // A remembered answer (the visitor came back) is told apart from one
      // taken in this tab: counts only (§2).
      nd: `${choiceRecalled(url.searchParams.get("carry")) ? "r" : "c"}:${slot}`,
      selection,
    } satisfies SelectResponse);
  };

  /**
   * The question whose answers this page reads (§2): the one of the language
   * home in the page's language (a visitor who answered on `/az` reads the
   * Azerbaijani answers on `/az/...`), else `/`'s.
   */
  const choiceForPage = async (b: VisitorBundle): Promise<ChoiceConfig | undefined> => {
    if (!b.ql) return b.qc;
    const own = b.ql[pagePath];
    if (own) return own;
    const langValue = (
      await readThrough(env.VARIANTS, customerLangKey(customerId), "lang", "text", copyIo)
    ).value as string | null;
    const lang = briefLangFor(langValue, pagePath);
    for (const [home, c] of Object.entries(b.ql)) {
      if (lang && briefLangFor(langValue, home) === lang && lang !== briefLangFor(langValue, "/"))
        return c;
    }
    return b.qc;
  };

  /**
   * Whether this load is asked the question (§2): the home page, a visit with
   * no signal and no carry at all, the question on. The 20% test's coin
   * first: the comparison group is never asked and sees the page as built
   * (a holdout answer). Else the question rides on whatever answer the visit
   * gets, with the arm.
   */
  const askFor = async (
    b: VisitorBundle | null,
  ): Promise<{ holdout: Response } | { extra: Partial<SelectResponse> } | null> => {
    if (url.searchParams.get("carry") || !choiceOn(b)) return null;
    // The question of this language home (`/`, or `/az` in Azerbaijani).
    const qc = pagePath === "/" ? b.qc : b.ql?.[pagePath];
    if (!qc || !b.pages[pagePath]) return null;
    // The question's words and the versions its answers open are in the
    // brief's language: a page shown in another one (the pilot's English is the
    // same address with `lang="en"`) is not asked, as it gets no version.
    const plang = primaryLang(url.searchParams.get("plang"));
    if (plang) {
      const langValue = (
        await readThrough(env.VARIANTS, customerLangKey(customerId), "lang", "text", copyIo)
      ).value as string | null;
      const written = briefLangFor(langValue, pagePath);
      if (written && written !== plang) return null;
    }
    const arm = await decideArm(
      customerId,
      parseVisit(url.searchParams.get("visit")),
      bundleHoldout(b, env.HOLDOUT_PERCENT),
    );
    if (arm === "holdout") {
      const targets = conversionTargetsForPage(b.conv, pagePath, b.pages);
      return {
        holdout: jsonNoStore({
          source: "holdout",
          variant_key: "",
          variant: null,
          cohort: "holdout",
          arm,
          kc: "",
          ...(targets.length > 0 ? { conversion_targets: targets } : {}),
          selection: { intent_dim: "none", source_dim: "none", confidence: 0 },
        } satisfies SelectResponse),
      };
    }
    return { extra: { q: choiceClient(qc, false, b.rm === 1), ...(arm ? { arm } : {}) } };
  };

  // Site-shaped intents (docs/specs/site-shaped-intents.md §6.3): the
  // customer's map (`pm`) and served set (`sd`) ride in the visitor bundle.
  // A page with no signal of its own and no carry reads the bundle anyway
  // (one read, as before); only when the map opens it are its versions read,
  // once. Every other visit is classified with the global table first and
  // reads the bundle and that cell's versions in one batch; the map and the
  // fold are applied once the bundle is in hand, and a second batch is read
  // only when they change the cell.
  let preBundle: VisitorBundle | null = null;
  let preRead = false;
  if (!meaningfulSignal(signals) && !carried) {
    // The conversion targets reach the no-signal page too (proof engine,
    // fault 2): one KV read, through the copy (at most 300 s from KV).
    // The tombstone rides in the same batch (no round trip of its own).
    const [nsRead, nsClosed] = await Promise.all([
      readThrough(env.VARIANTS, visitorBundleKey(customerId), "bundle", "json", copyIo),
      isClosed(env.VARIANTS, customerId, Date.now(), copyIo),
    ]);
    const nsBundle = nsRead.value as VisitorBundle | null;
    lap("kv");
    lap.note(`cache;desc=${batchWord(froms)}`);
    readKeyword(nsBundle);
    if (nsClosed) return closedAnswer();
    const nsAudit = auditOf(nsBundle);
    if (refusedByAudit(nsAudit, request)) return auditOffAnswer();
    learn(nsAudit, nsBundle);
    if (!meaningfulSignal(withSiteMap(signals, nsBundle, pagePath))) {
      // The visitor's own answer first, then the question (the test's coin
      // first), then a market or the learned default, then the page as built
      // (docs/specs/direct-visitors.md §2, §3, §5).
      const chosen = await choiceVisit(nsBundle);
      if (chosen) return chosen;
      const ask = await askFor(nsBundle);
      if (ask && "holdout" in ask) return ask.holdout;
      const extra = ask?.extra ?? {};
      return (await directVisit(nsBundle, extra)) ?? noSignalAnswer(nsBundle, extra);
    }
    preBundle = nsBundle;
    preRead = true;
  }

  // -----------------------------------------------------------------------
  // Normal path: classify → fold → select → KV cascade → event write.
  // -----------------------------------------------------------------------
  const nowMs = Date.now();
  /**
   * One view of the visit: classify, fold the unserved intents, argmax,
   * carry. `raw` reuses a vector already classified from the same path
   * weights (no map entry covers the page), so the second view costs no
   * second classification.
   */
  const decide = (
    sig: Signals,
    sd: readonly IntentDim[] | undefined,
    raw: IntentVector = classify(sig, nowMs, null),
  ) => {
    const vector = foldVector(raw, sd);
    const fresh = selectVariantKey(vector);
    const meaningful = meaningfulSignal(sig);
    // A carried label the site no longer serves folds the same way (§11.4).
    const carry = carried
      ? { intent_dim: foldIntentDim(carried.intent_dim, sd), source_dim: carried.source_dim }
      : null;
    const selection = combineCarry(fresh, carry, { meaningful, source: ownSource });
    return { fresh, meaningful, selection, raw };
  };
  const first = preRead
    ? decide(withSiteMap(signals, preBundle, pagePath), preBundle?.sd)
    : decide(signals, undefined);

  // -----------------------------------------------------------------------
  // Language gate. The snippet sends the page's own language as `plang`
  // (URL prefix, subdomain, hreflang, <html lang>); the brief language sits
  // in KV, written on DNA upsert. When the two differ, the versions would
  // put Azerbaijani copy on an English page (a pilot site, 2026-09-11): keep
  // the original, flag it, count it. One KV read, only when plang is sent.
  // -----------------------------------------------------------------------
  // Every KV read this answer can need, at once (2026-10-01, the /select
  // tail): the version cascade, the visitor bundle (manifests and conversion
  // targets, no database), the carry switch and the brief language. Read one
  // after another, two cold reads and a D1 round trip added up to 572 ms;
  // together they take the time of the slowest one.
  // The source part of the key: a feed ad's paid visit reads the `social`
  // versions, every other selection its own (ads-platforms.md §4); the
  // selection and the events keep `paid`.
  const candidatesFor = (sel: { intent_dim: string; source_dim: SourceDim }, rootToo = true) => {
    const out: Array<{ key: string; source: SelectResponse["source"]; path: string }> = [];
    const seen = new Set<string>();
    const keySource = versionSourceDim(sel.source_dim, signals);
    for (const p of pagePath === "/" || !rootToo ? [pagePath] : [pagePath, "/"]) {
      for (const src of [keySource, "default"]) {
        const key = variantKeyForPath(customerId, p, sel.intent_dim, src);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, source: src === "default" ? "kv-sentinel" : "kv", path: p });
      }
    }
    return out;
  };
  // The customer's carry switch is read in the batch below, after the
  // selection. When the selection used the carry on a page with a path of
  // its own, the page's own versions are read in the same batch, so a
  // switched-off carry falls back without a second round trip.
  const firstUncarried =
    first.selection.carried && first.meaningful ? candidatesFor(first.fresh) : [];
  const firstCands = [...candidatesFor(first.selection), ...firstUncarried];
  const firstKeys = [...new Set(firstCands.map((c) => c.key))];
  /** The page path of each body key read, for the copy's keep rule. */
  const pathOfKey = new Map(firstCands.map((c) => [c.key, c.path]));
  const pageLang = primaryLang(url.searchParams.get("plang"));
  froms.length = 0;
  const [langValue, readBundle, carryOff, closed, ...read] = await Promise.all([
    pageLang
      ? readThrough(env.VARIANTS, customerLangKey(customerId), "lang", "text", copyIo).then(
          (r) => r.value as string | null,
        )
      : Promise.resolve(null),
    preRead
      ? Promise.resolve(preBundle)
      : readThrough(env.VARIANTS, visitorBundleKey(customerId), "bundle", "json", copyIo).then(
          (r) => r.value as VisitorBundle | null,
        ),
    isCarryOff(env.VARIANTS, customerId, copyIo),
    // The fast path above already read the tombstone when it ran.
    preRead ? Promise.resolve(false) : isClosed(env.VARIANTS, customerId, Date.now(), copyIo),
    // Bodies are read through the copy but kept only once the bundle says
    // their path is `/` or one of its pages (privacy review condition 2).
    ...firstKeys.map((k) => readThrough(env.VARIANTS, k, "body", "json", copyIo, { store: false })),
  ]);
  lap("kv");
  lap.note(`cache;desc=${batchWord(froms)}`);
  if (closed) return closedAnswer();
  const bundle = readBundle as VisitorBundle | null;
  const bodyReads = read as CopyRead[];
  keepBodies(
    firstKeys.map((k, i) => ({ key: k, path: pathOfKey.get(k) ?? "", read: bodyReads[i] })),
    bundle,
  );
  // The fast path above already matched it against the same bundle.
  if (!preRead) readKeyword(bundle);
  // Host and end, from the bundle in hand (the fast path above checked the
  // same bundle already), before any answer that leads to an event.
  const audit = auditOf(bundle);
  if (refusedByAudit(audit, request)) return auditOffAnswer();
  if (!preRead) learn(audit, bundle);
  const byKey = new Map(
    firstKeys.map((k, i) => [k, (bodyReads[i]?.value ?? null) as VariantBody | null]),
  );

  // The map and the fold, now that the bundle is here. An old bundle (no
  // `pm`, no `sd`) gives the global table's answer; decision 2's gate (a
  // path opens only a page with its own versions) holds for any bundle.
  const mapped = withSiteMap(signals, bundle, pagePath);
  // The first view was classified before the bundle, so without the
  // keyword's intent: a matched keyword classifies again, like a map entry.
  const decided = preRead
    ? first
    : decide(mapped, bundle?.sd, mapped.sitePath || signals.keywordIntent ? undefined : first.raw);
  const { fresh, meaningful } = decided;
  let selection = decided.selection;
  // The gate closed once the bundle was read: the path was the only reason
  // and its page has no versions of its own, or the operator set it to "no
  // intent". The page as built, never the homepage's versions.
  if (!meaningful && !carried) return noSignalAnswer(bundle);
  // The customer turned the carry off: the edge ignores `carry=` too, so a
  // tab on a cached /s/{id}.js from before the switch is never carried
  // (docs/specs/session-carry.md, the privacy review's note of 2026-10-05). The
  // answer says carry_off, and the snippet then drops what the tab kept.
  if (carryOff && selection.carried) {
    if (!meaningful) {
      return noSignalAnswer(bundle, { carry_off: true });
    }
    selection = { ...fresh, carried: false };
  }
  // The language the versions for this path were written in, and the
  // root's (per-language.md): from the one value read above, nothing more.
  const briefLang = pageLang ? briefLangFor(langValue, pagePath) : null;
  const rootLang = pageLang ? briefLangFor(langValue, "/") : null;
  // The root's versions are in the root's language. A page in another
  // language (`/az/work` under `/az`, or a listed `/az` with no versions of
  // its own yet) is never offered them, whatever script the browser runs
  // (quiet-swap.md §2b guards only the current one). No language in hand
  // (no plang, no value): the cascade as before.
  const rootOffered = !briefLang || !rootLang || briefLang === rootLang;
  const candidates = candidatesFor(selection, rootOffered);
  // The map or the fold moved the cell: its versions, in one more batch
  // (§6.3). Unchanged cells find every key already read.
  const missing = candidates.filter((c) => !byKey.has(c.key));
  if (missing.length > 0) {
    const more = await Promise.all(
      missing.map((c) =>
        readThrough(env.VARIANTS, c.key, "body", "json", copyIo, { store: false }),
      ),
    );
    keepBodies(
      missing.map((c, i) => ({ key: c.key, path: c.path, read: more[i] as CopyRead })),
      bundle,
    );
    missing.forEach((c, i) =>
      byKey.set(c.key, ((more[i] as CopyRead).value as VariantBody | null) ?? null),
    );
    lap("kv2");
  }
  // The map decided this page's intent: a mapped kind that raises an
  // intent, used for this answer (not a carried pair taken whole).
  const sitePathUsed =
    mapped.sitePath != null &&
    kindCarriesIntent(mapped.sitePath.kind) &&
    !(selection.carried && !meaningful);
  const usedCarry = selection.carried;
  // A `direct` carry on a page that names another word: the tab keeps the
  // new word for the next page (docs/specs/direct-visitors.md §4).
  const nextWord = usedCarry ? nextWordCarry(bundle, pagePath, carried) : null;
  const kcField = nextWord && !carryOff ? { kc: nextWord } : {};
  const bodies = candidates.map((c) => byKey.get(c.key) ?? null);
  const hasBundle = (bundle as VisitorBundle | null)?.v === 1;
  // Targets for the answers that show the original (holdout, no version,
  // another language): from the bundle, never a database read for them.
  const bundleTargets = hasBundle
    ? conversionTargetsForPage(
        (bundle as VisitorBundle).conv,
        pagePath,
        (bundle as VisitorBundle).pages,
      )
    : [];
  const targetsField = bundleTargets.length > 0 ? { conversion_targets: bundleTargets } : {};
  if (pageLang) {
    // The KV value is a path → language map (per-language generation,
    // docs/specs/per-language.md); a bare tag from before the map still
    // reads as the primary. The page's own path wins, then its longest
    // listed prefix, else the root's.
    if (briefLang && briefLang !== pageLang) {
      if (!hasBundle) ctx.waitUntil(writeBundleFromD1(env, customerId));
      const mismatchResp: SelectResponse = {
        source: "original",
        variant_key: "",
        variant: null,
        cohort: "no_signal",
        language_mismatch: true,
        ...targetsField,
        selection: { intent_dim: "none", source_dim: "none", confidence: 0 },
      };
      return jsonNoStore(mismatchResp);
    }
  }

  // The cascade's first body found, in its priority order (read above):
  //   1. exact path + exact source, 2. exact path + "default",
  //   3. root '/' + exact source, 4. root '/' + "default".
  let variant: VariantBody | null = null;
  let resolvedKey = candidates[0]?.key ?? variantKey(customerId, selection.intent_dim, "default");
  let resolvedSource: SelectResponse["source"] = "kv";
  for (let i = 0; i < candidates.length; i++) {
    const body = bodies[i] as VariantBody | null;
    const candidate = candidates[i];
    if (body && candidate) {
      variant = body;
      resolvedKey = candidate.key;
      resolvedSource = candidate.source;
      break;
    }
  }

  if (!variant) {
    // No version written for this customer yet: the tag is installed but
    // go-live has not happened (the script-first window), or a path has no
    // versions. Serve the page as it is. The in-bundle templates are
    // "[PLACEHOLDER]" scaffolding for previews and tests and must never
    // reach a visitor's h1 (seen on a pilot site during the 2026-09-11 reset).
    if (!hasBundle) ctx.waitUntil(writeBundleFromD1(env, customerId));
    const notReady: SelectResponse = {
      source: "original",
      variant_key: "",
      variant: null,
      cohort: "no_signal",
      not_ready: true,
      ...targetsField,
      ...kcField,
      selection: {
        intent_dim: selection.intent_dim,
        source_dim: selection.source_dim,
        confidence: selection.confidence,
      },
    };
    return jsonNoStore(notReady);
  }

  // -----------------------------------------------------------------------
  // The holdout (docs/specs/proof-engine.md, section A), decided only now:
  // a human visit, not a preview, with a signal or a carry, in the versions'
  // language, and a version found for the page. Then the tab's visit marker
  // and the customer's percent from the bundle; no marker or no bundle, no
  // arm. Deciding after the cascade keeps both arms the same population.
  // -----------------------------------------------------------------------
  // N1 and N3, from this request's own signals (a carried page has none, so
  // neither; the aggregator takes the visit's landing value).
  const sourceName = sourceNameFor(signals, selection.source_dim);
  // How the source was recognised, audit customers only, and only when this
  // request carried a source of its own (never a path, never a carry).
  const found = audit && ownSource ? foundIfAudit : null;
  const sourceFacts = {
    ...(sourceName ? { source_name: sourceName } : {}),
    ...(ownTagged ? { tagged: true as const } : {}),
    ...(found ? { found_by: found } : {}),
  };
  const bodyId = parseBodyId(variant.body_id);
  const arm = await decideArm(
    customerId,
    parseVisit(url.searchParams.get("visit")),
    bundleHoldout(bundle as VisitorBundle | null, env.HOLDOUT_PERCENT),
  );
  if (arm === "holdout") {
    if (!hasBundle) ctx.waitUntil(writeBundleFromD1(env, customerId));
    // Lean (privacy review condition 6): the arm, the would-be version's id and
    // the targets; never the body, the manifest or the vector.
    const holdoutResp: SelectResponse = {
      source: "holdout",
      variant_key: "",
      variant: null,
      cohort: "holdout",
      arm,
      ...(bodyId ? { body_id: bodyId } : {}),
      ...(usedCarry ? { carried: true } : {}),
      ...(carryOff ? { carry_off: true } : {}),
      ...(sitePathUsed ? { site_path: true } : {}),
      ...sourceFacts,
      ...targetsField,
      ...kcField,
      // The selection lets the holdout events name the cell they are the
      // control for, and the snippet carry it to page two (same arm again).
      selection: {
        intent_dim: selection.intent_dim,
        source_dim: selection.source_dim,
        confidence: selection.confidence,
      },
      ...(includeClassifier
        ? {
            classifier: {
              ai_source: signals.aiSource,
              app_source: signals.appSource?.app ?? null,
              click_id: signals.clickId ?? null,
              is_bot: false,
            },
          }
        : {}),
    };
    return jsonNoStore(holdoutResp);
  }

  // -----------------------------------------------------------------------
  // D1 manifest read: conditional, one read per /select for customers that
  // have a confirmed element manifest. Confirmed = confirmed_at IS NOT NULL.
  // Injects `targets` as a sibling field on the response envelope so the
  // snippet's Tier 3 finder can walk css → text → structural selectors.
  // Skip for bot path (handled above) and preview path (handled above).
  // One indexed D1 read; ~1-5ms; no new event writes; no visitor data stored.
  // -----------------------------------------------------------------------
  // The bundle answers from KV; without one (not written yet) the database
  // answers as before and the bundle is written for the next visit.
  let manifestRow: { manifest: Manifest; path: string } | null;
  let conversionTargets: ConversionTargetForClient[];
  if (bundle?.v === 1) {
    const exact = bundle.pages[pagePath];
    const root = bundle.pages["/"];
    manifestRow = exact
      ? { manifest: exact as Manifest, path: pagePath }
      : root
        ? { manifest: root as Manifest, path: "/" }
        : null;
    conversionTargets = bundleTargets;
  } else {
    const [storedRow, storedTargets] = await Promise.all([
      fetchConfirmedManifestRow(env.DB, customerId, pagePath),
      fetchConversionTargets(env.DB, customerId),
    ]);
    // The stored manifest holds every part. The bundle holds the parts
    // Rawuser writes: without a button the operator has not turned on
    // (docs/specs/button-rewrite.md). This answer says what the bundle
    // written back below will say, so an off button is never a target here
    // either, and an older body's label for it is not written.
    manifestRow = storedRow
      ? { manifest: writtenManifest(storedRow.manifest), path: storedRow.path }
      : null;
    // The database answered for this exact page or for `/`: only an exact
    // row makes this page a confirmed one (page-groups.md: a confirmed page
    // inside a pattern gets nothing from the group). No extra read.
    conversionTargets = conversionTargetsForPage(
      storedTargets,
      pagePath,
      storedRow?.path === pagePath ? { [pagePath]: 1 } : {},
    );
    lap("d1");
    ctx.waitUntil(writeBundleFromD1(env, customerId));
  }

  const confirmedManifest = manifestRow?.manifest ?? null;
  const resp: SelectResponse = {
    source: resolvedSource,
    variant_key: resolvedKey,
    // The words of a button that is off are left out (task H9): the manifest
    // in hand says which, no read. `body_id` below stays the stored body's.
    variant: bodyForVisitors(customerId, variant, confirmedManifest, ownSiteCustomer(env)),
    cohort: "personalized",
    ...(arm ? { arm } : {}),
    ...(bodyId ? { body_id: bodyId } : {}),
    ...(usedCarry ? { carried: true } : {}),
    ...(sitePathUsed ? { site_path: true } : {}),
    ...sourceFacts,
    ...(confirmedManifest !== null ? { targets: forVisitors(confirmedManifest) } : {}),
    // Body carry (docs/specs/interactive-text.md §3.1 b): the page's copy
    // may be kept for the visit when the page has a confirmed manifest; the
    // customer's "off" reaches the browser on every answer (condition 6).
    // Only a page confirmed for its own path, never one borrowing the root's
    // manifest (the privacy review's condition 2).
    ...(manifestRow !== null && manifestRow.path === pagePath && !carryOff
      ? { carryable: true }
      : {}),
    ...(carryOff ? { carry_off: true } : {}),
    ...(conversionTargets.length > 0 ? { conversion_targets: conversionTargets } : {}),
    ...kcField,
    selection: {
      intent_dim: selection.intent_dim,
      source_dim: selection.source_dim,
      confidence: selection.confidence,
    },
    ...(includeClassifier
      ? {
          classifier: {
            ai_source: signals.aiSource,
            app_source: signals.appSource?.app ?? null,
            click_id: signals.clickId ?? null,
            is_bot: false,
          },
        }
      : {}),
  };

  // V2 Module 3: /select no longer writes events directly. The snippet fires
  // 'variant_shown' via POST /event after a successful applyVariant. Rationale:
  //   - Single source of truth (no double-counting risk in aggregator).
  //   - Counts only personalization that actually reached the visitor (snippet
  //     blocked by CSP / ad blocker → no event → accurate "reached" metric).
  //   - Snippet has location.pathname for page_path attribution; edge does not.

  return jsonNoStore(resp);
}

// ---------------------------------------------------------------------------
// Manifest fetch: conditional D1 read for confirmed element manifests.
// ---------------------------------------------------------------------------

/**
 * Reads the confirmed element manifest for a customer from D1.
 * Returns null when no row exists OR when confirmed_at IS NULL.
 *
 * Privacy: this read is pure data (customer-operator configuration); it adds
 * no visitor data to the response and writes nothing to D1.
 * One indexed read per /select: ~1-5ms on D1 local; acceptable for V1.
 */
/** The confirmed manifest for this path or the root's, with the path it was confirmed for. */
async function fetchConfirmedManifestRow(
  db: D1Database,
  customerId: string,
  pagePath: string,
): Promise<{ manifest: Manifest; path: string } | null> {
  try {
    // Per-path selection (A1): prefer the manifest confirmed for this exact
    // path; fall back to the '/' (homepage) manifest. The ORDER BY puts an
    // exact-path match first; `page_path IN (?, '/')` bounds the scan to at
    // most two candidate rows. For pagePath '/', both bind params are '/'
    // so this collapses to the original single-row read: no regression.
    const row = await db
      .prepare(
        `SELECT manifest, page_path FROM element_manifests
         WHERE customer_id = ? AND confirmed_at IS NOT NULL
           AND page_path IN (?, '/')
         ORDER BY (page_path = ?) DESC
         LIMIT 1`,
      )
      .bind(customerId, pagePath, pagePath)
      .first<{ manifest: string; page_path?: string }>();

    if (!row) return null;

    return { manifest: JSON.parse(row.manifest) as Manifest, path: row.page_path ?? "/" };
  } catch {
    // Manifest read failure is non-critical: the visitor still gets a variant.
    // Log only a safe constant to avoid surfacing internal state.
    console.error("[rawuser/edge] manifest read failed (non-critical)");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversion targets fetch (V2 Module 3): one indexed D1 read per /select.
// ---------------------------------------------------------------------------

/**
 * Reads enabled conversion targets for a customer from D1.
 * Returns [] when none exist or on any read failure (degrade gracefully:
 * personalization still works without click tracking).
 *
 * Selectors are stored denormalized as JSON arrays in conversion_targets;
 * we parse them here so the snippet receives the canonical shape used by
 * its 3-tier element finder.
 */
async function fetchConversionTargets(
  db: D1Database,
  customerId: string,
): Promise<ConversionTargetForClient[]> {
  interface Row {
    section_path: string;
    conversion_label: string;
    css_selectors: string;
    text_selectors: string;
    structural_selector: string;
  }
  try {
    const result = await db
      .prepare(
        `SELECT section_path, conversion_label, css_selectors, text_selectors, structural_selector
         FROM conversion_targets
         WHERE customer_id = ? AND enabled = 1`,
      )
      .bind(customerId)
      .all<Row>();

    const rows = result.results ?? [];
    const targets: ConversionTargetForClient[] = [];
    for (const r of rows) {
      try {
        targets.push({
          section_path: r.section_path,
          conversion_label: r.conversion_label,
          css: JSON.parse(r.css_selectors) as string[],
          text: JSON.parse(r.text_selectors) as string[],
          structural: r.structural_selector,
        });
      } catch {
        // Skip rows with corrupt selector JSON: don't block the others.
      }
    }
    return targets;
  } catch {
    console.error("[rawuser/edge] conversion_targets read failed (non-critical)");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPreviewAuthed(request: Request, env: Env): boolean {
  const token = request.headers.get("x-rawuser-preview");
  return token !== null && env.PREVIEW_TOKEN !== "" && token === env.PREVIEW_TOKEN;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Snippet is loaded cross-origin on every customer site, so /select and
      // /health must be readable from any origin. Same policy as /snippet.js
      // and /select-bulk. Wildcard is safe because responses carry no
      // credentials and no per-visitor identifiers (privacy invariant in
      // ADR 0003 / 0006).
      "access-control-allow-origin": "*",
    },
  });
}

/** All /select responses must not be cached by any CDN/proxy. */
function jsonNoStore(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// /snippet.js: bundled client snippet
// ---------------------------------------------------------------------------
// The snippet bytes are inlined at build time via
// scripts/inline-snippet-to-edge.ts. Served same-origin as /select so the
// customer's <script> tag has one DNS lookup for everything Rawuser does.
// CORS wildcard because the snippet must load from any customer site.
function handleSnippet(request: Request): Response {
  if (etagMatches(request.headers.get("if-none-match"), SNIPPET_ETAG)) {
    return new Response(null, {
      status: 304,
      headers: { etag: SNIPPET_ETAG, "cache-control": "public, max-age=3600" },
    });
  }
  return new Response(SNIPPET_JS, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      etag: SNIPPET_ETAG,
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * /rich.js, the rich writers (2026-09-30): a static script, no visitor data,
 * open CORS like /picker.js. The snippet asks for `?v={hash}` of the build it
 * was made with; when that is this build's hash the answer is cached for a
 * year (a new build is a new URL). Any other `v` (a cached older snippet, or
 * none) still gets this build, cached five minutes.
 */
function handleRichAsset(request: Request, url: URL): Response {
  const current = url.searchParams.get("v") === RICH_ETAG.replace(/"/g, "");
  const cache = current ? "public, max-age=31536000, immutable" : "public, max-age=300";
  if (etagMatches(request.headers.get("if-none-match"), RICH_ETAG)) {
    return new Response(null, {
      status: 304,
      headers: { etag: RICH_ETAG, "cache-control": cache },
    });
  }
  return new Response(RICH_JS, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": cache,
      etag: RICH_ETAG,
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// /select-bulk: every version of the operator's own site in one answer
// ---------------------------------------------------------------------------
// Answers only for the one customer the install names in OWN_SITE_CUSTOMER,
// so a toggle on that site can switch between its versions without a
// request per version. Unset, the route answers 404 like any unknown path.
//
// Privacy notes:
//   - NEVER writes events (no visitor tracking on this path).
//   - Response is public (no auth required): the operator's own versions
//     are its demo, meant to be read.
//   - Other customer_ids return 403: nobody else's versions are read here.
//   - Cache-Control: public, max-age=300: variants change infrequently;
//     aggressively cacheable because they contain no visitor data.
//
// Its bodies go out as stored, here and on /select: the site's own hero
// reads the button's words from the body by design, the snippet does not
// run there, and no bundle is read on this path (visitor-manifest.ts,
// ownSiteCustomer; the off-button rule of task H9 is for pages the snippet
// writes).
// ---------------------------------------------------------------------------

// All (intent_dim, source_dim) tuples that can be generated in V1.
const ALL_INTENT_DIMS = [
  "competitor",
  "evaluation",
  "feature",
  "problem",
  "brand",
  "pricing",
] as const;
const ALL_SOURCE_DIMS = ["ai", "social", "community", "paid", "organic", "direct"] as const;

type BulkVariant = {
  intent_dim: string;
  source_dim: string;
  variant: VariantBody | null;
};

async function handleSelectBulk(request: Request, url: URL, env: Env): Promise<Response> {
  const customerId = url.searchParams.get("customer_id");

  // Hard gate: only the operator's own site is publicly readable.
  const ownSite = ownSiteCustomer(env);
  if (ownSite === null) return new Response("not found", { status: 404 });
  if (customerId !== ownSite) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Fetch all 36 possible variant keys in parallel.
  // KV misses return null: that's fine (persona-toggle falls back gracefully).
  const fetches: Promise<BulkVariant>[] = [];
  for (const intentDim of ALL_INTENT_DIMS) {
    for (const sourceDim of ALL_SOURCE_DIMS) {
      const key = variantKey(customerId, intentDim, sourceDim);
      fetches.push(
        env.VARIANTS.get<VariantBody>(key, "json").then((v) => ({
          intent_dim: intentDim,
          source_dim: sourceDim,
          variant: v,
        })),
      );
    }
  }

  const results = await Promise.all(fetches);

  // Filter to only variants that exist in KV.
  const variants = results.filter((r) => r.variant !== null);

  return new Response(JSON.stringify({ customer_id: customerId, variants }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Publicly cacheable: variants are not visitor data.
      // max-age=300 (5 min) means fresh enough for the demo.
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      // CORS: allow the marketing site to fetch this from any origin.
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * How the tab's carry meets this page's own signals (docs/specs/session-carry.md):
 * - no signal of its own: the carried pair, whole;
 * - only an intent-bearing path (no utm, click-id name, cross-site referrer,
 *   AI source or in-app marker): the path's intent with the carried source,
 *   so a ChatGPT visit that clicks to /pricing stays an AI visit (measure-lab,
 *   2026-10-05). Flagged carried, so the snippet keeps the landing's pair;
 * - a source of its own: the page's own selection, the carry ignored.
 */
export function combineCarry(
  fresh: { intent_dim: IntentDim; source_dim: SourceDim; confidence: number },
  carried: { intent_dim: IntentDim; source_dim: SourceDim } | null,
  own: { meaningful: boolean; source: boolean },
): { intent_dim: IntentDim; source_dim: SourceDim; confidence: number; carried: boolean } {
  if (carried && !own.meaningful) {
    return {
      intent_dim: carried.intent_dim,
      source_dim: carried.source_dim,
      confidence: 0.6,
      carried: true,
    };
  }
  if (carried && !own.source) {
    return {
      intent_dim: fresh.intent_dim,
      source_dim: carried.source_dim,
      confidence: fresh.confidence,
      carried: true,
    };
  }
  return { ...fresh, carried: false };
}

/** "en-US" → "en"; null/empty → null. */
/** "intent:source" from the tab's carry, validated against the dimension tables; else null. */
export function parseCarry(
  raw: string | null,
): { intent_dim: IntentDim; source_dim: SourceDim } | null {
  if (!raw) return null;
  const m = /^([a-z]{2,16}):([a-z]{2,16})$/.exec(raw);
  if (!m) return null;
  const intent = m[1] as IntentDim;
  const source = m[2] as SourceDim;
  if (!(INTENT_DIMENSIONS as readonly string[]).includes(intent)) return null;
  if (!(SOURCE_DIMENSIONS as readonly string[]).includes(source)) return null;
  return { intent_dim: intent, source_dim: source };
}

/**
 * Language the versions for this path were written in, from the KV map or a
 * bare tag. A path the map does not list takes its longest listed
 * whole-segment prefix (`/az/work` takes `/az`; `/azure` does not), else the
 * root's (task F9: a pilot site's `/az/work` read as the root's English and every
 * carried visit there was a mismatch).
 */
export function briefLangFor(raw: string | null | undefined, pagePath: string): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const map = JSON.parse(t) as Record<string, string>;
      return primaryLang(langEntryFor(map, pagePath));
    } catch {
      return null;
    }
  }
  return primaryLang(t);
}

/** The map's entry for the path, else for its longest listed prefix, else the root's. */
function langEntryFor(map: Record<string, string>, pagePath: string): string | null {
  let p = pagePath;
  while (p && p !== "/") {
    const v = map[p];
    if (v !== undefined) return v;
    const cut = p.lastIndexOf("/");
    p = cut <= 0 ? "/" : p.slice(0, cut);
  }
  return map["/"] ?? null;
}

function primaryLang(tag: string | null | undefined): string | null {
  if (!tag) return null;
  // Tolerate a JSON-quoted value ("az") from stores that stringify strings.
  const p = tag.trim().replace(/^"|"$/g, "").split("-")[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(p) ? p : null;
}

/** The location's Cache API; null where there is none (workers.dev, tests). */
function defaultCache(): Cache | null {
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
}
