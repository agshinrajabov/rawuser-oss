# Generic source recovery: "some app" and "some tracked link" at the landing moment

> Research, 2026-09-10. Web only, 20 fetches/searches, no code changed.
> Question: without identifying anyone, can the snippet or the edge tell
> (a) that the page opened inside SOME mobile in-app browser even when the
> app is unknown, and (b) that the visitor clicked SOME ad or tracked link
> even without a UTM. Follows ADR 0028 (L2 social half) and
> docs/research/in-app-browser-ua-2026.md.

Status key: VERIFIED = primary or first-hand source quoted. LIKELY =
consistent secondary sources, no primary quote captured. FALSE = the claim
as written is wrong. UNVERIFIED = nothing found inside the budget.

Privacy note that applies to every row: we read the NAME of a parameter or
the SHAPE of a UA token. We never read, store, or forward a value. Country
geo stays country-level. Nothing here creates an identifier.

## A. Generic webview markers

| # | Claim | Status | Evidence (under 20 words) | URL |
|---|-------|--------|---------------------------|-----|
| A1a | Android WebView UA carries `; wv)` and `Version/4.0` before `Chrome/` | LIKELY | "Android WebView ... sends the device model, firmware build, and a 'wv' marker" | https://privacysandbox.google.com/blog/user-agent-reduction-android-model-and-version |
| A1b | WebView UA is exempt from UA reduction (so `wv` and model stay) until Android 17 | VERIFIED | "We don't have current plans for User-Agent Reduction on iOS and Android WebView" | https://www.chromium.org/updates/ua-reduction/ |
| A1c | Chrome Custom Tabs do NOT carry `wv` (they run in Chrome itself) | LIKELY | Custom Tabs docs describe a Chrome-rendered tab; no `wv` example anywhere in the docs | https://developer.chrome.com/docs/android/custom-tabs/guide-ui-customization/ |
| A2a | `navigator.userAgentData.brands` includes a brand named `Android WebView` inside WebViews | VERIFIED | `"Not)A;Brand";v="8", "Chromium";v="138", "Android WebView";v="138"` (header captured from a real WebView) | https://github.com/pichillilorenzo/flutter_inappwebview/issues/2834 |
| A2b | Low-entropy hints (brands, mobile, platform) are readable without a prompt or server opt-in | VERIFIED | "it is sent by default, without the server opting in by sending Accept-CH" | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-CH-UA |
| A2c | Low-entropy hints are not fingerprinting-grade | LIKELY | UA-CH "aim to ... reduce the passive fingerprinting surface"; low-entropy set is the default-exposed subset | https://groups.google.com/a/chromium.org/g/blink-dev/c/HllilgilEso |
| A2d | UA-CH shipped on Android WebView (so A2a is not a one-off) | VERIFIED | Intent to Implement and Ship: User-Agent Client Hints on Android WebView | https://groups.google.com/a/chromium.org/g/blink-dev/c/HllilgilEso |
| A3a | Default WKWebView UA ends `Mobile/15E148` with NO `Safari/` token; Safari and SFSafariViewController end `Safari/604.1` | LIKELY | Discourse: "Mobile site detection should not rely on Safari in user agent" (WKWebView lacks it) | https://meta.discourse.org/t/mobile-site-detection-should-not-rely-on-safari-in-user-agent/103341 |
| A3b | False positives: CriOS, FxiOS, EdgiOS, DuckDuckGo lack `Safari/` | FALSE (as written) | These carry `CriOS`/`FxiOS` tokens; parsers misfile them as Safari, not as webviews | https://github.com/mssola/user_agent/issues/49 |
| A3c | False NEGATIVES exist: apps that make a WKWebView look like Safari | VERIFIED | "Since iOS 26, some Facebook builds render their WebView with no FBAV or FBAN token" | https://gotoapp.store/blog/detect-in-app-browser |
| A3d | Some WKWebView traffic carries a non-standard UA (`AppleCoreMedia/...`) with neither `Safari/` nor `Version/` | VERIFIED | "AppleCoreMedia/1.0.0.15E217 (iPhone; U; CPU OS 11_3 like Mac OS X; en_us)" | https://github.com/bowser-js/bowser/issues/456 |
| A4a | Chrome Custom Tabs can pass an app referrer (`android-app://<package>`) | VERIFIED | "You can set your app as the referrer when launching your Custom Tab" | https://developer.chrome.com/docs/android/custom-tabs/guide-ui-customization/ |
| A4b | That referrer reaches `document.referrer` as `android-app://...` | LIKELY | Doc says the point is to "let websites know where their traffic is coming from" | same |
| A4c | SFSafariViewController passes a referrer the page can read | UNVERIFIED | No Apple source found in budget | (none) |
| A4d | Instagram/Facebook/LinkedIn webviews usually give an empty or origin-only referrer | LIKELY | Chromium default since 85 is `strict-origin-when-cross-origin`; app-initiated loads have no web initiator | https://dev.to/estruyf/spfx-issues-with-the-new-referrer-policy-in-chrome-85-3pa8 |
| A5a | `PerformanceNavigationTiming.type` is `navigate` for a link opened from an app | VERIFIED | "navigate": "clicking a link, entering the URL in the browser's address bar, form submission" | https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming/type |
| A5b | Client-side way to separate typed/bookmark from link click | FALSE (none exists) | Same value covers "clicking a link" and "entering the URL"; no other client API | same |
| A5c | Server-side (edge) can: `Sec-Fetch-Site: none` marks user-originated loads | VERIFIED | "none: ... entering a URL into the address bar, opening a bookmark" | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site |
| A5d | `Sec-Fetch-Site` is available in Safari too | VERIFIED | "Baseline: Widely available ... since March 2023" | same |
| A5e | An app-opened link (webview, Custom Tab, SFSafariVC) also shows `Sec-Fetch-Site: none` | LIKELY | Loads with no web initiator are "user-originated"; so `none` cannot separate typed from app-opened | same |

