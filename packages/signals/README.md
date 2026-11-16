# @rawuser/signals

Where a visit came from, read from one request.

A click from ChatGPT's app, from Instagram's in-app browser or from a
message often arrives with no referrer, and analytics files it as direct.
The request still says more than that: ChatGPT tags its own links, an
app's browser marks its user agent, an ad platform adds a click id. This
package reads those and gives you one small object.

It sets no cookie, stores nothing, calls nothing and does not identify a
visitor.

## Install

    npm install @rawuser/signals

One file with its types, no dependency.

## Use

```js
import { extractSignals } from "@rawuser/signals";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const signals = extractSignals({
      url,
      headers: request.headers,
      selfHost: url.hostname,
      entryPath: url.pathname,
    });
    return Response.json(signals);
  },
};
```

It needs only `URL` and `Headers`, so it runs in Cloudflare Workers, Node
18 and later, Deno, Bun and a browser.

What comes back, for four visits:

| The visit | What it finds |
|---|---|
| `/?utm_source=chatgpt.com` | `aiSource: "chatgpt"` |
| a referrer of `https://www.perplexity.ai/search?q=...` | `aiSource: "perplexity"`, `referrerHost: "www.perplexity.ai"` |
| opened inside Instagram | `appSource: { app: "instagram", channel: "social", confidence: "high" }` |
| `/pricing?gclid=...` | `clickId: "google-ads"`, `linkFamily: "paid-search"` |

## What it knows

- 39 AI assistant hosts, with the tags and user agents their apps and
  fetchers use.
- 22 in-app browser markers: social, messaging and search apps.
- 42 click id and tracked-link parameter names.
- 79 named sources: search engines, social networks, communities and AI
  assistants.

The tables are exported (`AI_REFERRER_HOSTS`, `APP_UAS`,
`CLICK_ID_PARAM_NAMES`, `SOURCE_NAMES`), and so are the single readers:
`detectAiSource`, `detectAppSource`, `parseClickId`, `parseReferrerHost`,
`parseUtm`, `matchUtmSource`, `matchReferrerHost`, `classifyDevice`.

## What it leaves alone

- A referrer is cut to its host. The path and the query are never kept.
- A click id is known by its name. Its value is never read.
- The user agent is read and not returned.
- The country is the code you pass in (`cf.country` on Cloudflare). It is
  never worked out from an address.

## Types

Written in TypeScript; the types ship with the package.

## Part of Rawuser

[Rawuser](https://github.com/agshinrajabov/rawuser-oss) changes a page's
words by why a visitor came. This package is its first step, kept on
its own because the question "where did this visit come from" is worth
answering without the rest. To go from these signals to an intent, see
[`@rawuser/intent`](https://www.npmjs.com/package/@rawuser/intent).

MIT.
