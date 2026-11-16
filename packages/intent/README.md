# @rawuser/intent

From a visit's signals to why the visitor came.

Give it what one request says (a tagged link, a referrer, the page
opened) and it answers with a vector over six intents, six sources and
six contexts, and with the strongest intent and source as a pair. It is a
set of rules and weights you can read in the source. No model is called,
nothing is stored, and nothing in it knows who the visitor is.

## Install

It is not on npm yet. Build it from this repository:

    git clone https://github.com/agshinrajabov/rawuser-oss
    cd rawuser-oss
    pnpm install
    pnpm --filter @rawuser/intent build

The build is one file with its types and no dependency, in
`packages/intent/dist/`. Add it to your project by its folder:

    npm install /path/to/rawuser-oss/packages/intent

## Use

```js
import { classify, extractSignals, hasMeaningfulSignal, selectVariantKey } from "@rawuser/intent";

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

## The vector

- Intents: `competitor`, `evaluation`, `feature`, `problem`, `brand`,
  `pricing`.
- Sources: `ai`, `social`, `community`, `paid`, `organic`, `direct`.
- Contexts: `price_sensitivity`, `technical_depth`, `urgency`,
  `trust_need`, `mobile_context`, `offhours_context`.

Several can be high at once, and a source never overrides an intent.
`classify(signals, nowMs, timezone)` is a pure function: the same input
and the same time give the same vector. The time only feeds
`offhours_context`.

## What it will not do

It reads why a visit happened, never who made it. There is no visitor id
in or out, and a campaign name that points at a special category (health,
religion, politics and the like) chooses nothing.

## Types

Written in TypeScript; the types ship with the package.

## Part of Rawuser

[Rawuser](https://github.com/agshinrajabov/rawuser-oss) uses this vector
to pick the version of a page a visitor sees. The signals alone are in
[`@rawuser/signals`](../signals).

MIT.
