# @rawuser/signals

Where a visit came from, and why it came, read from one request.

A click from ChatGPT's app, from Instagram's in-app browser or from a
message often arrives with no referrer, and analytics files it as direct.
The request still says more than that: ChatGPT tags its own links, an
app's browser marks its user agent, an ad platform adds a click id. This
package reads those and gives you one small object.

It sets no cookie, stores nothing, calls nothing and does not identify a
visitor.

## Install

    npm install @rawuser/signals

Two entry points with their types, no dependency:
`@rawuser/signals` for where a visit came from, `@rawuser/signals/intent`
for why. They share one copy of the code.

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

## Why it came

`@rawuser/signals/intent` goes one step further. Give it what one request
says (a tagged link, a referrer, the page opened) and it answers with a
vector over six intents, six sources and six contexts, and with the
strongest intent and source as a pair. It is a set of rules and weights
you can read in the source. No model is called.

```js
import { classify, extractSignals, hasMeaningfulSignal, selectVariantKey } from "@rawuser/signals/intent";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const signals = extractSignals({
      url,
      headers: request.headers,
      selfHost: url.hostname,
      entryPath: url.pathname,
    });
    // Nothing to go on: show the page as it is.
    if (!hasMeaningfulSignal(signals)) return Response.json({ reason: null });

    const vector = classify(signals, Date.now());
    return Response.json({ reason: selectVariantKey(vector) });
  },
};
```

What comes back, for four visits:

| The visit | `selectVariantKey` |
|---|---|
| `/?utm_source=chatgpt.com` | `problem`, `ai` |
| `/pricing?gclid=...` | `pricing`, `paid` |
| a referrer of `https://www.google.com/` | `problem`, `organic` |
| `/pricing`, nothing else | `pricing`, `direct` |

A visit to `/` with no tag, no referrer and no app marker has no
meaningful signal: `hasMeaningfulSignal` is false, and the honest thing to
do is to change nothing.

### The vector

- Intents: `competitor`, `evaluation`, `feature`, `problem`, `brand`,
  `pricing`.
- Sources: `ai`, `social`, `community`, `paid`, `organic`, `direct`.
- Contexts: `price_sensitivity`, `technical_depth`, `urgency`,
  `trust_need`, `mobile_context`, `offhours_context`.

Several can be high at once, and a source never overrides an intent.
`classify(signals, nowMs, timezone)` is a pure function: the same input
and the same time give the same vector. The time only feeds
`offhours_context`.

### What it will not do

It reads why a visit happened, never who made it. There is no visitor id
in or out, and a campaign name that points at a special category (health,
religion, politics and the like) chooses nothing.

## Types

Written in TypeScript; the types ship with the package.

## Part of Rawuser

[Rawuser](https://github.com/agshinrajabov/rawuser-oss) changes a page's
words by why a visitor came: these two steps, then a version of the page
written ahead of time for that reason. Until 0.2.0 the second step was its
own package, `@rawuser/intent`; it now lives here.

MIT.
