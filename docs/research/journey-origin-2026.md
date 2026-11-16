# Journey origin without cookies

> Research, 2026-10-03. The founder's question: a visitor goes Facebook, then
> site B, then our customer's site. We see only B. Is there a cookieless,
> identity-free way to know the journey started on Facebook, maybe one nobody
> uses yet?
>
> Three tracks (browser internals, GitHub and cookieless analytics, novel
> designs with prior-art search, about 140 sources) and one verifier who
> re-derived 75 claims from raw sources, his own curl and a real headless
> click: 63 PASS, 9 FAIL, 3 UNSURE, corrections applied below. Builds on
> docs/research/generic-source-recovery-2026.md,
> docs/research/ai-click-attribution-2026.md,
> docs/research/in-app-browser-ua-2026.md. Research, not legal or patent
> advice.

## The answer in seven lines

1. **The browser carries one hop, on purpose.** The referrer is built from
   the page that started the navigation and nothing older; every old way to
   read earlier hops (cross-origin history, `window.name`, cross-origin
   redirect counts, opener) was closed for privacy or security.
2. **Origin can reach the customer page by three channels only:** the
   browsing context itself (an in-app browser's user agent), the URL (link
   decoration), and aggregate knowledge about B. Everything else is tracking.
3. **On phones the founder's case is probably already half solved.** Inside
   the Facebook, Instagram, TikTok or LinkedIn in-app browser, the app's UA
   token is set per webview, so it should ride on B and on the customer page
   too, and our classifier counts an in-app social UA as social whatever the
   referrer says. **Measured 2026-10-03 on a real iPhone (Instagram 448,
   iOS 27):** Instagram, then page B on another site, then page C; C's
   referrer was B and the UA still carried `Instagram 448.0.0.39.66` and
   `IABMV/1`; Rawuser classified `problem:social`. Facebook and Android
   still to test (lab pages: journey-b.example.com to
   lab.example.com/journey/c/).
4. **Cheap gaps confirmed:** `android-app://<package>` referrers land as
   unknown, and we lack several in-app markers (`MetaIAB Facebook`, WhatsApp
   `[WAiOS/` and `[WA4A/`, `Reddit/Version`, `GSA/`, `IABMV/1`).
5. **The new idea is a journey-origin relay:** when B also runs Rawuser, B's
   snippet adds one coarse category (`rw_o=social`) to an outbound click to
   another Rawuser site; C reads it, strips it from the URL, stores nothing.
   Nearest prior practice is affiliate sub-IDs (`sub1=facebook`), which are
   per campaign and usually sit next to a click id. Needs a the privacy review
   ruling.
6. **Link-in-bio pages do not help as hoped.** Linktree's links carry
   `rel="noopener noreferrer"`; a real click sent no referrer at all.
7. **Patent risk to check:** Taboola's US11514128B2 (active, priority
   2019-11-21) claims deriving a referral source from the user agent of an
   in-app browser with no valid referrer. That reads on what we already ship
   (ADR 0028). Chartbeat did UA reclassification in 2014, which may be prior
   art. Patent counsel should look.

---

## 1. What the browser gives, mechanism by mechanism

