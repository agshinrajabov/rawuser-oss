# ADR 0005 · Edge-side V1 intent classification, verified-UA source of truth

## Status: accepted

## Context

V1 architecture (docs/specs/architecture.md) says "snippet extracts signals,
edge classifies." That's the right long-term split, but the snippet doesn't
exist in V1, the "Snippet (client)" the backlog section is later in the build
sequence.

The intent engine still needs to ship: the foundation's `/select` route
returns a variant by `profile_key`, but nothing computes `profile_key` from
a real request yet. That gap blocks every pilot.

There are also two open questions for AI-source detection: (1) what counts
as a verified AI source, and (2) where in the codebase does the table live so
it doesn't drift?

## Decision

**Run the V1 intent engine entirely server-side at the edge worker.** The
edge worker reads everything it needs from the HTTP request itself: URL
query (UTM), `Referer` header (referrer host), `User-Agent` (device class,
AI bot/citation-fetch detection), `Accept-Language` (language), and
`request.cf.country` (country-only geo). No client round-trip, no extra
latency, no flicker. Cache header is `private, no-store` so per-visitor
selection is never cached by CDN/proxies.

When the snippet ships, it can pass `navigator.language` as a `?lang=`
query parameter that the edge prefers over Accept-Language, but the
classifier itself stays edge-side and stays the source of truth.

**The verified-UA + AI-tool-host tables live in `packages/shared/src/signals/tables.ts`.**
One file, three exported arrays (`AI_BOT_UAS`, `AI_USER_UAS`,
`AI_REFERRER_HOSTS`), each entry mapping a substring or host to the
`AiSource` enum already in `packages/shared/src/types.ts`. Substring match
against lowercased UA. Suffix match on host so `www.g2.com` matches `g2.com`.

The V1 tables (added 2026-05-22):

- **Bot UAs** (`isBot: true`, serve canonical for cloaking-safety):
  `gptbot`, `oai-searchbot`, `claudebot`, `claude-searchbot`,
  `perplexitybot`, `google-extended`.
- **User UAs** (`isBot: false`, real visitor clicking an AI citation,
  highest-intent case): `chatgpt-user`, `claude-user`, `perplexity-user`.
- **Referrer hosts** (`isBot: false`, human in normal browser): `chatgpt.com`,
  `chat.openai.com`, `claude.ai`, `perplexity.ai`, `gemini.google.com`,
  `copilot.microsoft.com`, `you.com`, `phind.com`.

Excluded for V1 and why: `Bytespider` (TikTok crawler, no user-intent
signal), `Applebot-Extended` (not an answer engine), `bing.com` /
`duckduckgo.com` / `google.com` (regular search, would swallow real search
traffic). `Bot UA` matches override `referrer host` matches.

## Consequences

- The intent engine ships without depending on a snippet that doesn't yet
  exist. Pilots can run today.
- The classifier and tables live in `@rawuser/shared` (zero runtime deps,
  `sideEffects: false`), so they're importable by both the edge worker now
  and the snippet later, no duplication.
- The edge bundle stays LLM-free; the bundle-invariant test continues to
  catch any regression that would pull a model client into the visitor
  path.
- Adding a new AI source is a one-file PR (`tables.ts` + the relevant
  fixture rows). The `AiSource` union in `types.ts` is the closed type that
  forces explicit recognition.
- The deploy script uses `wrangler deploy --env production` and a
  `[env.production.vars]` block flips `ENVIRONMENT` away from the dev
  default so the classifier debug echo never reaches real visitors. Plain
  `wrangler deploy` would deploy in development mode, that's a deliberate
  loud failure mode caught by privacy review.
- V2 carry-overs explicitly punted from V1: constant-time PREVIEW_TOKEN
  comparison (currently strict-equality, acceptable while the token is a
  well-known default), RFC-9421 AI-source signature verification (also in
  the V2 the backlog section), Bayesian fusion of behavior signals into the
  classification posterior.
