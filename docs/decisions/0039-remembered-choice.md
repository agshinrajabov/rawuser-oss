# ADR 0039 · A returning visitor is remembered by its own browser

Status: accepted, 2026-11-04; widened 2026-11-05. Off by default in the
open distribution (ADR 0040). The legal position is contested; see
Consequences before you turn it on.

Amends the rule in docs/privacy-rules.md that the visit marker is the only
key the snippet keeps in the browser. The "never" list still binds.

## Context

The visitor's own choice (ADR 0038) kept the answer in the tab only, so a
visitor who came back the next day saw the original page and was asked
again. The same held for a visitor who first came from a tagged link or an
AI assistant and later typed the address: the reason for the first visit
was gone, and the page was shown as built.

## Decision

1. **A code in the browser.** On a visitor's first page the customer's
   script draws a code: 32 random hex characters, never derived from the
   device. It keeps the code in `localStorage` (`__rw_pick`) with the time
   of that first page and the last reason the visitor gave. A reason is a
   tapped answer's slot, or the intent and source words of a visit that
   came with a signal. It is never `direct`, a host, a link or a tag.
2. **What comes back.** A new visit with no link of its own starts from
   the remembered reason, so the visitor sees the version that fits why
   they first came, with no question and no flash. A new link always wins.
3. **How long.** 13 months from the first page, never extended by a later
   visit. After that the browser forgets the code and draws a new one.
4. **What the server gets.** One row per visit, `first` or `returned`, with
   the code and the visit marker, so new and returning visitors can be
   counted. The code is stored only on those rows. It lives in one site's
   browser storage, so two customers never see the same code, and the
   database never joins codes across customers. It is never sent to a
   model, an alert or another service, and never used to find who the
   visitor is. The dashboard shows counts of codes, never a code.
5. **Its own switch.** "Remember returning visitors", per customer. An
   install decides the default for a new customer (`REMEMBER_DEFAULT`) and
   whether it may run on a site marked sensitive
   (`REMEMBER_ON_SENSITIVE`). Unset, both are off.
6. **The notice.** The customer's privacy notice gets its own sentence for
   this, in docs/privacy-notice.md.

## Consequences

- A returning visitor sees the version for the reason they first came, on
  every page with versions.
- **The law is not settled in our favour.** The code is an online
  identifier in the GDPR's terms (Recital 30), and writing it to the
  device is storage under ePrivacy Art. 5(3) whatever it is called. One
  reading treats it as audience measurement and personalisation that a
  site may run without consent; the stricter reading, and the safer one
  in the EU and the UK, is that it needs the visitor's consent first. We
  do not claim an exemption. If your visitors are in the EU or the UK,
  run it behind your consent tool or leave it off.
- A site that says "no cookies, no tracking" must say it with this in
  mind once the switch is on: a random code is kept on the device for 13
  months, and the notice sentence says so plainly.
- What did not change, because it is the law or the hard lines and not a
  limit on the code: no fingerprinting, no identity across sites, no join
  across customers, no inference about who the visitor is.
