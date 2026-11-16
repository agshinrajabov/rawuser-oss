# ADR 0023 · Entry-path as an intent signal (L1)

## Status: accepted

## Context

The most common objection to Rawuser in pilot conversations is
commercial, not technical: *"most of my traffic is direct or
untagged, so half my visitors just see the original page."* This is
a real consequence of ADR 0017 ("personalize only when there's a
reason"): `hasMeaningfulSignal()` recognizes only UTM, external
referrer, and AI-source. A visitor who lands directly on `/pricing`
with none of those is classified `no_signal` and served the
original, even though choosing `/pricing` is itself a disclosure of
pricing intent.

Recent research supports treating entry context as intent:
session-based intent inference literature (e.g. Requena et al.,
*Scientific Reports* 2020) shows purchase intent is predictable from
minimal browsing, and that for anonymous visitors "context acts as a
strong proxy for intent." Dark-traffic studies (SparkToro) show the
"direct" bucket is largely stripped-referrer traffic, not
intentless visitors, and that this hidden slice converts several
times higher than average. The addressable surface is therefore
larger than the t=0 UTM/referrer signals suggest; the page a visitor
chose to land on is the cheapest way to recover part of it.

The page path already flows snippet → `/select` (per-path manifests,
migration 0014). It reached the KV/manifest lookup but never the
classifier. This ADR makes it a classifier input.

Scope is deliberately the cheap t=0 layer only. In-session behavior
signals (scroll, dwell, click rhythm) remain V2 Durable-Objects work
(the backlog), this ADR does not touch them.

## Decision

### 1. An intent-bearing entry path is a meaningful signal on its own

`hasMeaningfulSignal()` returns true when the normalized entry path
raises an **intent** dimension (see the path table below). This
extends, not breaks, ADR 0017: a "positive reason to personalize"
now includes *"the visitor chose a page that discloses why they
came."* Landing on `/` or any unmapped path is still not a reason,
so the customer's homepage copy is left alone exactly as before.

This is distinct from passive attributes (language, device, country,
timezone), which remain non-qualifying: every visitor carries those,
whereas choosing `/pricing` is an active disclosure.

### 2. Path → dimension table (global V1 defaults)

Matched against the normalized path (`normalizePath`: lowercased, no
query/fragment, no trailing slash). Single source of truth in
`packages/shared/src/classify/path-intent.ts`, consumed by both the
classifier and the gate so they cannot drift.

| Path family | Dims raised | Gate-qualifying |
|---|---|---|
| `/pricing`, `/plans`, `/price`, `/cost` | `intent.pricing` 0.6, `context.price_sensitivity` 0.5 | yes |
| `/vs-*`, `/vs/*` | `intent.competitor` 0.65 | yes |
| `/compare*`, `/comparison`, `/alternatives*` | `intent.evaluation` 0.6 | yes |
| `/features*`, `/integrations*`, `/product*` | `intent.feature` 0.55 | yes |
| `/docs*`, `/api*`, `/developers*`, `/reference`, `/sdk` | `intent.feature` 0.55, `context.technical_depth` 0.6 | yes |
| `/how-it-works`, `/why*`, `/use-cases*`, `/solutions*` | `intent.problem` 0.5 | yes |
| `/demo`, `/trial`, `/start`, `/get-started`, `/signup`, `/register`, `/book`, `/contact` | `context.urgency` 0.6 **only** | **no** |
| everything else incl. `/` | nothing | no |

### 3. Path weights sit below the UTM rules

Path intent weights (0.5 to 0.65) are below the explicit-UTM intent
rules (0.65 to 0.75). A hand-tagged campaign link is a stronger, more
deliberate signal than an inferred landing path, so when both are
present the UTM wins the argmax snap. Example: `/pricing` +
`utm_campaign=vs-salesforce` → competitor (0.75) beats pricing
(0.6). This preserves ADR 0006's model where explicit signals lead.

### 4. Conversion-intent paths are context-only

`/demo`, `/trial`, `/signup` etc. raise `context.urgency` only, never
an intent dim, so a naked visit to them does **not** qualify for
personalization. Rationale:

- Preserves the ADR 0006 invariant: demo/trial = urgency, not a
  category-research intent.
- The V1 snap uses only (intent × source). An urgency-only visit
  would snap to the generic `brand` variant, no better than the
  customer's original page, so per ADR 0017 it correctly stays
  original. (This keeps a pilot site's `/start` naked-direct behavior
  unchanged; its paid traffic already carries UTMs.)

### 5. The brand rule yields to path intent

The `brand` intent rule (fires at 0.8 for a truly naked arrival)
would otherwise beat every path prior in the argmax. It now returns 0
when `pathCarriesIntent(entryPath)` is true. `brand` reverts to its
original meaning: a genuinely intentless arrival (homepage direct),
not "we have no UTM." An unmapped or context-only path still yields
`brand`.

## Privacy

the privacy review: **expected APPROVED, no new collection surface.**

- The path is already sent by the snippet and already flows to
  `/select` and the `/event` beacon (`page_path`), both approved
  under migration 0014 and ADR 0020. This ADR consumes an
  already-flowing value; it does not read anything new.
- Only the **normalized** path is used (no query, no fragment, no
  host), the same reduction the per-path manifest reader applies.
- A path is not a personal identifier: it does not single out a
  visitor, is shared by everyone who lands on that page, and creates
  no cross-session linkage.
- No cookie, no fingerprint, no behavior tracking. The change makes
  the classifier read *more of what already arrives*, not collect
  more.
- **Path-segment PII note:** `normalizePath` strips query and
  fragment, so PII in those (`/reset?token=…`) is gone before the
  classifier sees it. PII in a path *segment* (`/profile/user@example.com`,
  `/invite/:token`) is not stripped, but it matches no entry in the
  fixed path→dim table, so it is reduced to an empty result, never
  extracted, and never stored (the raw `entryPath` string is not in
  `SelectResponse` and is not written to `events`; the `/event`
  beacon's `page_path` is separately sanitized). Operators whose apps
  route PII through path segments should still avoid indexing those
  pages, but this change adds no new exposure.

## Consequences

- The `no_signal` cohort shrinks by the share of naked direct
  traffic that lands on an intent-bearing path, directly reducing
  the "half my traffic sees the original" objection.
- Coverage becomes measurable: the dashboard's Signal Coverage card
  (`personalized + holdout + skipped` / total) is derived from the
  existing overview cohorts, no backend change.
- Variants for `(intent, direct)` are served for these visits; where
  a per-source variant is absent the existing `(intent, default)`
  sentinel cascade applies, no new generation required.
- The path table is a global V1 default. Per-customer overrides
  (a concierge operator declaring their own intent paths) are a
  future migration, deliberately out of scope.

## Cross-references

- **ADR 0006**: IntentVector foundation; explicit signals lead,
  demo/trial = urgency. This ADR obeys both.
- **ADR 0017**: Personalize only when there's a reason. This ADR
  widens "a reason" to include an intent-bearing entry path.
- **Migration 0014 / per-path manifests**: the path already flows
  to the edge; this ADR routes it into the classifier too.
- **docs/specs/entry-path-intent.md**: the layered addressable-
  coverage model this is L1 of; L2 (source recovery) and L3
  (behavior fusion) are spec-only / V2.
