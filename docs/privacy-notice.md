# Text for your privacy notice

You run Rawuser on your site, so you are the one who tells your visitors
what it does. This page gives you the words. The dashboard shows the same
paragraph beside Go live and the same sentence beside each switch; a test
holds this page and those screens equal, word for word.

This is not legal advice. Read [self-hosting.md](self-hosting.md) for what
the law asks of you, above all in the EU and the UK.

## The paragraph

Paste this into your privacy notice. Where it says "the operator" or "the
site owner", that is you; use your own name if you prefer.

> This site adapts some of its headings and buttons to the reason a visit
> appears to have (for example a campaign link, the site a visitor came
> from, the page opened, or an AI assistant that cited us). No cookies are
> set for this, no visitor is identified, and nothing about a visitor is
> stored across visits unless this notice says the site remembers
> returning visitors. To keep a chosen version consistent while you move
> between pages, and to show it without delay, the browser tab keeps two
> short labels and a copy of the adapted headings and texts of the pages
> you opened, for up to thirty minutes; they are cleared when the tab
> closes. This copy is the same text everyone arriving the same way sees
> and holds nothing that identifies you. To count each visit once and to
> fairly split which visitors see a version being tested, the browser tab
> holds one random code with no meaning on its own, for up to thirty
> minutes; it is cleared when the tab closes and is never used to identify
> a person. When a visitor clicks one of the site's main buttons (for
> example Start trial), the script records which kind of button it was,
> the page and that random code, so the operator can count whether the
> adapted pages lead to more clicks. A button the site shows on every
> page, such as a menu's contact or phone link, is counted on whichever
> page it is clicked. While a test runs, some visits, picked at random by
> that code and by nothing about the visitor, see the original page
> instead, so the difference can be measured. When the adaptation does not
> work properly on a page (for example the page could not reach the
> service, or a heading wrapped differently), the script reports a fixed
> code and a rounded number about the page, with no visit code and nothing
> about you, so the operator can fix it. The script also records which
> known platform a visit came from (for example LinkedIn, Google or
> ChatGPT, from a fixed list, never the address of the page before) and
> whether the link carried campaign tags (yes or no, never the tags
> themselves); these are kept with the page-view records for the life of
> the operator's account. The service records the country of each visit
> (from the network connection, never the region or city) with every page
> view and counted click, so the site owner can see which versions work in
> which countries. It is kept with those records. It also records the kind
> of device (phone, tablet or computer) and whether the page opened inside
> an app, never the browser or device itself, and keeps them with the same
> records. Rawuser records which page was viewed as its path only: the
> query string and fragment are never stored, and any part of the path
> shaped like a record id, a token or an email address is replaced with
> :id before it is stored.

Two sentences in it belong to switches that are on for a new site. If you
turn the switch off, you may take the sentence out:

- "The service records the country of each visit ..." goes with
  **Visitors' country** in Settings.
- "It also records the kind of device ..." goes with **What direct is
  made of**, which records once you have answered "no" to the
  special-category question.

## A sentence for each switch

Each of these has its own switch in the dashboard. Add its sentence while
the switch is on.

Three are on for a new site once you have answered "no" to the
special-category question, and never run before that or on a site marked
sensitive: page one shapes page two, the learned default, and versions
for your top countries. Reading an ad's keyword starts under the same
condition. The question on the page and the memory of returning visitors
are off until you turn them on.

**The question on the page** (a visitor picks why they came):

> If a visitor picks an option such as their role on the page, the page
> shows wording for that choice for the rest of the visit.

**Page one shapes page two:**

> If a visit gives no reason of its own, the page it opens or the kind of
> main button clicked may choose the wording of the next page; this is
> kept in the browser tab only, as one word, and erased when it closes.

**Learn the best default:**

> When a visit gives no reason of its own, the site may show one of its
> existing versions or the original page, chosen at random with odds
> learned from how often each was clicked before; the choice is kept in
> the browser tab for the rest of the visit only.

