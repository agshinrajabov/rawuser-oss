# Privacy rules

Rawuser changes a page's words by why a visit came, never by who the
visitor is. These are the rules the code is written under. The first five
never move. The rest hold today and may change only by a decision record
that carries a privacy review, the sentence a site owner tells its
visitors, how long the data is kept and a switch to turn it off.

The bar is the law and an audit, not zero data
([decision 0033](decisions/0033-compliance-first-privacy.md)): a data flow
ships when it is lawful under GDPR, ePrivacy, UK GDPR and PECR, and CCPA,
would pass a SOC 2 vendor review, and a site owner can disclose it in one
sentence.

## The lines that never move

No decision record, setting or customer request loosens these.

1. **No fingerprinting.** Device and browser attributes are never combined
   to recognise a visitor, in one visit or across visits.
2. **No cross-site identity.** No third-party cookie, no identifier shared
   between sites, nothing that follows a visitor from one site to another.
3. **One visitor is never linked across customers.** Not by IP address,
   user agent, timing or any device attribute. Counting across customers
   is allowed only as anonymous totals.
4. **No special-category inference.** Nothing is guessed about a visitor's
   health, religion, politics, sexuality, ethnicity or union membership
   (GDPR Art. 9), and no visitor type decides prices, eligibility, job ads
   or admissions.
5. **Data about a single visitor is never sold or shared.**

### Where the code holds them

Each line is pinned by tests in this repository. If one of these tests is
removed or renamed, the test that reads this table fails.

| Line | Test file | Test |
|---|---|---|
| 1 | `packages/snippet/test/hard-lines.test.ts` | "nothing a fingerprint is made of is read" |
| 1 | `packages/snippet/test/hard-lines.test.ts` | "the only thing read from the browser's settings is its language" |
| 1 | `packages/snippet/test/bundle-size.test.ts` | "the visitor bundle never measures fonts (phase 4, privacy review condition 2)" |
| 1 | `packages/edge/test/holdout.test.ts` | "no user agent, no clock (privacy review condition 5)" |
| 2 | `packages/snippet/test/hard-lines.test.ts` | "no cookie is set or read" |
| 2 | `packages/snippet/test/hard-lines.test.ts` | "no host is named: the script talks to the edge it was loaded from, and to nothing else" |
| 2 | `packages/edge/test/hard-lines.test.ts` | "no cookie is set and none is read" |
| 3 | `packages/edge/test/hard-lines.test.ts` | "the connecting address is read in one place, the lead form's hourly limit, and for no page view" |
| 3 | `packages/edge/test/hard-lines.test.ts` | "the user agent is read in two files, each time straight into a function that keeps a word or a count" |
| 3 | `packages/generation/test/direct-choice.test.ts` | "counts codes, never across customers: new, back, what came back, who clicked on a later visit" |
| 3 | `packages/generation/test/admin/handlers.test.ts` | "cross-customer scope enforcement (customer role): parametric" |
| 3 | `packages/generation/test/direct-markets.test.ts` | "counts only the customer's own visits, by country, never across customers" |
| 4 | `packages/shared/test/special-category-terms.test.ts` | "special-category screen: every category in every language" |
| 4 | `packages/shared/test/ads-platforms.test.ts` | "a campaign name the special-category screen refuses chooses nothing" |
| 4 | `packages/signals/test/intent.test.ts` | "a campaign name that points at a special category chooses nothing" |
| 5 | `packages/edge/test/bundle.test.ts` | "contains no model call and nothing of the model layer" |
| 5 | `packages/generation/test/cron/visitors.test.ts` | "no alert and no model call is in a file that names the country" |
| 5 | `packages/generation/test/install-unset.test.ts` | "no sender, reply address, privacy address, support address or operator" |

Two things here no test can fully hold. The second half of line 4: no
code path sets a price, an offer or who may buy, and that is held by
review, not by a test. And line 5. The tests show that no code
path sends a visitor's row to a model, an alert or another service, and
that a fresh install names nobody to send anything to. What a person does
with their own database is beyond a test: it is held by the licence of the
name (below) and by the law.

## The rules that hold today

**On the visitor's device**

- No cookie is set. What the script keeps is in the browser's tab storage
  and, for one optional feature, its local storage.
- The visit marker is the only session key: 32 random hex characters drawn
  in the browser, never derived from the device, kept in `sessionStorage`
  for thirty idle minutes, gone when the tab closes, never shared between
  tabs or sites. The edge checks its shape. It is used to count a visit
  once, to split a test's two groups and to credit a visit's counted
  clicks to the version it saw, inside one customer, and for nothing else:
  never to choose a version, classify a visit or write copy. It is stored
  with the event row, never joined across customers, never joined to
  anything a visitor typed, and never sent with a fault report.
- The carry: for thirty minutes the tab keeps one intent word and one
  source word, so the next page of the same visit shows the same kind of
  version. With it the tab may keep the adapted text of the site's own
  confirmed pages, so the next page is written without a wait. That text
  is the same for everyone who arrives the same way, lives no longer than
  the carry, is never sent anywhere, and is off when the site owner turns
  the carry off.