| Mechanism | What it says about earlier hops | Readable by our snippet | Use for us |
|---|---|---|---|
| `document.referrer` | Last hop only, usually origin | Yes | Already used |
| `android-app://<package>` referrer | The app that opened the link in Chrome or a Custom Tab (Chromium fills it automatically for bound Custom Tabs; Facebook's "links open externally" mode arrives as `android-app://m.facebook.com`) | Yes | **Yes: add a package table** |
| In-app browser UA (FBAN/FBAV, FB_IAB, Instagram, TikTok, LinkedInApp, WhatsApp, Reddit) | The app the whole webview session lives in, including later hops (inferred) | Yes | Already used; add missing markers; device test |
| `Sec-CH-UA` "Android WebView" brand | "Some app" | Edge | Already used |
| `history.length` | "This tab had earlier pages", never which | Yes | Weak; only bucketed, a raw number is a fingerprinting input |
| Navigation API entries | Same-origin only (Chromium, Firefox 147, Safari 26.2) | Yes | No |
| `PerformanceNavigationTiming.redirectCount` | 0 after any cross-origin redirect | Yes | No |
| `window.opener` | `target=_blank` implies noopener (Chrome 88, Firefox 79, Safari 12.1) | No | No |
| `window.name` | Cleared on cross-site navigation (Firefox 88, Safari, Chrome by default; opt-out policy ends in Chrome 146) | No | No, and it was a tracking channel |
| Fetch Metadata (`Sec-Fetch-Site`) | Typed or bookmark vs link with no referrer; last hop only | No, server only (a Worker route on the customer's zone) | Proxy tier only |
| Link shims (l.facebook.com, t.co) | Become B's referrer; `fbclid` appears only on B's landing URL | Yes on the first hop | Already used |
| Text fragment `#:~:text=` | What an AI or search quoted | Chromium via Performance API | L5, already planned |
| Private Click Measurement (Safari) | One delayed report (24 to 48 h) to the click source and the destination | No | No |
| Attribution Reporting (Chrome) | Retirement announced 2025-10-17 | No | No |
| Firefox PPA | Removed by Firefox 143 | No | No |

**Safari risk for us.** In Private Browsing, and in normal browsing when the
user turns on advanced tracking and fingerprinting protection, third-party
scripts get URLs without query or fragment and no cross-site
`document.referrer`. Since Safari 26.0, "known fingerprinting scripts" get the
same in all browsing. Our snippet is a third-party script and must never look
like a fingerprinting script. Serving it first-party only to dodge this is
off the table.

## 2. What open source and cookieless analytics do

- **Nobody recovers the first hop without identity.** PostHog keeps
  `$initial_referring_domain` per person; Plausible and Fathom link a session
  with a hashed daily signature; Dub sets a 90-day cookie. None fits our
  rules.
- **Reusable data, with licences:**
  - PostHog `channel_definitions.json` (MIT): 394 reverse-DNS app ids mapped
    to channels.
  - Matomo search engine and social lists (CC0).
  - Adobe rum-distiller (Apache-2.0, PR #137 merged 2026-09-10): send a
    package id to an exact lookup and a hostname authority to normal host
    matching; never substring-match package ids, or Gmail reads as paid
    Google search.
  - inapp-spy (MIT): detects Telegram by `window.TelegramWebviewProxy` (iOS)
    and `window.TelegramWebview` (Android); UA fixtures for WhatsApp, Reddit,
    Meta.
  - Do not copy: ua-parser-js v2 and Plausible (AGPL), Snowplow
    `referers.yml` and Matomo core (GPL-3), Telegram (GPL-2).
- **Dark-social vendors** (AddThis, ShareThis, GetSocial, Po.st, Tynt) all
  minted per-share or per-visitor tokens. That is tracking. The clean part is
  Chartbeat's heuristic, the same idea as our dark-social card.
- Also missing from our lists: 17 AI hosts (for example
  copilot.cloud.microsoft, pplx.ai, notebooklm.google.com, character.ai),
  `web.telegram.org`, click-id names `gclsrc`, `qclid`, `irclid`, `_kx`.

## 3. Designs, ranked

| Rank | Design | Covers Facebook, then B, then us | Privacy | Cost | Novelty |
|---|---|---|---|---|---|
| 1 | In-app UA across hops, plus `android-app://` table and missing markers | Most phone journeys that start in a social app and stay in its webview (estimate); none on desktop | Pass (already reviewed, ADR 0028, 0029) | Under a day plus a device test | Low; Taboola patent to check |
| 2 | Journey-origin relay between Rawuser sites (own domains first) | A customer's own blog, docs or founder site now; low single digits of traffic at network scale (estimate) | Needs ruling | 2 to 3 days plus review | Narrower than affiliate sub-IDs; nothing identical found |
| 3 | Aggregate host priors: learn P(origin given B) from visits where the origin leaked (in-app UA, click-id name, relayed label), apply to visits from B that leak nothing | 20% to 50% of referral-host visits at 50+ customers (estimate), none at pilot scale | Needs ruling (cross-customer) | 3 to 5 days, needs traffic | Taboola patent is close |
| 4 | Customer-owned short links (`go.customer.com/ig`) that bake a category into the link | 100% of links the customer posts, nothing else | Pass if stateless | 2 to 3 days | Low (Bitly, Dub) |
| 5 | Self-declared "How did you find us?" chip, tab only | Unknown, the pilot measures it | Pass | Part of the task-chip work | Low |
| 6 | Open "journey origin" link convention (publish the vocabulary) | Zero until adopted | Pass | A day of writing | The origin field is new; worth it only after 2 shows lift |
| Dropped | Link-in-bio host table | Linktree sends no referrer (`rel="noopener noreferrer"`); other bio hosts need a real-click test first | Pass | | |
| Never | Joining B's and C's requests at our edge by IP, UA and timing; any Rawuser-domain cookie or storage bounce | | Fail: cross-site tracking | | |

### The relay, in detail (design 2)

1. A visitor lands on B from Facebook; B's edge classifies `source=social`;
   the session carry already holds it in B's tab.
2. B's per-customer script holds a hashed list of opted-in participant hosts.
3. On the click of a link to a participant host, the snippet adds
   `rw_o=social` to that click only; static hrefs never carry it, so copied
   links, crawlers and screenshots do not.
4. C's snippet, first in head, reads `rw_o`, checks it against the closed
   vocabulary, removes it with `history.replaceState`, and sends it to
   `/select` as a signal.
5. C's edge treats it as a prior below first-hand signals, never overriding
   C's own UTM, click id or referrer, and marks the event `relayed=1`.
6. One hop only: if B's own landing came with `rw_o`, B relays nothing.

The six constraints that make it defensible: a closed coarse vocabulary
(ai, social, community, paid, organic, email); one hop; click-time only, to
opted-in hosts only; stripped on arrival and never forwarded to C's other
tools; nothing stored beyond the existing event dims plus `relayed=1`, no
visit marker; disclosed in both customers' notices with an off switch.

Legal position: tracking links, including affiliate source tags, are inside
ePrivacy Art. 5(3) per EDPB Guidelines 2/2023 paras 49 to 51, the same
position UTM is in. B discloses one coarse fact about the visitor's browsing
before B to C. Browsers: Firefox strips 22 names and Brave strips identifiers
but keeps campaign-level ones; note that some stripped names are campaign
tags too (`gbraid`, `wbraid`, `_openstat`), so a new label could be added to
a list if it ever became fine-grained. Safari Link Tracking Protection runs
in Private Browsing, Mail, Messages, or with advanced protection on.

Moat: the only design where every customer makes every other one smarter,
and it works only between Rawuser sites.

## 4. Recommended order

1. **This week, no ruling needed.**
   - `android-app://` package table (from PostHog's MIT list, exact match),
     plus the missing UA markers and AI hosts.
   - Real-device multi-hop test in a live browser: Instagram and Facebook
     links to a test page B on our lab that links to the template-lab page C.
     Does C's `/select` carry the app token, does the event say `social`, and
     where does `target=_blank` leave the webview?
   - A hard line in docs/privacy-rules.md: never join requests from
     different customers by IP, UA or timing.
2. **Patent counsel** on Taboola US11514128B2 before we market in-app
   attribution as ours, and before design 3.
3. **Behind a privacy review's ruling:** spec the relay
   (`docs/specs/journey-origin-relay.md`) and ship it first between one
   customer's own domains.
4. **At three or more customers with traffic:** host priors (design 3).
5. **After the relay shows lift between two customers:** publish the
   convention and offer branded short links.

What we can honestly tell a customer: on phones we usually see the app a
journey started in; the customer's own tagged links always tell us; and
Rawuser sites can tell each other where a journey began without ever telling
each other who it was.

## Corrections from verification

- Linktree does not pass a referrer on its links (`rel="noopener
  noreferrer"`; a real click sent none). The link-in-bio table was dropped.
- Taboola's patent reads on in-app UA attribution itself, not only on host
  priors.
- Affiliate sub-IDs are the nearest prior practice for the relay; "not
  found" was too strong.
- Safari Link Tracking Protection did not ship to all browsing in Safari 26;
  only fingerprinting-script protection did.
- Firefox's strip list includes campaign-level names (`gbraid`, `wbraid`,
  `_openstat`).
- WhatsApp and Reddit do mark their in-app browsers.
- The Navigation API also ships in Firefox 147 and Safari 26.2.
- PCM reports go to both the click source and the destination since Safari
  15.
- Plausible wrote that `android-app` referrers "could" recover 10% or more;
  a forecast, not a measurement.
- 2025-10-17 is when Google announced the Attribution Reporting retirement.
- In-app UA persistence across hops was inferred by the tracks; the founder's iPhone test on 2026-10-03 confirmed it for Instagram on iOS.

## Key sources

- W3C Referrer Policy: https://w3c.github.io/webappsec-referrer-policy/
- W3C Privacy CG, navigational tracking: https://privacycg.github.io/nav-tracking-mitigations/
- Chrome Custom Tabs, app as referrer: https://developer.chrome.com/docs/android/custom-tabs/guide-ui-customization
- Mozilla, Firefox 88 and window.name: https://blog.mozilla.org/security/2021/04/19/firefox-88-combats-window-name-privacy-abuses/
- Firefox query stripping list: https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records
- Brave query string filter: https://github.com/brave/brave-browser/wiki/Query-String-Filter
- Google Privacy Sandbox update 2025-10-17: https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies
- EDPB Guidelines 2/2023 v2: https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf
- PostHog channel definitions (MIT): https://github.com/PostHog/posthog
- inapp-spy (MIT): https://github.com/shalanah/inapp-spy
- Taboola US11514128B2: https://patents.google.com/patent/US11514128B2/en
- Google US9756094B1: https://patents.google.com/patent/US9756094
- Linktree traffic by source (2026-05-13): https://linktr.ee/blog/not-all-clicks-are-equal-a-year-of-linktree-traffic-by-source
- SparkToro, dark social (2023): https://sparktoro.com/blog/new-research-dark-social-falsely-attributes-significant-percentages-of-web-traffic-as-direct/