**Versions for your top countries:**

> For visits that give no reason of their own, the site may show wording
> written for the visitor's country or language region (for example
> British spelling), read from the network connection and the browser's
> language setting at that moment; it never changes prices, offers or who
> may buy.

**Remember returning visitors:**

> To show a returning visitor the wording that fits why they first came,
> the browser keeps a random code and the reason of an earlier visit (the
> kind of site that sent it, such as an AI assistant, or the option they
> picked) for 13 months from the first visit, and our service receives the
> code once per visit to count new and returning visitors. The code is not
> linked to a name, an account, the device or any other site. Clearing the
> site's data in the browser forgets it.

This last one keeps a code on the visitor's device for 13 months. In the
EU and the UK, turn it on only behind your consent tool
([self-hosting.md](self-hosting.md), "What the law asks of you").

**Ad keywords** (when your ad links carry `utm_term`):

> If your ad links carry the ad's keyword (utm_term), Rawuser reads it in
> memory to choose which version of the page to show and does not store
> it; only the version's type is recorded. You can turn this off, and it
> is always off for sites marked sensitive.

## If your site is about health or another special category

Religion, sexuality, politics, union membership and health are special
categories. Say so when the dashboard asks; the site is then marked
sensitive and Rawuser records less. Add this, with your own subject in
place of "health products":

> Because this site is about health products, the service does not record
> which product or article page a visit opened together with the visit's
> random code: such pages are recorded as a group, and each page's views
> are kept only as a daily total.

## What stands behind each sentence

- **What is read.** Campaign tags, the referring site's host or the name
  of the Android app that opened the link, the name (never the value) of a
  platform's click parameter, whether the page opened inside an app, the
  page's language, the country, and the path of the page. No IP address is
  stored, nothing is combined into a fingerprint, and nothing follows a
  visitor to another site. The full list is in [signals.md](signals.md).
- **In the browser tab.** One `sessionStorage` entry with an intent word,
  a source word and a time, and one random visit code of 32 hex
  characters, drawn by the browser and not from the device. Both last
  thirty idle minutes and go when the tab closes. The tab may also keep
  the adapted text of up to eight of your pages (at most 64 KB), for the
  same thirty minutes; it is never sent back. Like any page content,
  other scripts on your site can read it. The carry switch turns both
  off.
- **On your install.** An event row for a page view or a counted click:
  the version shown, the two words, the masked page path, the visit code,
  and what the switches above add. Never a name, an address or anything a
  visitor typed.
- **Counted clicks.** A row holds a fixed button label, the page, the
  version and the test group, with the visit code. Removing the counted
  buttons stops it.
- **A test.** While one runs, some visits are picked at random by the
  visit code and see your original page, so the difference can be
  measured. A test size of 0 means no test.
- **The country.** The two-letter code Cloudflare gives for the
  connection, or `other`. Never a region, a city or the IP address. The
  stored value is never used to choose a version. Turning the switch off
  stops the recording within five minutes and removes what is stored.
- **The kind of device.** One word (mobile, tablet, desktop, other) and
  one yes-or-no mark, worked out at the edge from the request's own
  headers, which are not stored.
- **The platform's name.** One word from a fixed list of general
  platforms, never the address of the page before, and never a platform
  whose audience reveals a special category. The dashboard shows a name
  only from 5 visits in the period.
- **The page path.** The query and fragment are cut off and every part
  that holds an `@`, only digits, six or more digits in a row, a UUID or a
  long random-looking run is replaced with `:id` before anything is kept.
  Put the tag on your public pages, not on signed-in or admin pages.
- **A fault report.** Up to three fixed codes, an optional part name and
  one coarse number about the page, without the visit code.
- **How long.** Everything on your install is kept until you delete the
  customer or set a retention period
  ([self-hosting.md](self-hosting.md)).
- **Search engines and AI crawlers** always get the page as you built it.