- Remembering a returning visitor
  ([decision 0039](decisions/0039-remembered-choice.md)) is a switch per
  customer. When it is on, `localStorage` key `__rw_pick` holds a random
  code (32 hex characters drawn in the browser on the first page, never
  derived from the device), the time of that first page and the last
  reason for a visit: the option the visitor tapped, or the intent and
  source words of a visit that came with a reason. Never `direct`, a host,
  a link or a tag. It is kept 13 months from the first page and never
  extended. The code is sent only with a visit's first row and with a
  tapped answer, stays inside its one customer, is never sent to a model, an alert or another service, and is
  never used to find out who the visitor is. The dashboard shows counts of
  codes, never a code. In this distribution the switch is off for a new
  customer, and it does not run on a site marked sensitive, unless the
  person running the install sets otherwise.

**What is read about a visit**

- Campaign tags, the referring site's host (the path and query are cut
  off), the name of an Android app that opened the link, the name of a
  click id parameter and never its value, an in-app browser's mark in the
  user agent, the browser's language, the kind of device, the country, and
  the path of the page opened. The full list, with what each is used for
  and what is kept, is in [signals.md](signals.md).
- Recognising an AI assistant, a crawler or a signed agent (user agent,
  referrer, a tag the assistant adds itself, an RFC 9421 signature) is
  allowed: it names the source, not the person.
- Location is the country only, as the host gives it for the connection:
  Cloudflare, or on your own server a header your proxy sets. No region, city or coordinates are read, and nothing is
  worked out from the IP address: not the time zone, not the network.
- An ad's keyword (`utm_term`) is read in memory to choose an intent and
  is never stored, logged, counted, carried or sent to a model. It is
  dropped at the edge when the customer has no keyword list of its own,
  and it is never read for a site marked sensitive or one that has not
  said it is outside the special categories.
- A named source is a general platform from a fixed list. A host or app
  whose audience reveals a special category never gets a name.

**What is stored**

- An event row holds the kind of event, the time, the version shown and
  its text's id, the intent and source words, the page's path, the visit
  marker, the test group, a counted button's fixed label, and fixed
  flags: the visit was carried from an earlier page, it came with no
  referrer and no tags, the page's language differs from the versions',
  the page had painted before the script ran. Where the features are on
  it also holds the platform's name from the fixed list, one bit saying
  the link carried campaign tags (never the tags), the country, the kind
  of device, one bit saying the page opened inside an app, and for a
  returning visitor the code, the slot of a tapped answer or the reason
  given back. No IP address, no user agent, no referrer, nothing a
  visitor typed.
- For a free audit of a site, the row also holds how the platform was
  recognised: one word from a fixed list (a tag, a click parameter's
  name, a link from another site, an app), never a value, a host or a
  user agent. An audit's report holds counts and the site's own copy,
  never a row or a marker.
- A page path is stored only after masking: no query, no fragment, and
  every part shaped like a record id, a token or an email address
  replaced with `:id`. No row, total or cache key holds a visitor's raw
  path.
- The country on an event is an ISO code or `other`. It is never used to
  choose a version from stored data, never joined across customers and
  never sent to a model or an alert
  ([decision 0036](decisions/0036-country-on-events.md)).
- A fault report from the script holds a fixed code and one coarse number
  about the page, and never the visit marker. Its layout-shift reading
  runs only on a load where the script hid or wrote something, reads only
  the shift's size, sums it in the browser and stops when the swap is
  over. No width, viewport, pixel ratio, font or height is ever sent.
- Measuring fonts or drawing to a canvas happens only when the site's
  owner opens the page with a setup link, never for a visitor, and those
  values never reach a visitor's browser or an event: the edge takes them
  out of everything it sends to a browser.
- Event rows are kept until the customer is deleted or a retention period
  is set ([decision 0037](decisions/0037-event-data-kept.md);
  [self-hosting.md](self-hosting.md) says how to set one).

**Across customers**

- Learning across customers uses totals only, with noise added, and never
  a row, a page or a customer's name.
- A customer's site map (its own page paths, their kind, its link text),
  its keyword list and its copy never leave that customer's scope. Across
  customers only counts by kind are allowed. None of them reaches a
  browser, an event, a log or an alert.

**When in doubt**

- If it might be personal data, it is treated as personal data and not
  collected.
- A new signal needs its lawful basis and its notice sentence written
  down before the code.

## Forks and pull requests

A pull request that crosses one of the five lines is closed, whatever
else it does.

The licence lets anyone change this code, and a changed copy can remove
these rules. The name is what it cannot take along: a version that
identifies visitors, follows them across sites or guesses a special
category about them may not be called Rawuser
([TRADEMARK.md](../TRADEMARK.md)).

That protects the name, not a visitor. Whoever runs an install decides
what it does and answers for it under the law. If you are a visitor of a
site that says it runs Rawuser and you see something these rules forbid,
write to the address in [SECURITY.md](../SECURITY.md).