## B. Ad and tracked-link parameter names (presence only)

Channel key: PS = paid search, PSo = paid social, OS = organic social share,
EM = email, AF = affiliate, AN = analytics/ads suite.

| # | Name | Platform | Channel | Status | Evidence (under 20 words) | URL |
|---|------|----------|---------|--------|---------------------------|-----|
| B6.1 | gclid | Google Ads | PS | VERIFIED | "platform-issued identifier for one paid ad click" | https://leadtrackr.io/learn/advertising-click-ids |
| B6.2 | gbraid | Google Ads (iOS/ATT) | PS | VERIFIED | click identifier for privacy-constrained iOS traffic | same |
| B6.3 | wbraid | Google Ads (iOS/ATT) | PS | VERIFIED | "supports app-to-web measurement" | same |
| B6.4 | dclid | Campaign Manager 360 / DV360 | AN (display) | VERIFIED | "Belongs to Campaign Manager 360 and DV360" | same |
| B6.5 | gad_source | Google Ads | PS | LIKELY | Not in fetched reference; appears in Google auto-tagging alongside gclid | https://gclidtracker.com/blog/every-ad-platform-click-id-explained |
| B6.6 | gad_campaignid | Google Ads | PS | LIKELY | Same family as gad_source; no primary quote captured | same |
| B6.7 | srsltid | Google Merchant Center auto-tagging | organic shopping | LIKELY | Not in fetched reference | (none) |
| B6.8 | msclkid | Microsoft Advertising | PS | VERIFIED | "Microsoft Ads uses msclkid" | https://leadtrackr.io/learn/advertising-click-ids |
| B6.9 | fbclid | Meta (Facebook, Instagram) | PSo and OS | VERIFIED | "landing-page value ... converted into _fbc"; also on organic shares | same |
| B6.10 | igshid / igsh | Instagram share | OS | LIKELY | Listed in stripper lists as "tracking parameters in the wild" | https://www.terminusapp.com/blog/utm-vs-gclid-vs-fbclid-vs-ttclid/ |
| B6.11 | ttclid | TikTok | PSo | VERIFIED | "identifier used to match a website conversion with an ad click" | https://leadtrackr.io/learn/advertising-click-ids |
| B6.12 | twclid | X / Twitter | PSo | VERIFIED | "connect an eligible website visit with its originating ad" | same |
| B6.13 | li_fat_id | LinkedIn | PSo | VERIFIED | "first-party click identifier" | same |
| B6.14 | ScCid | Snapchat | PSo | VERIFIED | "landing-page parameter" for click tracking | same |
| B6.15 | epik | Pinterest | PSo | VERIFIED | "placed ... on eligible ad landing URLs" | same |
| B6.16 | rdt_cid | Reddit | PSo | VERIFIED | "click ID connects a conversion with a specific ad" | same |
| B6.17 | oppref (new) | OpenAI (ChatGPT ads/refs) | AI source | VERIFIED | "click-level attribution" | same |
| B6.18 | yclid | Yandex Direct | PS | VERIFIED | listed with platform in click-id reference | https://gclidtracker.com/blog/every-ad-platform-click-id-explained |
| B6.19 | wickedid | Wicked Reports | AN | LIKELY | Named in stripper lists; platform from name only | https://www.terminusapp.com/blog/utm-vs-gclid-vs-fbclid-vs-ttclid/ |
| B6.20 | mc_cid / mc_eid | Mailchimp | EM | VERIFIED | "mc_cid ... campaign identifier and mc_eid ... email ID" | https://linkclean.app/trackers/mc-eid/ |
| B6.21 | _hsenc / _hsmi | HubSpot | EM | VERIFIED | "_hsenc ... encryption parameter and _hsmi ... message ID" | https://github.com/brave/brave-browser/issues/9019 |
| B6.22 | mkt_tok | Marketo | EM | VERIFIED | "joins an email click to a specific lead record in Marketo's CRM" | https://www.terminusapp.com/blog/utm-vs-gclid-vs-fbclid-vs-ttclid/ |
| B6.23 | vero_id | Vero | EM | LIKELY | "vero_id is Vero's tracking parameter" (no vendor doc fetched) | same |
| B6.24 | ck_subscriber_id | Kit (ConvertKit) | EM | VERIFIED | "?ck_subscriber_id=123, where 123 is the ID of the subscriber" | https://support.convertbox.com/knowledge-base/targeting-visitors-in-your-convertkit-account/ |
| B6.25 | ml_subscriber (+ ml_subscriber_hash) | MailerLite | EM | VERIFIED | "MailerLite adds ml_subscriber and ml_subscriber_hash fields to outgoing links" | https://github.com/brave/brave-browser/issues/17507 |
| B6.26 | s_kwcid | Adobe Advertising Cloud / Analytics | PS | LIKELY | "s_kwcid is an analytics parameter" (no Adobe doc fetched) | https://www.terminusapp.com/blog/utm-vs-gclid-vs-fbclid-vs-ttclid/ |
| B6.27 | ef_id | Adobe Advertising Cloud | PS | LIKELY | Listed with dclid/twclid in the same reference | same |
| B6.28 | irclickid | Impact | AF | LIKELY | Not confirmed by a fetched source | (none) |
| B6.29 | sscid | ShareASale | AF | LIKELY | Not confirmed by a fetched source | (none) |
| B6.30 | awc | Awin | AF | VERIFIED | "awc - Awin" | https://gclidtracker.com/blog/every-ad-platform-click-id-explained |
| B6.31 | cjevent | CJ Affiliate | AF | LIKELY | Not confirmed by a fetched source | (none) |
| B6.32 | ref= / via= / aff_id | Generic referral/affiliate conventions | AF | LIKELY | Convention, no owner; high false-positive rate on `ref` | (none) |
| B6.33 | Also seen: spclid (Spotify), qclid (Quora), adct (AdRoll), ob_click_id (Outbrain), tbclid (Taboola) | various | PSo / native | VERIFIED | listed in the same click-id reference | https://gclidtracker.com/blog/every-ad-platform-click-id-explained |

