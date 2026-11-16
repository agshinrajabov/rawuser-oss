# In-app browser User-Agent markers (2025-2026)

> Research note, 2026-09-10. Web-only, 20-call budget. Feeds the L2 source-recovery
> item in the backlog: a visit with empty `document.referrer` whose UA carries one
> of these tokens came from inside an app, so the source is recoverable (source, not person).
> Status: VERIFIED = full UA quoted on the source page. LIKELY = token from a secondary
> source, no full string. UNKNOWN = nothing found.

| App | UA substring | Example UA (quoted) | Status | Source |
|---|---|---|---|---|
| ChatGPT iOS app | `ChatGPT/` (native HTTP client) | `ChatGPT/1.2024.348 (iOS 16.7.12; iPhone10,5; build 12643679358)` | VERIFIED (client UA); webview marker UNKNOWN | https://useragents.io/uas/chatgpt-1-2024-348-ios-16-7-12-iphone10-5-build-12643679358_9ce6289cf9f8629a59507ee88644c6d9 |
| ChatGPT Android app | none found | | UNKNOWN | |
| Perplexity app | none found (only `Perplexity-User/1.0` server agent) | | UNKNOWN | https://docs.perplexity.ai/guides/bots |
| Claude app | none found | | UNKNOWN | |
| Gemini app | none found | | UNKNOWN | |
| Microsoft Copilot app | none found | | UNKNOWN | |
| Instagram iOS | `Instagram <ver>` | `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.24.107 (iPhone15,2; iOS 18_5; en_US; ...)` | VERIFIED | https://gotoapp.store/blog/detect-in-app-browser |
| Instagram Android | `Instagram 3xx...Android` | token only | LIKELY | https://useragent.in/in-app-browser-user-agents |
| Facebook iOS | `FBAN/FBIOS`, `FBAV/` | `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.35.100;FBBV/...;FBDV/iPhone15,2]` | VERIFIED | https://gotoapp.store/blog/detect-in-app-browser |
| Facebook Android | `FB_IAB/FB4A`, `FBAV/` | token only | LIKELY | https://useragent.in/in-app-browser-user-agents |
| Messenger | `FBAN/MessengerForiOS`, `FB_IAB/Orca-Android` | token only | LIKELY | https://useragent.in/in-app-browser-user-agents |
| LinkedIn iOS | `LinkedInApp` | `Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.8684.7` | VERIFIED | https://user-agents.net/applications/linkedinapp |
| TikTok Android | `BytedanceWebview`, `musical_ly`, `trill_` | `Mozilla/5.0 (Linux; Android 11; 21061119AG Build/RP1A.200720.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.131 Mobile Safari/537.36 trill_2022109040 JsSdk/1.0 NetType/MOBILE Channel/googleplay AppName/musical_ly app_version/21.9.4 ByteLocale/ru-RU ByteFullLocale/ru-RU Region/KG BytedanceWebview/d8a21c6` | VERIFIED | https://github.com/omrilotan/isbot/issues/284 |
| TikTok iOS | `musical_ly_`, `BytedanceWebview` | `Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_21.1.0 JsSdk/2.0 NetType/4G Channel/App Store ByteLocale/ru Region/RU ByteFullLocale/ru-RU isDarkMode/1 WKWebView/1 BytedanceWebview/d8a21c6` | VERIFIED | https://github.com/omrilotan/isbot/issues/284 |
| X / Twitter | `Twitter for iPhone`, `Twitter for Android` | token only | LIKELY | https://useragent.in/in-app-browser-user-agents |
| Snapchat | `Snapchat/` | `Snapchat/10.29.1.0 (iPhone10,1; iOS 11.2; gzip)` is the native client, not the webview | LIKELY | https://user-agents.net/string/snapchat-10-29-1-0-iphone10-1-ios-11-2-gzip |
| Pinterest | `Pinterest` | token only | LIKELY | https://gotoapp.store/blog/detect-in-app-browser |
| Reddit | none (system-style browser) | | UNKNOWN | |
| WhatsApp | none for normal links (system browser) | | UNKNOWN | https://u2l.ai/blog/whatsapp-link-opens-in-browser |
| Telegram iOS | NONE. UA identical to Safari | issue author's wished-for string `... Safari/604.1 Telegram 3.6.1123` is NOT what ships | VERIFIED (absence) | https://github.com/TelegramMessenger/Telegram-iOS/issues/736 |
| Telegram Android | `Telegram` | token only | LIKELY | https://gotoapp.store/blog/detect-in-app-browser |
| Discord, Slack, YouTube, Gmail, Outlook | none found | | UNKNOWN | |
| Threads | `Barcelona <ver>` | `Barcelona 289.0.0.77.109 Android` (API client UA) | LIKELY | https://github.com/m1guelpf/threads-re |

## (1) Apps that open links in the system browser (no marker)

WhatsApp hands normal chat links to the system browser on both platforms; the late-2025
WhatsApp in-app browser only covers Business Platform template CTA buttons, marker unknown.
Telegram iOS uses an in-app view that sends the plain Safari UA (issue #736), so it is
indistinguishable from Safari; Android Telegram carries `Telegram`. Reddit, Discord, Slack,
YouTube, Gmail and Outlook returned no marker in any source. They use SFSafariViewController
(iOS) or Chrome Custom Tabs (Android), which send the stock Safari / Chrome UA. Treat them as
"direct" that cannot be recovered from UA alone.

## (2) Generic webview markers

Android: `; wv)` inside the platform parenthesis plus `Version/4.0` before `Chrome/`
(see the TikTok Android string above, which carries both). Chrome Custom Tabs do NOT carry
`wv`. iOS: an `AppleWebKit/605...` UA with `Mobile/15E148` but no `Safari/` token is a
WKWebView (Instagram, Facebook, LinkedIn, TikTok strings above all lack `Safari/`).
SFSafariViewController keeps `Safari/`, which is why Telegram iOS is invisible.

## (3) ChatGPT on iOS 17+

The only real string found is the app's native networking client:
`ChatGPT/1.2024.348 (iOS 16.7.12; iPhone10,5; build 12643679358)`. Version format is
`1.<year>.<build-day>` (calendar-style). No source shows the UA of the in-app view that opens
a cited link; if OpenAI uses SFSafariViewController, the page sees the plain Safari UA and
the `ChatGPT/` token never reaches us. Empirical test needed on a real device before the
snippet relies on it.

## Next step

Log `navigator.userAgent` on the marketing site for empty-referrer visits (token-level,
aggregate only, no storage of the full string) to fill the UNKNOWN rows with our own
evidence. A privacy review before that lands.
