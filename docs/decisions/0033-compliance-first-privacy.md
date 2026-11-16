# ADR 0033: Compliance-first privacy, not privacy-zero

Date: 2026-10-03
Status: ACCEPTED. The founder's decision: the product does not have to be privacy-zero; it has to meet the rules that bind it, GDPR, SOC2 and the like. Amends ADR 0002.

## Context

ADR 0002 made "privacy-zero" the product: only ambient signals, never who a
visitor is, and every signal that needed consent was the wrong feature.

The first real prospect, a developer tool, said the reason
people come barely differs by source; what would help is the visitor's type
(ML engineer, researcher, student). Two research rounds on 2026-10-03
(docs/research/visitor-type-and-network-learning-2026.md,
docs/research/journey-origin-2026.md) found lawful middle ground that
privacy-zero rules out or makes hard: a coarse network class at the edge, a
self-declared role kept for the tab, a cross-site category relay between
Rawuser sites, and anonymous cross-customer learning.

The founder's vision: Rawuser exists to help companies sell more. Privacy is
a requirement set by law and by customers' audits, not the product itself.

## Decision

1. **The bar is the law and the audit, not zero.** A data flow is allowed
   when it has a lawful basis and passes GDPR, ePrivacy (Art. 5(3)), UK
   GDPR/PECR, CCPA/CPRA and a SOC2 vendor review, and a customer can
   disclose it in a sentence of their privacy notice.
2. **Hard lines that stay regardless of lawfulness:**
   - no fingerprinting;
   - no cross-site identity and no third-party cookies;
   - never link one visitor's activity across customers (by IP, user
     agent, timing or any device attribute). Learning across customers
     from anonymous aggregates is allowed and wanted (the "aggregate
     first, then learn" route in
     docs/research/visitor-type-and-network-learning-2026.md §2.3);
   - no inference of special-category data (health, religion, politics,
     sexual orientation, union membership, ethnicity): GDPR Art. 9 forbids
     it without explicit consent, and an inference counts even when wrong
     (CJEU C-252/21); and no type that drives prices, eligibility, job ads
     or admissions (GDPR Art. 22, anti-discrimination law);
   - never sell or share visitor-level data;
   - no LLM call on the visitor path (performance rule, unchanged).
3. **Identifying a person is not a goal.** A feature that identifies a
   person or needs consent may exist only behind the customer's own consent
   tool and only with its own ADR.
4. **How a rule gets loosened.** The current rules in
   docs/privacy-rules.md and the forbidden fields in ADR 0006 and
   `docs/specs/architecture.md` stay binding until a feature ADR changes
   them. Each such ADR carries the privacy review's ruling (GDPR, ePrivacy
   under both the CNIL and the strict German reading, CCPA, SOC2), the
   customer notice sentence, retention, and an off switch per customer.
5. **The privacy review keeps the veto on the law and the hard lines**, not on the
   old privacy-zero wording.

## Consequences

- Unblocked for proposal, each with its own ADR or spec and ruling: the
  network class from `cf.asn` (amends ADR 0006), a self-declared role
  stored for the tab, the journey-origin relay
  (docs/specs/journey-origin-relay.md), anonymous cross-customer aggregates
  under a contract clause, randomized arms using the visit marker.
- Positioning changes from "privacy-zero" to compliance-grade privacy: no
  cookies for identification, no fingerprinting, GDPR and SOC2 ready. The
  marketing site, seeds and sales docs still say "privacy-zero"; that stays
  literally true until the first loosening ships, and must be reworded in
  the same change that ships it.
- The project's own statement of what sets it apart changes its third item accordingly.
- Risk: the line between "lawful" and "creepy" is not the law. A feature
  that is lawful but would embarrass a customer in front of its users still
  gets a second look from the founder.
