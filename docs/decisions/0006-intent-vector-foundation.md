# ADR 0006 · Intent vector is the permanent foundation; V1 snaps

## Status: accepted

## Context

The first cut of the V1 intent engine (ADR 0005) classified each visitor
into ONE of 8 discrete profiles per request. Shipping that revealed the
underlying axis was wrong:

- A visitor arriving from ChatGPT with `utm_campaign=salesforce-alternative`
  legitimately carries high competitor-intent AND high AI-source signal
  AND high urgency. Collapsing that to a single label like
  `ai-research-arrival` or `comparison-shopper` discards real signal and
  forces every visitor into a Procrustean bed.
- Worse: any "right" set of 8 labels stops being right the moment the
  ICP changes, when a new traffic channel emerges, or when a customer's
  product positioning shifts. The discrete-profile schema is a content
  decision dressed up as a data structure.
- Worst: the discrete shape leaks into every downstream system. KV keys
  are profile-keyed; events are profile-keyed; the dashboard speaks
  "profiles"; future generation prompts would be profile-keyed. Every
  one of those locks the wrong axis in.

## Decision

The intent engine outputs an **IntentVector**: a 20-dimensional
anonymous representation of why a visitor came. Three orthogonal axes
(intent, source, context) plus meta:

| Axis | Dims | Role |
|---|---|---|
| `intent` | 6: `competitor`, `evaluation`, `feature`, `problem`, `brand`, `pricing` | Picks the variant base |
| `source` | 6: `ai`, `social`, `community`, `paid`, `organic`, `direct` | Modifies the variant tone |
| `context` | 6: `price_sensitivity`, `technical_depth`, `urgency`, `trust_need`, `mobile_context`, `offhours_context` | Refines selection / weights lead-probability |
| `meta` | 2: `confidence`, `lead_probability` | Self-describing scalars |

All 20 dims are floats in `[0, 1]`. Multiple dims can be high
simultaneously. Source NEVER overrides intent, the intent dim picks
the variant base; the source dim modulates tone; context refines.

The vector shape is **permanent across V1/V2/V3**. What changes is how
selection consumes it:

- **V1, dominant snap.** `intent_dim = argmax(vector.intent)`,
  `source_dim = argmax(vector.source)`. KV variant key is
  `v1:variant:{customer_id}:{intent_dim}:{source_dim}`. Both axes
  always apply.
- **V2, modular composition.** Variant composed from multiple strong
  dims, not snapped to one tuple. Behavior signals update the vector
  live via Bayesian fusion.
- **V3, pure vector composition.** Real-time bespoke generation for
  high-lead-prob visitors; the vector becomes the input to a
  composition function. Federated learning of `vector → composition →
  conversion` patterns refines the function over time.

## Why V1 snaps instead of going straight to composition

Three reasons, in order of weight:

1. **Validation before architecture.** The vector representation is the
   product bet. Modular composition is the implementation bet. Coupling
   the two and shipping both at once means we can't tell which one is
   carrying the conversion lift when we get pilot data. V1 snaps so V2
   can A/B "dominant snap vs modular composition" against a clean
   baseline.

2. **KV variant economics.** Modular composition needs either (a) a
   pre-generated variant per dim combination (combinatorial, 6×6 is
   manageable, 6×6×6 explodes), or (b) live composition at request time
   (V3). V1 ships before generation has produced anything; we
   intentionally need an architecture where 6 intent placeholders are
   enough to test end-to-end.

3. **The 8-profile lesson.** Doing too much at once made the discrete
   profiles look right until we tried to use them. Shipping V1 with a
   simple selection mechanism on top of the permanent representation
   lets us learn what real composition needs to look like from real
   visitor data, instead of guessing.

V1 snap is V1-only by design. The plan is to replace it in V2, and the
vector shape that survives that replacement is the whole point.

## Persistence: the full vector goes to D1 events

Every `/select` request fires-and-forgets a write to `events` via
`ctx.waitUntil()`:

```json
{
  "intent_vector": { "intent": {...}, "source": {...}, "context": {...}, "meta": {...} },
  "selection": { "intent_dim": "competitor", "source_dim": "ai" },
  "country": "US",
  "device": "desktop",
  "ai_source": "chatgpt"
}
```

`profile_id` is NULL, visits no longer collapse to one profile. No
visitor identifiers, no raw UA, no referrer URL, no IP, no session ID.
This is the dataset that will train V2's modular composition decisions
and V3's federated composition function.

## Signal allow-list extensions

The vector picks up two new derivative signals beyond what ADR 0005
introduced. Both consumed ambient signals only; both reduced to
non-identifying derivatives before storage; both passed
the privacy review APPROVED WITH NOTES.

1. **`cf.timezone` → `context.offhours_context` (0|1).** The raw IANA
   timezone string is never stored or echoed. Used solely to derive a
   binary business-hours/off-hours boolean inside the vector. GDPR
   justification: legitimate interest in business-hours-aware copy
   variation; no individual is re-identifiable from a 0/1 float in
   aggregate analytics.

2. **`cf.country` → `events.properties.country`.** ISO-3166-1 alpha-2
   only, read directly from `cf.country` and never derived from IP.
   This was already in the allow-list as a signal but is now also
   persisted to the events JSON.

Forbidden CF properties remain forbidden: `cf.region`, `cf.city`,
`cf.postalCode`, `cf.latitude`, `cf.longitude`, `cf.asn`.

## Known debt

- **`intent_profiles` table semantic overload.** The legacy schema
  stores both "intent-kind" rows (V1 placeholders for the 6 intent
  dims) and "source-kind" rows (the 6 source modifiers) in the same
  table, disambiguated by the `profile_key` prefix (`intent:` /
  `source:`). A `kind` column would be cleaner but requires a schema
  migration that touches generation tooling. Flagged for a later
  schema-evolution unit.
- **`Math.random` → `crypto.randomUUID` for event IDs.** Applied as a
  follow-up fix after the privacy review raised it. Tracked.
- **Constant-time `PREVIEW_TOKEN` comparison.** Carried over from ADR
  0005, still strict-equality. Hardening tracked as a V2 item.

## Consequences

- The intent engine is now decoupled from any specific content taxonomy.
  Adding a new intent dim or source dim is a one-file change to
  `packages/shared/src/vector/dimensions.ts` plus weights table updates;
  no schema migration required.
- All downstream systems read the vector. The dashboard's
  intelligence view, V2's composition logic, V3's federated learning,
  and the generation pipeline's "variant per (intent, source) tuple"
  all key off the same 20-dim shape.
- The events table starts collecting vector training data on day one.
  Even if we never look at it until V2, every pilot's traffic
  contributes to the dataset that makes V2 modular composition
  trainable.
- The cross-customer network effect (V3) is encoded in the schema from
  the start: every customer's events flow into the same global
  vector-shaped dataset (federated aggregation, not raw sharing). This
  is the moat.