### B7. Which names are per-person identifiers (we still never read the value)

| Name | Status | Evidence (under 20 words) | URL |
|------|--------|---------------------------|-----|
| _hsenc (HubSpot) | VERIFIED | "tracks the identity of the user who clicked on the email" | https://community.hubspot.com/t5/APIs-Integrations/Connect-hsenc-with-contact-ID/m-p/816729 |
| mc_eid (Mailchimp) | VERIFIED | "per-recipient identifier ... tied to the specific email address the newsletter was sent to" | https://linkclean.app/trackers/mc-eid/ |
| ck_subscriber_id (Kit) | VERIFIED | value "is the ID of the subscriber in your account" | https://support.convertbox.com/knowledge-base/targeting-visitors-in-your-convertkit-account/ |
| ml_subscriber (MailerLite) | VERIFIED | "used for tracking subscribers and connecting them to clicks" | https://github.com/brave/brave-browser/issues/17507 |
| mkt_tok (Marketo) | VERIFIED | "joins an email click to a specific lead record" | https://www.terminusapp.com/blog/utm-vs-gclid-vs-fbclid-vs-ttclid/ |
| vero_id (Vero) | LIKELY | Named as a tracking parameter; per-person by product design, no doc quote | same |
| gclid, fbclid, msclkid, ttclid, etc. | VERIFIED (per-CLICK, not per-person) | "unique identifier that ad platforms append ... when a user clicks an ad" | https://gclidtracker.com/blog/every-ad-platform-click-id-explained |

Reading the NAME `_hsenc` or `mc_eid` says "this visitor arrived from a
personalised email" and nothing more. The value is the identifier; the name
is the channel. The snippet must strip these from anything it forwards and
must never echo the query string.

