# ADR 0028 · In-app browser marker and click-id names as source signals (L2, social half)

## Status: accepted (2026-09-10)

## Context

A link tapped inside Instagram, Facebook, LinkedIn, TikTok or X opens in
that app's webview, which sends an empty `document.referrer`. The visit
lands as `direct`, the channel is lost, and ADR 0017's gate serves the
original page. The research file `docs/research/ai-landing-signals.md`
puts 70.6% of AI-origin traffic in that bucket; social in-app traffic is
the same shape.

An earlier Rawuser, written in 2025, solved
this with a User-Agent table run before the referrer, and it worked. It
also stored IP, city, the full UA and a fingerprint, which is why it was
not carried over. The founder asked on 2026-09-10 to bring the good part
back. `docs/research/old-rawuser-source-detection.md` is the comparison.

## Decision

1. `packages/shared/src/signals/app-source.ts` reads the in-app browser
   marker from the UA (`APP_UAS` in `tables.ts`) and records only the app
   name and its channel in `Signals.appSource`. The UA is discarded, as it
   always was. Only markers with a verified or secondary-sourced UA string
   are in the table (`docs/research/in-app-browser-ua-2026.md`); the AI
   apps are not, because no source shows their in-app view stamping the UA.
2. The snippet forwards the NAMES of click-id parameters on the page URL
   as `clk=fbclid,gclid`. `click-id.ts` maps a name to a platform in
   `Signals.clickId`. Values are never read, forwarded or stored.
3. The classifier treats a social app or social click id as a social
   signal (0.85, same as a social referrer), gclid/msclkid as paid (0.9),
   and either as a channel signal that turns `direct` off and suppresses
   the brand rule. `hasMeaningfulSignal` counts both.
4. The edge's debug classifier block shows `app_source` and `click_id`
   in development or with the preview token, nothing else changes in
   responses or storage. The events row already carries the vector; the
   new fields are not persisted on their own.
5. Social host lists gain YouTube, Pinterest, Threads, Snapchat, Telegram,
   WhatsApp, fb.com and x.com.

## Consequences

- Visits from inside the big social apps now personalise and count toward
  Signal Coverage instead of `no_signal`.
- Snippet grows to 2,397 bytes gzipped (ceiling 15,360).
- What is not recovered: WhatsApp, Telegram iOS, Reddit, Discord, Slack,
  Gmail, and every AI app, because their in-app views send the stock
  Safari or Chrome UA. Those stay `direct` until a real-device capture
  shows a marker or the text-fragment signal (L5) lands.
- Not carried over from 2025, on purpose: office-hours guessing, result
  caching on the device, third-party domain lookups per visit, IP, city,
  fingerprint, visitor re-identification.
- A privacy review recorded in the commit that lands this ADR.
