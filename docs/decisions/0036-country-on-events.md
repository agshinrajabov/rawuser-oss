# ADR 0036 · The visitor's country on every event, kept

Status: accepted, 2026-11-02. The founder's decision: count countries from
the first visit, take a lighter line on privacy here, and delete nothing.
Amends: docs/specs/country-counts.md and the privacy review's ruling
docs/specs/rulings/2026-11-02-country-and-direct.md, ruling 1, where they
differ. Under ADR 0033 the bar is the law and the audit; this ADR records
the founder's choice above the privacy review's stricter conditions.
Amended by: ADR 0037 (the visit marker is kept with the event row, so
point 5's "NULLed at 31 days" no longer holds) and ADR 0038 (a market
version reads the country of the request as it arrives; the stored country
is still never used to choose a version).

## Context

A prospect (an M&A services firm) asked on a sales call which countries
visit, which version each country saw and which country clicked. A pilot
asked the same on 2026-10-22. Rawuser reads `cf.country` on every request
and stores it nowhere. The privacy review ruled a conditional pass with a
5-visit display floor, a 31-day NULL and 90-day rollups. The founder chose
a lighter line: Rawuser exists to help customers sell, and a customer
deciding where to spend needs the country from the first visit and over
the long run.

## Decision

1. `events.country` holds the two-letter ISO 3166 code from `cf.country`,
   or `other` for anything that is not a real country code (`XX`, `T1`).
   Never a region, city, postal code, coordinates or anything else derived
   from the IP.
2. Written at `/event` on every row the edge stores (exposures, skips,
   holdout, no-signal views, conversions), for every customer, from the
   first visit.
3. Kept as long as the event row. It is not NULLed at 31 days.
4. Shown from the first visit: no display floor. Visits, sessions and
   counted clicks by country, by country and version, by country and
   source, by country and page.
5. Unchanged: the visit marker is still NULLed at 31 days
   (docs/privacy-rules.md); a sensitive customer's page is still stored
   as its group; country is never used to choose a version, never joined
   across customers, never sent to a model, never in an alert.
6. Off switch: `customers.country_off` stops the writes and NULLs that
   customer's column.

## Notice sentence (docs/privacy-notice.md, trust pack)

"The service records the country of each visit (from the network
connection, never the region or city) with every page view and counted
click, so the site owner can see which versions work in which countries.
It is kept with those records."

## Rule line for docs/privacy-rules.md

"`events.country` holds only an ISO country code from `cf.country` or
`other`, never a region or city; it is kept with the event row, never used
for selection, never joined across customers, never sent to a model or an
alert (ADR 0036)."

## Consequences

- On a small site a country with one visit and one click can point the
  customer to the person who wrote to them. This is the same disclosure
  Google Analytics makes by default; the customer is the controller.
- The trust pack's retention page changes: country lives with the event
  row until raw event retention is decided.
