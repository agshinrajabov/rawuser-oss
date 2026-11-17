# Signals

A signal is something a visit discloses about why it came. Rawuser reads
the ones below and nothing else. None of them says who the visitor is.

For each: where it comes from, what it is used for, and what is kept.
The last section says what the law looks at. It is not legal advice.

## Read from the visit

The script reads these in the page and sends them with its one request to
your edge worker. The worker reads the rest from the request itself.

| Signal | Where it comes from | Used for | Kept |
|---|---|---|---|
| Campaign tags | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` on the page's address | the source and, from the campaign's name, sometimes the intent | one bit: the link carried tags of the site's own. Never the tags |
| Ad keyword | `utm_term` | may choose the intent, in memory | nothing. Not sent at all unless the site has its own keyword list |
| Referring site | `document.referrer`, cut to scheme and host in the page | the source: search, social, community, an AI assistant | a platform's name from a fixed list, or nothing. Never the host |
| No referrer and no tags | the absence of both, on a first page that is not a reload | an estimate of how much "direct" traffic came from apps and messages | one bit, on a visit with no signal |
| The site's own pages | a referrer from the same site | told apart from an arrival | nothing; it is sent as one bit, not as a referrer |
| Android app | a referrer of the form `android-app://package` | the source, for a known app | as for the referring site |
| Click id | the name of a parameter such as `gclid` or `fbclid` | says the click was paid, and on which platform | nothing. The value never leaves the page |
| In-app browser | a mark in the user agent, or the WebView brand in `Sec-CH-UA` | the source: opened inside a social, messaging or search app | one bit: opened inside an app |
| AI assistant | its own tag (`utm_source=chatgpt.com`), its host as referrer, or its app's mark | the source `ai` | the platform's name |
| Crawlers and AI fetchers | the user agent | they get the page as built, and are not counted as visits | nothing |
| Browser language | `navigator.language` | a market version; whether the page's language matches the versions | one bit when the languages differ |
| Page language | the page's own `lang` | versions are shown only on a page in their language | nothing |
| Kind of device | the user agent and client hints, at the edge | shown to the site owner in totals | one word: mobile, tablet, desktop, other |
| Country | the connection's country, as Cloudflare gives it; on your own server, a header your proxy sets, else not known | totals by country; a market version at the moment of the request | the ISO code, or `other` |
| Page path | `location.pathname`, without query or fragment | the intent, when the page is one the site's own menu names (pricing, a comparison, a feature) | the path, masked: every id-shaped part becomes `:id` |
| Kind of navigation | the Performance API: navigate, reload or back | reloads are left out of one estimate | nothing |

The tables behind the source signals (AI hosts, in-app marks, click id
names, named platforms) are in `packages/shared/src/signals/` and are
a package of their own, `packages/signals`. How signals become an intent
is in `packages/shared/src/classify/`, the same package's second entry
point, `@rawuser/signals/intent`. It is on npm: `npm install
@rawuser/signals`.

What is deliberately not read: the IP address (the edge worker stores
none and, for a page view, reads none), the connection's time zone or
network, the full referrer, any click id's value, the screen, fonts,
canvas, plugins, and any cookie.

## Kept in the browser

| What | Storage | Life | Leaves the browser? |
|---|---|---|---|
| Visit marker: 32 random hex characters | `sessionStorage`, key `__rw_visit` | thirty idle minutes; gone with the tab | yes, with each request of the visit, to count it once and split a test |
| Carry: one intent word, one source word, a time | `sessionStorage`, key `__rw_carry` | the same | the two words, on pages with no signal of their own |
| Adapted text of up to eight of the site's own pages | `sessionStorage`, key `__rw_body` | the same | no |
| Asked mark: the question was shown in this tab | `sessionStorage`, key `__rw_q` | until the tab closes | no |
| Returning visitor: a random code, the first page's time, the last reason. Only when the switch is on | `localStorage`, key `__rw_pick` | 13 months from the first page, never extended | the code and the reason, with a visit's first row and with a tapped answer |

These five keys are all there is. A test builds the scripts and fails if
they touch a cookie, another storage or anything a fingerprint is made of
(`packages/snippet/test/hard-lines.test.ts`).

## Told by the visitor

When the site owner turns the question on, a bar at the foot of the home
page asks one thing, such as what brought the visitor there, with two or
three answers the site owner wrote or approved. A tap chooses a version
for the rest of the visit. It is shown only to a visit that came with no
signal. Nothing can be typed into it.

## Learned from totals

Two features use counts and no single visit:

- **The learned default.** For visits with no signal, the odds of showing
  each existing version come from totals of page views and counted clicks
  per page and version, with no visit marker in them.
- **Unknown sources.** With `SOURCE_LEARNING` or `UA_TOKEN_LEARNING` on,
  the edge counts how often an unknown source value or app mark was seen,
  as totals, for a person to review. Both are off in a fresh install.

## What the law looks at

Three questions, for each signal.

**1. Is something stored on, or read from, the visitor's device?**
The ePrivacy Directive's Art. 5(3), and PECR regulation 6 in the UK, ask
for consent before either, unless it is strictly necessary for a service
the visitor asked for.

- Everything under "Kept in the browser" is storage on the device. We
  claim no exemption for any of it. [self-hosting.md](self-hosting.md)
  gives both readings and what to do in the EU and the UK.
- The signals under "Read from the visit" are not stored on the device.
  The script does read the page's address, the referrer and the browser's
  language, and the EU's data protection board has read "access" broadly
  in its guidelines on Art. 5(3). Whether reading values the browser
  already sends with a request counts is argued. We do not claim it is
  settled either way.
- What the edge worker reads from the request it receives (the country,
  the user agent, the headers) is not read from the device by the
  script.

**2. Is it personal data, and on what basis is it processed?**
The visit marker and the returning visitor's code are online identifiers
and so personal data under the GDPR, though neither is linked to a name,
an account or a device. The rest (a source word, a country, a masked
path) is stored beside the marker, so treat the whole event row as
personal data. Rawuser's own records rest it on legitimate interests,
GDPR Art. 6(1)(f): showing a fitting version of the site's own page and
measuring whether it worked, with no profile and no decision about a
person. You are the controller; the basis is yours to choose and to
write down.

**3. Could it reveal a special category?**
Art. 9 is why several signals are narrower than they could be: a host or
app whose audience reveals a special category never gets a name, a
campaign name or keyword that points at one chooses nothing, a site
marked sensitive records product and article pages only as a group, and
no version on such a site may speak about the reader's own condition.

Under the CCPA nothing here is a sale, and nothing is shared for
advertising across sites: what an install collects stays in it.

## Adding a signal

A new signal needs, before the code: what is read and from where, what
is kept and for how long, its lawful basis, the sentence a site owner
tells its visitors, and a switch to turn it off. If it could cross one of
the five lines in [privacy-rules.md](privacy-rules.md), it is not added.
