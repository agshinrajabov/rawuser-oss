# ADR 0037 · Event data is kept for the life of the account

Status: accepted, 2026-11-02. The founder's decision: the data stays past
31 days and is not deleted.
Amends: docs/specs/visit-marker.md, docs/specs/results-data.md §7,
docs/specs/snippet-issues.md, docs/specs/ai-traffic-audit.md (`found_by`),
ADR 0036 point 5, and the matching lines of docs/privacy-rules.md.

## Decision

Nothing on an event row is NULLed or deleted at 31 days any more. The visit
marker, `source_name`, `tagged`, `found_by` and `country` stay with the row,
and `snippet_issue` rows are no longer deleted after 31 days. Event data is
kept for the life of the customer's account and removed by the per-customer
delete. The daily rollups keep running for fast reads. Unchanged: an audit
customer is deleted 60 days after its report.

## Why

A customer deciding where to spend needs visits and clicks by source,
country and version over months, counted by visit, not only daily totals.

## Consequences

- The visit marker is pseudonymous data kept for as long as the account.
  GDPR's storage-limitation principle asks for a stated purpose and period;
  ours is the life of the account, for the customer's own analytics, and
  the customer can delete it at any time.
- The privacy notice, the DPA retention line and the trust pack change from
  "31 days" to "the life of the account".
- The marker still dies in the browser with the tab; nothing new is stored
  on the device.