## C. The learning approach

| # | Claim | Status | Evidence (under 20 words) | URL |
|---|-------|--------|---------------------------|-----|
| C8a | A published maintainer process (isbot, ua-parser-js, DeviceAtlas) for mining unknown UA tail tokens in aggregate | FALSE (none found) | Maintainers accept community-submitted patterns via issues; no aggregate-mining writeup located | https://github.com/faisalman/ua-parser-js |
| C8b | Aggregate UA clustering to surface new browsers/apps is a described technique | VERIFIED | "extract some new keywords that can represent a new device, a new OS, a new browser" (Levenshtein clustering) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11537642 |
| C8c | Test-period vs reference-period diffing to seed discovery of new UAs | VERIFIED | "detect any new user-agent strings used during the test period but not during the reference period" | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11120004 |
| C8d | Vectorise + UMAP cluster UAs at scale (practitioner writeup) | VERIFIED | "UMAP can project high-dimensional encoded user agents into a 2-dimensional image to explore clusters" | https://www.splunk.com/en_us/blog/tips-and-tricks/text-vectorisation-clustering-and-similarity-analysis-with-splunk-exploring-user-agent-strings-at-scale.html |
| C8e | A published k-anonymity threshold for surfacing a new UA token | UNVERIFIED | None of the sources states a minimum count | (none) |

Rawuser implication: if we ever mine the tail, we set our own threshold
(propose: a token must appear across at least 2 customers and at least 50
sessions before it is even shown to a human, and only the token, never the
full UA). A privacy review before any collection code.

## Summary: what is solid enough to ship, and what is not

Solid now. Three generic signals survive the evidence. First, `Sec-Fetch-Site`
is a request header the edge already receives, in Safari too; `none` means
the load had no web initiator (typed, bookmark, or handed over by an app),
and any other value means a web page linked here. That is the honest split
we can make; typed versus app-opened stays indistinguishable, and the client
cannot help (`PerformanceNavigationTiming.type` collapses everything to
`navigate`). Second, on Android, `navigator.userAgentData.brands` containing
`Android WebView` is a first-party, default-exposed, low-entropy hint that
names the webview class without naming the app; pair it with the `; wv)` UA
token as a fallback. Third, click-id and email-tool parameter NAMES are
stable, documented, and channel-revealing; the list above extends ADR 0028's
seven names to roughly thirty, plus `oppref` for OpenAI, and the email-tool
names classify a visit as "personalised email" without reading a value.

Not solid. iOS webview detection by the missing `Safari/` token is
directionally right but has verified false negatives (Facebook on iOS 26
looks like Safari) and the false-positive list in the brief was wrong
(CriOS, FxiOS carry `Safari/`). Treat "no Safari/ on iPhone" as a weak
boost, never a gate. SFSafariViewController referrer behaviour is
unverified. Custom Tabs referrers exist but only when the app opts in. No
maintainer publishes a tail-mining process or a k-anonymity threshold; we
would be defining our own.

## Gaps to close next (one fetch each)

- A1 verbatim: the Chrome UA doc moved (404) and web.archive.org is blocked
  for the fetch tool. Try the Chromium source for the WebView UA builder
  (`android_webview/` in chromium/src) or Android's WebSettings docs.
- A4c: Apple `SFSafariViewController` docs for referrer behaviour.
- B6.7, B6.28, B6.29, B6.31: vendor docs for srsltid, irclickid, sscid, cjevent.

## Fetch log (20/20)

1. developer.chrome.com/docs/multidevice/user-agent (404)
2. web.dev/articles/user-agent-client-hints (404)
3. search: userAgentData brands "Android WebView"
4. search: WKWebView UA missing Safari/ false positives
5. search: Custom Tabs EXTRA_REFERRER / SFSafariViewController referrer
6. MDN PerformanceNavigationTiming/type
7. search: click-id parameter list
8. search: isbot / ua-parser-js / DeviceAtlas unknown-UA process
9. chromium.org/updates/ua-reduction
10. MDN Sec-CH-UA
11. search: "Android WebView" brand Sec-CH-UA
12. github bowser issue 456
13. developer.chrome.com custom-tabs guide-ui-customization
14. MDN Sec-Fetch-Site
15. leadtrackr.io advertising-click-ids
16. search: email/affiliate parameter list
17. search: _hsenc / mc_eid / ck_subscriber_id / ml_subscriber
18. search: UA clustering k-anonymity
19. web.archive.org Chrome UA page (blocked)
20. blink-dev Intent to Ship UA-CH on Android WebView
