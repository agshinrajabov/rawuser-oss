# ADR 0038 · Visitors with no signal get their own answers

Status: accepted, 2026-11-03. The founder's decision, after a research
round on visits that arrive with no source.
Amends: the privacy review's ruling docs/specs/rulings/2026-11-02-country-and-direct.md,
ruling 2, where it differs. Under ADR 0033 the founder decides above the
privacy review's conditions; the "never" list of docs/privacy-rules.md still binds.
Amended by: ADR 0039 (a returning visitor may be remembered by its own
browser, so "no memory across visits" under Unchanged holds only while
that switch is off).

## Context

About half of live customers' visits arrive with no source, no tags and no
telling entry path, and see the page as built. A prospect asked why he should buy if most
of his traffic is direct. The research ranked what can be done lawfully.

## Decision

Build five things, each with its own section in docs/specs/direct-visitors.md:

1. **What direct is made of.** Visitors shows the no-signal visits split by
   landing page, country, device class (mobile, tablet, desktop, from the
   user agent at the edge, stored as one word on the event) and whether the
   visit came from an app's web view.
2. **The visitor's own choice.** An optional chip in the hero ("What brings
   you here?") with 2 to 4 options written from the customer's brief; the
   choice picks the version for the rest of the tab, stored as one word in
   sessionStorage, never a person.
3. **A learned best default.** For no-signal visits, the version that does
   best is learned from aggregate click counts (Thompson sampling, offline,
   in the generation cron), with a starting prior pooled across customers
   (counts only). The arm is drawn at `/select` per visit and held in the
   tab's carry; the visit marker is never used to choose.
4. **Page one chooses page two.** What a visitor opens or clicks on the
   first page is reduced in the browser to one intent word, kept in the
   tab's carry, and offered to the edge on the next page. No clicks,
   timings or positions are stored or sent.
5. **Country and language versions.** For no-signal visits, a version
   written for the visitor's market (country or language), for the
   customer's biggest markets only. The wording addresses the market, never
   nationality, and never changes price, offer or eligibility.

Every part has a per-customer off switch and a notice sentence. No part is
given a separate privacy review (the founder's call).

## Unchanged

No fingerprinting, no cross-site identity, no identification cookies, no
memory across visits, no reverse IP. The visit marker is never used for
selection.
