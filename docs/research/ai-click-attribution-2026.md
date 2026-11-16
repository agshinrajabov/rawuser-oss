# AI click attribution: what a click inside ChatGPT, Claude, Perplexity, Gemini, Copilot or Grok actually carries (2026)

> Research note, 2026-09-12. Two founder questions: (Q1) why a click from an AI
> product lands on a customer site as "direct", and what we can read; (Q2)
> whether we can require `utm_source` on inbound links. Every claim carries a
> URL. `[observed]` = we measured it ourselves today; `[vendor]` = an
> analytics/SEO vendor's write-up, not independently reproduced by us;
> `[unverified]` = we could not confirm it from any primary source;
> `[conflict]` = sources disagree. Privacy-zero holds throughout: every signal
> below is a source or topic label, never a person.

## 0. The two facts that explain almost everything

1. **Browsers only send the origin cross-site.** Chrome's default `Referrer-Policy` became
   `strict-origin-when-cross-origin` in Chrome 85
   (https://developer.chrome.com/blog/referrer-policy-new-chrome-default); Firefox followed in March
   2021 and Safari caps referrers to the origin on cross-origin navigations
   (https://caniuse.com/mdn-http_headers_referrer-policy_default_strict-origin-when-cross-origin).
   So even a "good" AI referrer is `https://chatgpt.com/`, nothing more: no conversation id, no
   query. That is by design and it is fine for us.
2. **Native apps do not send a referrer unless they choose to.** A link opened from a native app
   into a WebView, an in-app browser or the system browser has no web initiator; the Fetch Metadata
   spec classes such navigations as user-originated (`Sec-Fetch-Site: none`)
   (https://www.w3.org/TR/fetch-metadata/). Every "AI shows as direct" story is this fact plus
   which apps add a parameter (only ChatGPT).

## 1. Q1: product by product

| Product | Referrer on a web-app click | Parameter appended | `#:~:text=` | Native app (mobile) | Desktop app |
|---|---|---|---|---|---|
| ChatGPT | `chatgpt.com` (was `chat.openai.com`), sometimes missing [vendor] | `utm_source=chatgpt.com` (survives in apps) | not documented | WKWebView / Android WebView or Custom Tabs, referrer dropped, utm kept [vendor] | built-in browser since Atlas closed 2026-08-09; referrer [unverified] |
| Claude | `claude.ai` | none | not documented | referrer "inconsistent"/"stripped" [vendor]; UA marker unknown | [unverified] |
| Perplexity | `perplexity.ai` (most reliable of the set) [vendor] | none | not documented | ~70% of mobile sessions keep referrer [vendor, secondary] | Comet = Chromium, looks like Chrome |
| Gemini | `https://gemini.google.com/` (origin only) [observed] | none | AI Overviews: yes [vendor] | iOS webview UA `GoogleWv/1.0 (WKWebView) GeminiiOS/...`; ~9% keep referrer [vendor] | n/a |
| AI Overviews / AI Mode | `google.com`, identical to organic | none | yes [vendor] | n/a | n/a |
| Copilot | `https://copilot.microsoft.com/` (origin only) [observed] | none | not documented | app strips referrer [vendor] | [unverified] |
| Grok | `grok.com` / `grok.x.com`, origin only [observed] | none | not documented | [unverified] | [unverified] |
| Meta AI | `meta.ai` [vendor] | none known | unknown | [unverified] | n/a |
| DuckDuckGo AI | `duckduckgo.com` (`Referrer-Policy: origin`) [observed] | none known | unknown | [unverified] | n/a |
| Comet / Dia / Atlas | user's own navigation; Chromium UA | none | n/a | Comet iOS is WebKit | Atlas shut 2026-08-09 |

### 1.1 ChatGPT (OpenAI)

- **The auto-tag.** OpenAI's own Publishers & Developers FAQ states that ChatGPT automatically
  includes `utm_source=chatgpt.com` in referral URLs so publishers can track inbound traffic from
  ChatGPT search results
  (https://help.openai.com/en/articles/12627856-publishers-and-developers-faq; the page returned
  HTTP 403 to our fetcher, the statement is quoted from the search index, so treat the exact wording
  as [unverified], the fact as corroborated below).
- **Since when.** Across 100 tracked brands the parameter first appeared in July 2024 (8
  sessions/month) and reached 38,000 sessions/month by early 2026; it rides on ChatGPT Search,
  browsing citations and Shopping carousels (https://www.lawrencehitches.com/utm-source-chatgpt-explained/)
  [vendor]. On 2026-06-16 OpenAI extended it from citations to the "More" sources list (Glenn Gabe
  via https://www.seroundtable.com/openai-chatgpt-analytics-update-39590.html).
- **Still on in 2026.** Userscripts and Chrome extensions exist purely to strip it
  (https://greasyfork.org/en/scripts/553465-chatgpt-remove-utm-source-from-links-clean-urls,
  https://chromewebstore.google.com/detail/clean-chatgpt-utm-links/ljjiijcjhomchjklpnmhfbdohjpbkiig).
- **[conflict]** utm.new (updated 2026-09-03) says "The link ChatGPT shows is your link. ChatGPT
  doesn't mint a tracking URL" and warns operators not to self-tag canonical pages
  (https://utm.new/platforms/chatgpt). It describes what the *operator* can do; it does not
  contradict the auto-appended parameter.
- **Referrer.** When present it is `chatgpt.com` (formerly `chat.openai.com`)
  (https://utm.new/platforms/chatgpt). Loamly's table rates ChatGPT web as "sometimes passes
  referrer" and ChatGPT mobile as "stripped entirely"
  (https://www.loamly.ai/blog/ai-traffic-attribution-crisis) [vendor].
- **Mobile apps.** A 2026-09-05 write-up says the iOS app opens links in WKWebView and the Android
  app in a WebView or Chrome Custom Tabs, both dropping `Referer`, while `utm_source=chatgpt.com`
  "does survive mobile in-app browsers, it's embedded in the URL itself"
  (https://seresa.io/blog/data-loss/why-mobile-ai-app-traffic-has-zero-referrer-in-ga4) [vendor].
  Primary evidence that the iOS app's WKWebView strips `Referer`: OpenAI's own Apps SDK examples
  repo, issue #161 (2025-12-22), YouTube embeds fail with error 153 inside the ChatGPT iOS app
  because the Referer is missing (https://github.com/openai/openai-apps-sdk-examples/issues/161).
  Measured effect: in a 30-day Clickport snapshot (2026-04-23) 35.7% of sessions already labelled AI
  Search had no referrer at all; their `utm_source` tag is what labelled them
  (https://clickport.io/blog/chatgpt-direct-traffic-ga4) [vendor]. The native HTTP client UA
  `ChatGPT/1.2024.348 (iOS ...)` is known (docs/research/in-app-browser-ua-2026.md); the in-app
  *webview* UA marker is still unknown.
- **Desktop.** OpenAI shut the standalone Atlas browser on 2026-08-09 and moved browsing into the
  ChatGPT desktop app
  (https://www.techradar.com/pro/openai-shuts-down-its-atlas-browser-after-not-even-a-year,
  https://www.techedt.com/chatgpt-atlas-to-shut-down-on-9-august-as-openai-moves-browser-features-into-chatgpt).
  A help article "Using the built-in browser in the ChatGPT desktop app" exists
  (https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app,
  403 to our fetcher). What referrer that built-in browser sends is [unverified].
- **Anchor attributes.** `chatgpt.com` serves a Cloudflare challenge to unauthenticated fetchers
  (HTTP 403, `cf-mitigated: challenge`) [observed], so we could not read the answer DOM. The
  `referrer-policy: same-origin` header on that response belongs to the challenge page, not the app.
  Since a `chatgpt.com` referrer is widely observed, citation anchors are evidently not
  `rel="noreferrer"`; `target`/`rel` values remain [unverified].
- **Fetchers, not clicks.** `ChatGPT-User/1.0` is used "for certain user actions in ChatGPT and
  Custom GPTs" (the model fetching a page mid-answer); `OAI-SearchBot/1.4` indexes for search;
  `GPTBot/1.4` trains (https://developers.openai.com/api/docs/bots). None of these is the human's
  click.
- **Ads.** Similarweb (2026-07-29): about 26% of ChatGPT responses now contain an ad
  (https://aisearch.similarweb.com/blog/gen-ai-stats/). Our click-id table already treats OpenAI's
  `oppref` as paid + ai (ADR 0029).

### 1.2 Claude (Anthropic)

- **Referrer.** GA4 shows `claude.ai / referral` for in-conversation clicks and many Claude visits
  land as Direct "because mobile apps or privacy settings suppress the referrer"
  (https://www.rankshift.ai/blog/how-to-track-claude-referrals-in-ga4/, 2026-01-26) [vendor]. Loamly
  rates Claude's referrer "inconsistent" (https://www.loamly.ai/blog/ai-traffic-attribution-crisis)
  [vendor].
- **[unverified]** One source claims the referrer string is `claude.ai/referral/YYYY-MM-DD` with the
  conversation date in the path (https://www.lawrencehitches.com/claude-ai-referral-traffic/,
  2026-06-17). No second source shows a path, GA4's "source / medium" notation (`claude.ai /
  referral`) reads the same way, and a path would require a non-default referrer policy. Treat as a
  misreading until a raw log shows it.
- **No parameter.** "Claude still doesn't append UTM parameters by default"
  (https://utmgrabber.com/blog/track-ai-referral-traffic-chatgpt-gemini-claude/) [vendor].
- **Apps.** Anthropic documents `Claude-User` ("when individuals ask questions to Claude, it may
  access websites using a Claude-User agent"), `ClaudeBot` and `Claude-SearchBot`
  (https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)
  but nothing about how the mobile or desktop apps open external links. No in-app webview UA marker
  is published anywhere we found [unverified].
- **Share.** Claude grew from ~2% to ~9% of worldwide gen-AI web traffic between June 2025 and May
  2026 (https://aisearch.similarweb.com/blog/gen-ai-stats/); in B2B it is ~18.5% of measurable AI
  referrals (Mar-Apr 2026) (https://higoodie.com/blog/ai-search-traffic-report-2026/) [vendor].
- **Origin headers.** `claude.ai` also answers with a Cloudflare challenge (403) [observed]; DOM
  attributes [unverified].

### 1.3 Perplexity

- **Referrer.** "Perplexity citations arrive with a `perplexity.ai` referrer"; the URL is the
  canonical URL, no parameters, "nothing to tag" (https://utm.new/platforms/perplexity, updated
  2026-08-13). Loamly: "usually passes perplexity.ai"
  (https://www.loamly.ai/blog/ai-traffic-attribution-crisis) [vendor].
- **Mobile.** Perplexity passes a referrer on roughly 70% of mobile sessions versus ~9% for the
  Gemini app, attributed to SearchPilot's platform reference
  (https://seresa.io/blog/data-loss/why-mobile-ai-app-traffic-has-zero-referrer-in-ga4) [vendor,
  secondary; SearchPilot original not located].
- **Fetchers.** `Perplexity-User/1.0` "supports user actions within Perplexity ... it might visit a
  web page ... and include a link to the page"; `PerplexityBot/1.0` indexes
  (https://docs.perplexity.ai/guides/bots).
- **Comet.** Chromium-based; HUMAN says it is "indistinguishable from a standard Chromium browser to
  most detection systems" and detects it behaviourally
  (https://www.humansecurity.com/ai-agent/perplexity-comet/). Comet for iOS is WebKit and
  third-party apps still open Safari View Controller, not Comet
  (https://www.macstories.net/news/comet-is-the-first-agentic-browser-for-ios-worth-trying/). Comet
  was 47.6% of all agentic traffic in June 2026
  (https://www.humansecurity.com/learn/blog/state-of-agentic-traffic-june-2026-browser-agent-tooling-for-developers-is-catching-on-fast/).
- **GA4.** Perplexity is absent from Google's AI Assistant channel definition and lands in Referral
  (https://support.google.com/analytics/answer/9756891?hl=en).
- `www.perplexity.ai` serves a Cloudflare challenge [observed].

### 1.4 Gemini, AI Overviews, AI Mode (Google)

- **Gemini web** serves `<meta name="referrer" content="origin">` on its HTML [observed 2026-09-12
  with curl], so a click carries exactly `https://gemini.google.com/`. GA4 shows `gemini.google.com
  / referral`; Gemini "does not use custom UTM parameters"; when Gemini runs as the Android
  assistant "the referrer is often stripped"
  (https://www.lawrencehitches.com/gemini-referral-traffic/) [vendor].
- **Gemini iOS app** opens sources in an internal WKWebView whose UA is `Mozilla/5.0 (iPhone; CPU
  iPhone OS 18_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148
  GoogleWv/1.0 (WKWebView) GeminiiOS/1.2025.4170000` (found by Natzir, undocumented by Google,
  2025-10-29, https://www.seroundtable.com/geminiios-google-user-agent-40333.html). This is the one
  AI in-app webview marker with a full quoted UA; our app-source table should learn it.
- **AI Overviews / AI Mode** clicks carry the same `google.com` referrer as a blue link and GA4
  files them as Organic Search
  (https://seresa.io/blog/ai-data-readiness/google-ai-mode-shows-as-organic-in-ga4-your-largest-ai-channel-is-hidden)
  [vendor]. Google's own channel doc: the AI Assistant channel "excludes Google's AI Overviews and
  AI Mode" (https://support.google.com/analytics/answer/9756891?hl=en). Search Console counts them
  inside the "Web" search type, not separately
  (https://higoodie.com/blog/track-traffic-from-ai-overviews/, 2026-05-28).
- **The noreferrer episode.** On 2025-05-22 AI Mode links were found to carry `noreferrer` (Tom
  Critchlow, Patrick Stox; John Mueller: "this seems unexpected")
  (https://searchengineland.com/googles-ai-mode-traffic-untrackable-455883); Google removed the
  `rel="noopener noreferrer"` by 2025-05-28
  (https://www.searchenginejournal.com/google-fixes-ai-mode-traffic-attribution-bug/547946/).
  **[conflict]** a 2026 seresa post still asserts "every outbound link carries the noreferrer
  attribute"
  (https://seresa.io/blog/ai-data-readiness/google-ai-mode-uses-noreferrer-your-analytics-cannot-see-the-traffic);
  it cites a Foundry CRO analysis without a date. We treat the SEJ fix as current and the seresa
  claim as stale.
- **Text fragments.** "When a user clicks a link inside a Google AI Overview, the URL they land on
  often includes ... `#:~:text=`" (https://higoodie.com/blog/track-traffic-from-ai-overviews/)
  [vendor]. This is the only client-side clue that separates an AI Overview click from an organic
  one.

### 1.5 Copilot (Microsoft)

- Copilot started sending `https://copilot.microsoft.com` as referrer around 2024-03-29 (reported by
  Himanshu Sharma,
  https://www.seroundtable.com/microsoft-copilot-referrer-data-in-google-analytics-37133.html).
  Ahrefs' Feb 2025 study still saw Copilot traffic registering as Direct
  (https://ahrefs.com/blog/ai-traffic-study), so this has flapped.
- `copilot.microsoft.com` serves `<meta name="referrer" content="origin-when-cross-origin"/>`
  [observed 2026-09-12], so the referrer is the bare origin.
- No parameters; the mobile app "strips it like everyone else"
  (https://maxaeo.ai/blog/ai-referral-traffic/) [vendor]. Copilot is in GA4's AI Assistant list
  (https://support.google.com/analytics/answer/9756891?hl=en).
- Copilot inside Bing answers arrives as `bing.com`, indistinguishable from Bing organic (regex
  lists include `bing.com/copilot`,
  https://www.conversios.io/blog/track-ai-referral-traffic-from-chatgpt-in-ga4/) [vendor].

### 1.6 Grok (xAI)

- `grok.com` answers with `referrer-policy: origin-when-cross-origin` [observed 2026-09-12]:
  origin-only referrer. Hosts seen in analytics: `grok.x.com` and `grok.com`; "Grok doesn't pass
  query parameters indicating which question triggered the citation"
  (https://www.utmguard.com/blog/grok-ai-x-twitter-traffic-ga4, 2025-11-20) [vendor]. Grok is in
  GA4's AI Assistant list. One 2026 study found Grok's outbound referral volume "effectively zero"
  while in-session depth was highest (https://higoodie.com/blog/ai-search-traffic-report-2026/)
  [vendor]. Grok mobile app behaviour [unverified].

### 1.7 Meta AI and DuckDuckGo

- `meta.ai` appears in vendor referrer regexes and is not in GA4's AI list
  (https://www.mo.agency/blog/how-to-track-ai-traffic-and-referrals-in-google-analytics-4) [vendor].
  Meta AI inside WhatsApp/Instagram opens links in those apps' in-app browsers, whose UA markers we
  already read (ADR 0028). `www.meta.ai` returned 403 to us; the rest is [unverified].
- `duckduckgo.com` sends `referrer-policy: origin` [observed 2026-09-12]; `duck.ai` reset the
  connection, so Duck.ai answer-link attributes are [unverified]. Duck.ai lives at `duck.ai` and
  `duckduckgo.com/chat` (https://duckduckgo.com/duckduckgo-help-pages/duckai); since we keep only
  the referrer host, a Duck.ai click is a DuckDuckGo search click unless it comes from `duck.ai`.

### 1.8 Agentic browsers (Comet, Atlas, Dia, Claude in Chrome)

- They are Chromium; "with basic fingerprinting techniques, they appear almost identical to a
  generic Chrome browser"
  (https://seresa.io/blog/ai-bot-filtering/chatgpt-atlas-and-perplexity-comet-are-already-in-your-analytics,
  2026-04-21) [vendor]. No full UA string for any of them is quoted anywhere we found [unverified].
- June 2026 mix: Comet 47.6% of agentic traffic; Claude's Chrome extension overtook Atlas
  (https://www.humansecurity.com/learn/blog/state-of-agentic-traffic-june-2026-browser-agent-tooling-for-developers-is-catching-on-fast/).
  Atlas shut down 2026-08-09 (TechRadar, above). A click made by the human in such a browser carries
  the referrer of whatever page they were on; a click made by the agent is what Cloudflare's
  signed-agents program is for (see 2.4).

## 2. Cross-cutting mechanics

### 2.1 What we could and could not read on the products' own origins

`[observed 2026-09-12, curl with a Chrome UA]`: `chatgpt.com`, `claude.ai`, `www.perplexity.ai` all
return a Cloudflare managed challenge (HTTP 403, `cf-mitigated: challenge`), so anchor `rel`,
`target` and `referrerpolicy` attributes of their answer DOM are unreadable without a logged-in
session (a one-hour job in the founder's own browser, the only way left to document them).
`gemini.google.com` (`meta referrer=origin`), `copilot.microsoft.com` (`meta
referrer=origin-when-cross-origin`), `grok.com` and `duckduckgo.com` (`Referrer-Policy` headers)
are readable and all resolve to origin-only referrers.

### 2.2 Sec-Fetch-Site / Sec-Fetch-Dest

- Values: `cross-site`, `same-origin`, `same-site`, `none`; `none` is "a user-originated operation.
  For example: entering a URL into the address bar, opening a bookmark"
  (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site). Top-level
  navigations carry `Sec-Fetch-Dest: document` (https://www.w3.org/TR/fetch-metadata/). Baseline
  across browsers since March 2023 (MDN, above).
- A click inside a web app (chatgpt.com in a tab) arrives as `cross-site` even if the referrer is
  suppressed; a link handed to the system browser by a native app arrives as `none`. So
  `Sec-Fetch-Site: none` + empty referrer + `utm_source=chatgpt.com` is the exact fingerprint of
  "ChatGPT app, system browser", and `none` + no referrer + no params on a deep page is the "unknown
  app" bucket.
- Caveat for Android: since Chrome 110 requests initiated by Chrome Custom Tabs send
  `Sec-Fetch-Site: cross-site` instead of `none` (Beer, Squarcina, Veronese, Lindorfer, "Tabbed
  Out", IEEE S&P 2024, https://minimalblue.com/data/papers/SP24_tabbed_out.pdf), so Custom-Tab opens
  look like web clicks. WKWebView / SFSafariViewController behaviour is [unverified].
- **Rawuser reality:** these headers exist only on the navigation to the customer's origin. Our
  snippet's `fetch('/select')` carries its own `Sec-Fetch-Site: cross-site` (page to edge), which
  says nothing about how the page was reached. Proxy/HTMLRewriter tier only, as the backlog records.

### 2.3 Text fragments (`#:~:text=`)

- Spec: the fragment directive "is stripped from the URL during loading so that author scripts
  cannot directly interact with it" (https://web.dev/articles/text-fragments). Cross-origin
  text-fragment navigations must be user-activated and in a `noopener` context (same page), which is
  why AI citation links (new tab, noopener) qualify.
- Support: Chrome 80+, Edge 83+, Safari 16.1+, Firefox 131+
  (https://caniuse.com/url-scroll-to-text-fragment). Feature check: `'fragmentDirective' in
  document`.
- The leak: WICG's own API note says "As noted in https://crbug.com/1096983, this is accidentally
  exposed via the performance API. This is a bug that we'd like to fix but some use cases are
  currently relying on this"
  (https://github.com/WICG/scroll-to-text-fragment/blob/main/fragment-directive-api.md). Firefox hid
  it in Firefox 133 (https://bugzilla.mozilla.org/show_bug.cgi?id=1919565); the same bug notes
  Safari 18 does not expose it.
- **[observed 2026-09-12]** In desktop Chrome 152.0.7977.76, loading
  `https://web.dev/articles/text-fragments#:~:text=fragment%20directive` gives `location.hash ===
  ""` while `performance.getEntriesByType('navigation')[0].name` still returns the full URL
  including `#:~:text=fragment%20directive`, and `'fragmentDirective' in document` is `true`. So the
  reader works in Chromium today, and only in Chromium; a Chrome fix can land any release. The
  proposed `document.fragmentDirective.items` API exposes parsed directives (prefix, textStart,
  textEnd, suffix) (WICG doc, above) and would replace the hack if it ships.

### 2.4 What Cloudflare exposes, and why it does not help the human click

- Verified bots are "automated" services: "search engine crawlers, monitoring services, and
  user-driven agents"; verification is Web Bot Auth or a published IP list with a stable UA
  (https://developers.cloudflare.com/bots/concepts/bot/verified-bots/).
- Web Bot Auth = RFC 9421 HTTP Message Signatures with Ed25519 keys published at
  `/.well-known/http-message-signatures-directory`, sent as `Signature-Agent`, `Signature-Input`,
  `Signature` (https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/).
  Cloudflare's 2025-07-01 post: "currently available for all Free and Pro plans", surfaced through
  `cf.verified_bot_category` and Verified Bot Categories in WAF rules
  (https://blog.cloudflare.com/verified-bots-with-cryptography/). Field reference:
  https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.verified_bot_category/.
  Categories include Search, Agent ("user-directed agents visiting a page on behalf of a human"),
  Training, Transact, plus legacy "AI Crawler", "AI Assistant", "AI Search"; Search/Agent/Training
  presets are actionable on all plans
  (https://developers.cloudflare.com/bots/concepts/bot/verified-bots/categories/).
- Signed agents (2025-08-28): ChatGPT agent, Block's Goose, Browserbase, Anchor Browser sign their
  remote-browsing requests (https://blog.cloudflare.com/signed-agents/).
- **Bottom line:** signatures ride on requests made by OpenAI's, Anthropic's or Perplexity's
  infrastructure (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, ChatGPT agent). The human's
  later click comes from their own browser and carries no signature. The field upgrades our bot
  gate and gives a leading indicator ("Claude fetched /pricing 40 times this week"); it never
  attributes a visitor.

### 2.5 What analytics vendors do with the same inputs

- **GA4** added an "AI Assistant" default channel on 2026-05-13: "The medium is set to
  'ai-assistant' and the campaign is set to '(ai-assistant)' if the referrer matches a list of AI
  Assistants ... sources like ChatGPT, Gemini, Deepseek, Copilot, or Grok. It excludes Google's AI
  Overviews and AI Mode" (https://support.google.com/analytics/answer/9756891?hl=en;
  https://www.searchenginejournal.com/google-analytics-adds-ai-assistant-as-default-channel-group/574974/).
  Referrer-only: a no-referrer app click is still Direct.
- **Plausible** groups "ChatGPT, Claude, Perplexity, Gemini, Copilot and other known assistants into
  one AI Assistants channel" when "a visit carries referral information or a UTM tag"
  (https://plausible.io/track-ai-traffic).
- **Adobe Analytics** needs a Marketing Channel processing rule on the referring domain, otherwise
  ChatGPT visits are Direct
  (https://digital-power.com/en/inspiration/measuring-ai-referral-traffic-in-web-analytics/).
- **Fathom** buckets a visit as Paid/Campaign on any UTM or on `gclid`/`msclkid`
  (https://usefathom.com/docs/features/sources).
- **Segment** copies `utm_*` into `context.campaign` only for the page that carried them
  (https://segment.com/docs/connections/sources/catalog/libraries/website/javascript/).
- Loamly (446,405 visits, 20,428 AI sessions, 2025-11-07, updated Feb 2026): 70.6% of AI sessions
  had no referrer; dark AI converted at 10.21% vs 2.46%
  (https://www.loamly.ai/blog/ai-traffic-attribution-crisis) [vendor; proprietary confirmation].
  Ahrefs (3,000 sites, 2025-02-06): AI sends 0.12% of views, ChatGPT half of it, "likely being
  vastly underestimated" (https://ahrefs.com/blog/ai-traffic-study).

## 3. Q2: can we require `utm_source` on inbound links?

### 3.1 What a site controls

A site controls the links it writes (emails, social bios, ads, docs, partner pages) and nothing
else. AI products cite the canonical URL they indexed (https://utm.new/platforms/chatgpt,
https://utm.new/platforms/perplexity), so the only way to "require" a tag on an AI citation is to
make the canonical URL carry one, which "labels every visitor from every source as ChatGPT traffic"
(same source) and forks the canonical for SEO. Not an option. "Required tagging" therefore means:
(1) the customer tags everything they own, (2) we normalise everything else from referrer, UA and
entry path, (3) we accept a residual dark bucket and size it honestly.

### 3.2 Referrer-to-source normalisation is the industry norm

GA4's default channel grouping, Plausible's channel, Adobe's processing rules and Fathom's source
buckets (2.5) all do at the analytics layer what
`packages/shared/src/signals/{referrer,ai-source,app-source}.ts` already does at the edge. The gap
they all share is the no-referrer app click; nobody has a server-side answer to it, which is why
GA4's own list is referrer-only.

### 3.3 What browsers strip (and what survives)

- **Firefox** Query Parameter Stripping (Firefox 102, ETP Strict and Private Browsing; Nightly all
  modes) strips, per the live Remote Settings list: `gclid, dclid, msclkid, _openstat, yclid,
  wickedid, twclid, _hsenc, __hssc, __hstc, __hsfp, hsctatracking, wbraid, gbraid, ysclid, mc_eid,
  oly_anon_id, oly_enc_id, __s, vero_id, mkt_tok, fbclid`; allow-list `googleadservices.com`
  (https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records,
  https://firefox-source-docs.mozilla.org/toolkit/components/antitracking/anti-tracking/query-stripping/index.html).
  No `utm_*`.
- **Brave** has stripped `fbclid`, `gclid`, `msclkid` and similar since 2020
  (https://brave.com/privacy-updates/5-grab-bag/); the wiki (updated 2026-05-06) distinguishes
  simple, conditional and scoped rules and keeps `mkt_tok` on unsubscribe links
  (https://github.com/brave/brave-browser/wiki/Query-String-Filter). Brave does not strip UTMs; it
  blocks the scripts that read them
  (https://seresa.io/blog/ai-data-readiness/utms-survive-but-tracking-dies-why-brave-blocks-scripts-not-parameters)
  [vendor].
- **Safari 17** Link Tracking Protection (WWDC23): "Safari strips the identifying components of the
  URL, while leaving nonidentifiable parts intact" during navigation and link copying
  (https://developer.apple.com/videos/play/wwdc2023/10053/). WebKit (2024-07-16): campaign
  parameters "pass through", click/user-level ones are removed, and in Private Browsing third-party
  scripts see a URL "that has no query parameters or fragment" and no cross-site
  `document.referrer` (https://webkit.org/blog/15697/private-browsing-2-0/). The ~25-entry list
  came from PrivacyTests.org (https://mjtsai.com/blog/2023/06/19/safari-17-link-tracking-protection/);
  Mail and Messages strip on tap too (https://usefathom.com/blog/ios17-link-tracking-protection) [vendor].
- **Consequence for us.** `utm_source` survives every browser; click-id NAMES (`gclid`, `fbclid`,
  `ttclid`, `twclid`, `li_fat_id` ...) go missing in Firefox Strict, Brave and Safari
  Private/Mail/Messages, so ADR 0028's `clk=` signal has a systematic hole on privacy browsers, and
  ChatGPT's `utm_source=chatgpt.com` is the most robust AI marker that exists. In Safari Private our
  snippet also cannot see the fragment, so the text-fragment reader is Chromium-only twice over.

### 3.4 Legal view (ePrivacy / GDPR)

- EDPB Guidelines 2/2023 v2.0 (adopted 2024-10-07), paras 49-51: "Tracking links can function in the
  same way, but the identifier is appended to the website address ... very commonly used by
  eCommerce websites to identify the origin of their inbound source of traffic"; their distribution
  "does constitute storage, at the very least through the caching mechanism"; and "the collection of
  identifiers provided through such tracking mechanisms constitutes a 'gaining of access' in the
  meaning of Article 5(3) ePD"
  (https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf).
  The operative word is *identifier*: a per-click or per-user token.
- GDPR Recital 30: online identifiers "such as internet protocol addresses, cookie identifiers" may
  be used to profile and identify natural persons (https://gdpr-info.eu/recitals/no-30/). `gclid`,
  `fbclid`, `ttclid`, `li_fat_id` are unique per click and are re-joined server-side to an ad
  account's user record (fbclid becomes the `fbc` value,
  https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc); they
  are pseudonymous personal data. `utm_source=chatgpt.com` names a platform, is identical for every
  visitor, and identifies nobody.
- CNIL's audience-measurement exemption requires anonymous statistics, no cross-site identifier and
  no linkage (https://www.cnil.fr/fr/cookies-solutions-pour-les-outils-de-mesure-daudience,
  2025-07-04). A Matomo maintainer reported (2024-02-14) that "direct exchanges with CNIL revealed
  ... that the usage of UTMs 'cancels' consent exemptions"
  (https://github.com/matomo-org/matomo/issues/21941); no CNIL document says this and the exemption
  concerns the *tool's* storage, not the URL, so [unverified].
- **Our posture stays right:** we read `utm_source` values (labels), we read click-id *names* and
  drop the value at extraction (ADR 0028), we store no identifier and set no cookie, so the EDPB
  "access to an identifier" test is not met by anything we keep.

### 3.5 How "required tagging" is done elsewhere

- Google Ads auto-tagging appends `gclid` to the URL "your customers click"
  (https://support.google.com/google-ads/answer/1752125?hl=en), with `gbraid`/`wbraid` for iOS 14.5+
  (https://www.customerlabs.com/blog/what-are-gclid-gbraid-and-wbraid-parameters/) [vendor].
- Meta appends `fbclid` on every ad click (Meta doc, above). LinkedIn adds `li_fat_id` once
  first-party cookies are enabled (https://www.linkedin.com/help/lms/answer/a476761). TikTok appends
  `ttclid` automatically on ad clicks (https://ads.tiktok.com/help/article/tiktok-click-id?lang=en).
- Email tools auto-UTM: Mailchimp appends
  `utm_source=<site>&utm_campaign=<email>&utm_medium=email&utm_term=<id>`
  (https://matomo.org/faq/how-to/how-to-track-mailchimp-email-clicks-in-matomo-using-utm-parameters/);
  HubSpot adds source tracking, optionally only when no tags exist
  (https://community.hubspot.com/t5/HubSpot-Ideas/More-flexibility-needed-on-enabling-disabling-Email-UTM-tracking/idi-p/269588).
- Link-in-bio: Linktree's toggle sets `utm_source=Linktree`, `utm_medium=Social`
  (https://linktr.ee/help/en/articles/5434179-how-to-add-utm-parameters).
- **AI products:** ChatGPT's `utm_source=chatgpt.com` is the only equivalent. Perplexity, Claude,
  Gemini, Copilot, Grok add nothing (sections 1.2-1.6). GA4's convention for manual tags is
  `utm_medium=ai-assistant` (https://utm.new/platforms/perplexity), so customers who tag their own
  "ask ChatGPT about us" links should use it.


## 4. What Rawuser should do

1. **Add the AI auto-tag to `source.ai` now.** `utm_source` values `chatgpt.com`, `chatgpt`,
   `openai`, plus manual-tag conventions `perplexity`, `claude`, `gemini`, `copilot`, `grok`, and
   `utm_medium=ai-assistant` (GA4's convention) all map to `source.ai`; `chatgpt.com` also sets the
   platform. Rationale: OpenAI FAQ (1.1), 35.7% of labelled AI sessions carry the tag without a
   referrer (Clickport, 1.1). Add to `packages/shared/src/signals/tables.ts`; today the AI table
   matches referrer hosts and UAs only.
2. **Extend the AI referrer hosts.** Present: `chatgpt.com`, `chat.openai.com`, `claude.ai`,
   `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`. Add `www.perplexity.ai` (check
   host normalisation), `grok.com`, `grok.x.com`, `meta.ai`, `duck.ai`, `chat.deepseek.com`,
   `atlas.openai.com`, `you.com`, `phind.com`, `chat.mistral.ai`. Sources: 1.6, 1.7, GA4's list
   (2.5).
3. **Learn the Gemini iOS webview marker.** `GeminiiOS/` and `GoogleWv/` substrings (full UA in 1.4)
   go into `app-source.ts` as source.ai + gemini; it is the only AI in-app webview UA with a quoted
   string. Keep the `ua_token_counts` learner on to catch ChatGPT's and Claude's the day they appear
   (ADR 0029).
4. **Do the device capture for L2.** One afternoon with one phone: tap a citation in ChatGPT,
   Claude, Perplexity, Copilot, Grok, Meta AI on iOS and Android against a page that logs UA,
   `Referer`, `Sec-Fetch-Site` and the query string. That closes every [unverified] app row above
   with primary evidence and is cheaper than any more reading.
5. **Ship the citation-fragment reader (L5) as presence-first.** Read
   `performance.getEntriesByType('navigation')[0].name` behind a `'fragmentDirective' in document`
   check, treat "fragment present" as a probable-AI boost on `google.com` and no-referrer visits,
   map the quoted text to a manifest section for the intent boost, never send the text itself
   (section id only). Verified working today in Chrome 152 (2.3); feature-flag it because Chrome can
   close the leak in any release.
6. **Consume `cf.verified_bot_category` for the bot gate, not for visitors.** Free/Pro already
   verify Web Bot Auth (2.4). Use it to serve canonical to `Search`/`Agent`/`Training` bots and to
   count AI fetches per path as the "AI is reading your pricing page" leading indicator on the
   dashboard. Do not expect it on any human click.
7. **Keep Sec-Fetch-Site on the proxy-tier shelf.** It is not visible to the snippet path, and
   Custom Tabs already report `cross-site` (2.2), so even on the proxy tier it only separates
   "typed/app-launched" from "web click".
8. **Tell customers three things, in the onboarding and the Links screen.** (a) Tag every link you
   write: email, bio, docs, partner pages, and turn on platform auto-tagging (gclid, fbclid,
   li_fat_id, ttclid are free). (b) Never put UTMs on canonical URLs; AI cites the clean URL and a
   tagged canonical mislabels everyone (3.1). (c) If you promote "ask ChatGPT about X" links, tag
   them `utm_medium=ai-assistant`. The `/links` generator should offer an "AI assistant" preset that
   does this.
9. **Treat click-id names as a best-effort signal.** Firefox Strict, Brave and Safari
   Private/Mail/Messages remove them (3.3); never let a missing `clk=` argue against a paid
   classification that `utm_medium=cpc` already made.
10. **Make the dark bucket visible.** Split the Signal Coverage card into "AI, tagged" (utm), "AI,
    referred" (host), "AI, app-marked" (UA) and "probably AI, unattributable" (fragment presence, or
    `Sec-Fetch-Site: none` on the proxy tier). Vendors tell customers 70% of AI traffic is dark; a
    tool that shows its own floor is believed.
11. **What is simply not knowable.** A Claude, Copilot, Grok, Meta AI or Gemini-Android app click
    handed to the system browser with no referrer and no parameter is a typed URL as far as HTTP is
    concerned. Nothing distinguishes it, and inventing something (timing, fingerprint, IP) would
    break privacy-zero.

## 5. How much stays dark after all of it (estimate)

Inputs: ChatGPT is ~53% of gen-AI web traffic (May 2026, Similarweb, 1.1) and ~63% of measurable B2B
AI referrals (Goodie, 1.2); its clicks carry `utm_source=chatgpt.com` on web and in-app, so after
item 1 they are attributed with or without a referrer. Gemini is ~27%: the web app sends an origin
referrer, the iOS app is UA-marked (item 3), the Android assistant path keeps a referrer ~9% of the
time [vendor]. Claude ~9% (app clicks largely dark and unmarked), Perplexity ~7% (referrer on most
clicks). AI Overviews/AI Mode are separable only by fragment presence, Chromium only. Weighting
those shares by recoverability gives roughly **25-35% of AI-origin human visits that stay
unattributable after every item in section 4 ships**, concentrated in Claude, Copilot, Grok and
Gemini-Android app clicks and in AI Overview clicks on Safari and Firefox. That is well under the
70.6% dark figure vendors quote for referrer-only tooling (2.5), and the residual is a hard floor,
not a to-do. The estimate is ours; the shares are the vendors'.

## 6. Sources

Every URL is cited inline. Builds on docs/research/ai-landing-signals.md,
in-app-browser-ua-2026.md and generic-source-recovery-2026.md in the same folder.
