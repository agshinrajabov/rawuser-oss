# ADR 0029 · Source recovery beyond the app table: some app, some tracked link, dark-social share, learned markers

## Status: accepted (2026-09-10)

## Context

ADR 0028 recovered the channel for visits from apps that sign their
webview's User-Agent. The founder asked the next question the same day:
what about apps we did not list, and ads we cannot name? The spec
`docs/specs/source-recovery.md` laid out four further layers and the
research file `docs/research/generic-source-recovery-2026.md` checked 65
claims behind them (40 verified, 20 likely, 3 false). This ADR records what
shipped and the one thing the founder offered that we did not take.

The founder said a "light-privacy" version would be acceptable if it
bought more. It would not. Every layer below reads a header or a parameter
NAME the visit already carries and discards it. The only step that would
have crossed the line, storing click-id values to tie a later conversion
to an ad click, buys attribution, not detection, and the ad platforms'
own pixels already do that on the customer's site with the customer's
consent banner. Rawuser stays privacy-zero; nothing in this ADR needs a
consent prompt.

## Decision

1. **Some app (Layer B).** `detectAppSource` now also reads the
   low-entropy Client Hints header `Sec-CH-UA`: the brand `Android WebView`
   means "inside some app", confidence medium, app unknown. The `; wv)` UA
   token is the fallback. On iOS, an AppleWebKit UA without the `Safari/`
   token and without a known browser token is confidence low. Medium counts
   as a meaningful signal (source.social 0.6); low is a prior only (0.35)
   and never turns personalisation on, because Facebook on iOS 26 renders
   a Safari-looking webview and the rule has false negatives.
2. **Some tracked link (Layer C).** `click-id.ts` grows from seven
   platforms to six families over about forty parameter names: ai-ads
   (`oppref`, the click id OpenAI appends to ads shown inside ChatGPT),
   paid-search, paid-social, social-share, email, affiliate. Names only.
   `oppref` makes the visit an AI source (`aiSource = chatgpt`) and paid.
   Email links are `direct` with an urgency bump: the per-recipient names
   (`mc_eid`, `_hsenc`, `ck_subscriber_id`, `ml_subscriber`, `mkt_tok`)
   tell us "a personalised email", and we never read the value that would
   tell us who. Affiliate and referral programmes (`ref`, `via`,
   `irclickid`, `awc`…) are third-party discovery, `organic` 0.6; `ref`
   and `via` are accepted only through the snippet's `clk` list because
   the snippet uses `?ref=` for the referrer itself. The snippet's copy of
   the name list is tested for parity with the edge's.
3. **Dark-social share (Layer D), reporting only.** The snippet sends the
   Performance API navigation type (`nav=navigate|reload|back_forward`).
   For an untagged visit the edge sets `dark_social_probable` when the
   device is mobile, the referrer is empty, there is no UTM and the
   navigation is fresh, or when the iOS low-confidence rule fired. The
   snippet echoes the flag into `no_signal_passthrough`; `events.dark_social`
   (migration 0018) stores it; the aggregator counts it into the
   `no_signal` entry of `per_cohort`; the Signal Coverage card says "of
   which N% look like an app that hid the referrer". It never selects a
   variant, so ADR 0017 holds: a prior is not a signal.
4. **Learned markers (Layer E), off by default.** `ua-tokens.ts` tokenises
   the UA of visits with an empty referrer and no named app, drops the
   stoplist and anything identifier-shaped (digit runs of six or more,
   hosts, emails, tokens over 32 characters), and upserts a weekly counter
   per (week, customer, token) in `ua_token_counts` (migration 0017) via
   `ctx.waitUntil`. `scripts/ua-token-proposals.ts` surfaces tokens seen
   across at least 2 customers and 50 sessions in a week, minus the known
   ones, as a review file; a human adds rows to `APP_UAS` with a source.
   The counter key does not carry the customer: `customer_bucket` is the
   first byte of SHA-256(customer_id, week), 256 buckets rotating weekly,
   so a rare token below the threshold cannot be tied to one customer's
   niche traffic from the table. This was the privacy review's one
   condition on this ADR (review of 2026-09-10: B, C, D PASS; E PASS once
   the raw customer id leaves the key), and it is met. The flag
   `UA_TOKEN_LEARNING` is `off` in both environments until the founder
   turns it on after the first pilot has traffic.
5. **Not done, on purpose.** `Sec-Fetch-Site` (verified useful, but the
   edge only sees the snippet's cross-site fetch; it belongs to the proxy
   tier). Time-of-day as a source. Any storage of a click-id value, a full
   UA, or a per-visit token row.

## Consequences

- Recovered channels: ads inside ChatGPT, any Android webview, ~40 tracked
  link types, on top of ADR 0028's named apps.
- Still invisible: iOS webviews that mimic Safari, WhatsApp, Telegram iOS,
  Reddit, Discord, Slack, Gmail, and every AI app's organic citation click.
  Layer E is the path to shrinking that list; the text-fragment signal (L5)
  is the other.
- Snippet: 2,626 bytes gzipped. Two migrations (0017, 0018) to apply with
  `pnpm db:migrate` before the edge deploy; the events INSERT names the new
  column.
- A privacy review, 2026-09-10: PASS WITH CHANGES; the change (the
  customer bucket above) landed in the same commit. One standing note: the
  email link family reaches events and the dashboard only as the label
  "email", never as the parameter or platform name.
