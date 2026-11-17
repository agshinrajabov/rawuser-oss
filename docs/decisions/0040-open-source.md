# ADR 0040 · Rawuser is open source

Status: accepted, 2026-11-15.

## Context

Rawuser was built closed and sold one pilot at a time. The product worked
and few people knew it existed.

What staying closed protected was small. The technology is copyable. What
is not: the quality of the written versions, which comes from measuring and
rewriting, the data on which reason for a visit converts with which page,
which exists only where many sites run together, and privacy a customer
can pass an audit with. Public code helps the third (anyone can read what
runs on a visitor's page), leaves the second where it is, and costs the
first one snapshot.

Two questions a buyer asks go away with it: "how do I trust your script"
and "we cannot pass a vendor review". A site that runs Rawuser in its own
account signs nothing with us and chooses its own model provider.

## Decision

1. **The goal is to be known, not to earn from the repository.** Income
   comes from sites that cannot or will not run it themselves.

2. **The whole product is published.** The snippet, the edge worker, the
   generation worker, the dashboard, the shared package, the schema, the
   prompts and the copy lint. No reduced edition: a public version that
   lacks the real product earns neither trust nor attention.

3. **Licences.**
   - What runs as the service (edge, generation, dashboard, schema):
     AGPL-3.0. Someone who runs a changed Rawuser for other people
     publishes the changes.
   - What runs on, or is imported into, someone else's site (the snippet,
     the shared package, the two npm packages): MIT, so a site takes on no
     duty by embedding the tag.
   - Copyright holder: PixelHurts, LLC, doing business as Rawuser.
   - Contributions come under an agreement (CLA.md) that lets the company
     also run them inside the hosted service, next to code that is not
     published. Without it, one outside change would oblige the hosted
     service to publish everything it runs.
   - The name "Rawuser" and its logo are under neither licence. A fork
     may use the code, not the name, and a version that crosses a hard
     line of docs/privacy-rules.md must not be presented as Rawuser
     (TRADEMARK.md).

4. **Two packages people can use without Rawuser**, on npm, MIT:
   `@rawuser/signals` (where a visit came from) and `@rawuser/intent`
   (signals to an intent). A developer who only wants to know "did this
   visit come from an AI assistant" installs one and meets the project.
   Amended 2026-11-17: one package, `@rawuser/signals` 0.2.0, with the
   intent as its second entry point (`@rawuser/signals/intent`); the
   two shared most of their code, and one name is one thing to explain.
   `@rawuser/intent` 0.1.0 is deprecated and points there.

5. **Self-hosting means wherever you want to run it** (amended
   2026-11-16). Two ways, one code: your own Cloudflare account, where
   one command makes the storage, the two workers and the dashboard; or
   any machine that runs Node, where one process runs the same two
   workers over SQLite files. The first wording said "no Docker or
   Postgres port: a second product to maintain". Measured, the workers
   reach Cloudflare through four small interfaces, so the second way is
   an adapter and not a second product. Nobody should be held to one
   host.

6. **Bring your own model.** The open distribution names no provider. The
   installer asks for one of two routes: any OpenAI-compatible endpoint
   (an address, a key and a model id), or Workers AI in your own account.

7. **Self-host defaults.** "Remember returning visitors" (ADR 0039) is off
   until the operator turns it on. The visitor question is off by default
   as everywhere. Every other default is the hosted one.

8. **A self-hosted install sends us nothing.** No telemetry, no licence
   check, no call to any host of ours from the snippet, the workers or the
   dashboard. A test reads the source for it.

9. **What exists in the hosted service only.** Learning across customers
   from aggregate, noised counts; running it (setup, updates, monitoring,
   support); the free traffic audit as a service.

10. **Decision records and research are published with the code.** A
    written reason for every privacy decision is rare, and it is part of
    what we want to be known for. Customer names and sales detail are
    taken out; the reasoning stays as it was written, including the
    places where a stricter privacy review was overruled.

## Consequences

- The code is read by strangers. Whatever is unclear, unsafe or
  contradicts our public words will be found and written about.
- The people this product was first built for can run it themselves at
  close to no cost. Paid demand shifts toward sites that want it run for
  them. This is the price of point 1 and is accepted.
- Support arrives with users. We answer bugs and security reports; we do
  not promise free help with an install.
- A competitor can copy the prompts and the lint as they stand that day.
  What a copy does not carry: the data from many sites, the continued
  measuring, and the trust earned by being readable.
- Where the hosted service and the open defaults differ (point 7), the
  difference is visible to anyone who reads both.
