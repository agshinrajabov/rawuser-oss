/**
 * Audit rows never enter cross-customer learning (docs/specs/ai-traffic-audit.md
 * §3.4; privacy review condition 5). An audit customer has not signed the pilot
 * data terms' learning clause, so:
 *
 * - the edge's learning counters (UA_TOKEN_LEARNING, SOURCE_LEARNING) skip
 *   bundle `a: 1` (the edge's half);
 * - any cross-customer job over events (none runs today; V3's network
 *   learning, an outcome statistic across sites) filters its rows through
 *   LEARNING_EVENTS_WHERE: never an audit's or a test's rows, and for an
 *   audit that became a pilot only the rows from its signed pilot terms on.
 *
 * A sensitive customer's rows never enter either (docs/specs/
 * sensitive-customers.md, rule 3; `customers.sensitive`, migration 0042):
 * the edge's counters skip bundle `s: 1`, and the filter below leaves the
 * customer out whatever its plan and terms.
 *
 * Use as `... FROM events e WHERE ${LEARNING_EVENTS_WHERE} AND ...`, the
 * events table aliased `e`.
 */
export const LEARNING_EVENTS_WHERE = `e.customer_id IN (
    SELECT c.id FROM customers c
    WHERE c.plan NOT IN ('audit', 'test')
      AND c.sensitive = 0
      AND (c.audit_terms_at IS NULL OR c.pilot_terms_at IS NOT NULL)
  )
  AND e.ts >= COALESCE(
    (SELECT c2.pilot_terms_at FROM customers c2
      WHERE c2.id = e.customer_id AND c2.audit_terms_at IS NOT NULL),
    0
  )`;
