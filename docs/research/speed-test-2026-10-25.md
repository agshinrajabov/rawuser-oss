# Speed test of the Rawuser tag, 25 October 2026

> Our own measurement of what the tag costs a page. The hosts below are
> written as example.com names; the run was against the hosted service and
> its lab page. Run on 2026-10-25 between 10:56 and 11:17 UTC, from
> one test machine, on our own lab page only:
> https://lab.example.com/ (customer `measure-lab`). Read
> only: no `/event` request was let through, no database was read or written.
> No customer site was loaded.

> **Correction, 2026-10-25 (evening; docs/specs/faster-tag.md §2.2 and
> §2.6).** The "second view" rows below were wrong. This run blocked
> `/event` and swapped the control's HTML with Playwright's `page.route`,
> and request interception turns the browser's HTTP cache off, so every
> "second view" downloaded the tag again (its own numbers show it: a 30 to
> 45 ms tag on desktop, 237 to 246 ms on the phone profile). Measured again
> with the cache really on (`Network.setBlockedURLs` instead of `page.route`,
> the warm arm opening another page of the site first): **a second view
> adds -2 to +18 ms to LCP**, not 16 to 234. Desktop LCP 68 ms without the
> tag, 66 with the tag and no signal, 70 with a ChatGPT visit; phone profile
> 344, 348 and 362. The table and finding 5 now carry these numbers; the
> first-view rows stand (every arm took the same routed path, so the
> comparison was fair). The corrected protocol and its scripts:
> docs/research/speed-test-scripts/ (the spec's section 7). Two more rules
> from the same review: a document handed over by Playwright skips Chromium's
> network emulation (a control routed while the tagged arms are not looks
> 150 ms faster, the discarded first run below), and the default
> `HeadlessChrome` user agent gets the edge's bot answer (this run set a
> browser user agent).

## What was measured, in one table

Medians of 10 loads per arm (min to max in brackets), Chromium 153 headless.
The corrected second-view rows are medians of 10 desktop and 8 to 9 phone
loads from the spec's run 3 (docs/specs/faster-tag.md §2.2), same lab page,
same profiles.

| | Page without the tag | Tag, visit with no signal | Tag, visit tagged `utm_source=chatgpt.com` |
|---|---|---|---|
| **Desktop, first view** LCP | 262 ms (240 to 568) | 350 ms (260 to 508) | 478 ms (272 to 724) |
| Desktop, first view FCP | 262 ms | 332 ms | 260 ms |
| Desktop, first view, rewritten lines hidden for | none | 25 ms (5 to 46) | 170 ms (3 to 338) |
| **Phone profile, first view** LCP | 332 ms (304 to 432) | 654 ms (596 to 1,088) | 684 ms (572 to 1,000) |
| Phone profile, first view FCP | 332 ms | 534 ms | 510 ms |
| Phone profile, first view, hidden for | none | 182 ms (126 to 513) | 195 ms (134 to 338) |
| **Desktop, second view** (cache on) LCP, corrected | 68 ms | 66 ms | 70 ms |
| **Phone profile, second view** LCP, corrected | 344 ms | 348 ms | 362 ms |
| ~~Desktop, second view~~ as first reported, cache off by mistake | ~~84 ms (64 to 160)~~ | ~~100 ms (80 to 116)~~ | not run |
| ~~Phone profile, second view~~ as first reported, cache off by mistake | ~~216 ms (208 to 288)~~ | ~~450 ms (444 to 600)~~ | not run |
| CLS, every load | 0 | 0 | 0 |

- Tag size: **14,790 bytes** transferred with gzip (39,185 bytes unpacked),
  `/s/measure-lab.js`, etag `d47c68188660fac3`, three fetches, same size.
  `rich.js` (5,400 bytes gzip) is not listed for this page and was not loaded.
- `/select` from curl, 20 runs each: ChatGPT-tagged median **56 ms**, max
  **310 ms** (the first run; max 141 ms without it); no signal median 44 ms,
  max 130 ms. The worker's own time (Server-Timing): 3 to 5 ms, median 4.
- Longest time any rewritten line stayed hidden in the 60 tagged loads of the
  final run: **513 ms**. The 1,500 ms cap never fired.
- CLS was 0 in all 100 loads of the final run (and in the 60 of the
  discarded first run).

## Method

**Machine.** One test machine: Apple M4 Pro, macOS 26.5.1, wired network.
Its location is not part of the result and is not recorded here. Numbers from
one machine say nothing about every visitor; they show what the tag adds on
this page under these conditions.

**The page.** The lab page is a 2,004-byte static HTML page (a made-up
product, "Tallybook") with one stylesheet, no web fonts, no framework. The
tag is the first line in `<head>`, without `async`, as our install steps say:
`<script src="https://edge.example.com/s/measure-lab.js"></script>`. Its
confirmed parts on `/`: the hero headline, the hero paragraph, the hero
button, the features heading and paragraph. On a phone-width screen the hero
paragraph is the LCP element; at 1280 wide the headline is. Both are parts
the tag hides and rewrites.

**Tag size.** `curl --compressed -H "Accept-Encoding: gzip" -w "%{size_download}"`
on `https://edge.example.com/s/measure-lab.js`, three times;
`content-encoding: gzip`, `cache-control: public, max-age=300,
stale-while-revalidate=86400`. With `Accept-Encoding: br` the transfer was
15,232 bytes; uncompressed 39,185 bytes. `rich.js` measured the same way:
5,400 bytes. The build test in packages/snippet fails above 15,360 bytes.

**`/select`, curl.** `select-curl.sh` below: 20 requests for a ChatGPT-tagged
visit to `/` and 20 for a visit with no signal, each a new connection (DNS,
TCP, TLS included), a desktop Chrome user agent, `Origin` set to the lab.
Times are curl's `time_total`. A further 20 ChatGPT-tagged requests read the
`Server-Timing` header.

**Browser.** `speed-test.cjs` below, Playwright 1.64.1 driving Chromium
153.0.8010.12 headless (the context's user agent string says Chrome 141; the
engine is 153). Five arms:

- `control`: the lab page's HTML with the tag line removed;
- `plain`: the page as published, no signal (the edge answers "keep the
  original", so nothing is rewritten, but the parts are hidden until it does);
- `chatgpt`: the page with `?utm_source=chatgpt.com` (the edge answers with a
  version, or with the 20% holdout that keeps the original);
- `control-warm` and `plain-warm`: the same page opened twice in one context,
  the second view measured, browser cache on.

Every arm's HTML is fetched by Playwright and handed to the page by route
interception, so the document takes the same path in every arm; only the
control drops the tag line. Cold arms run with the cache disabled.
(Correction: route interception also disabled the cache in the warm arms,
so their numbers were not a second view; see the note at the top. Use
docs/research/speed-test-scripts/tag-timing.cjs, which blocks the tag in
the control with `Network.setBlockedURLs` and keeps the cache.) Each
load's context is new, so no visit marker or carry passes between loads. Two
conditions: desktop (1280 by 800, no throttling) and a phone profile (390 by
844, CPU slowed 4 times, 150 ms round trip, 1.6 Mbps down, 750 kbps up,
emulated by Chromium). The arms run interleaved, 10 rounds per condition, so
a slow minute hits every arm alike.

LCP, CLS and FCP come from `PerformanceObserver` in the page. "Hidden for"
is the time from the first animation frame where the hero headline's computed
`visibility` is `hidden` to the first frame where it is visible again, sampled
once per frame (about 17 ms resolution). Tag and `/select` durations come
from Resource Timing.

**Read only.** Requests to `edge.example.com/event` were aborted in the
browser, so no event row was written for any load. `/select` and the
`/carry` prefetch only read.

## Findings

1. **The tag's cost on a first view is mostly its own download.** The tag is
   a script in the head without `async`, so the parser stops until it has
   arrived (median 134 to 182 ms on desktop, about 342 ms on the phone
   profile, cold connection). DOMContentLoaded moved from 54 ms to 208 to
   254 ms on desktop and from 62 ms to 490 to 514 ms on the phone profile.
   On the phone profile first paint moved with it (FCP 332 ms without the
   tag, 510 to 534 ms with it); on desktop the FCP medians were 262 ms
   without and 332 and 260 ms with, so there the first paint was not always
   later.
2. **Then the rewritten lines wait for `/select`.** On desktop that wait was
   25 ms median for a visit with no signal and 170 ms for a ChatGPT visit; on
   the phone profile 182 and 195 ms. Only the confirmed parts are hidden; the
   nav, the rest of the hero and the sections below paint at once.
3. **LCP lands when the hidden line appears.** In every ChatGPT-tagged load
   LCP was recorded 3 to 34 ms after the hidden headline or paragraph became
   visible, so the hold counts in LCP whenever a rewritten part is the
   largest element.
4. **No layout shift.** `visibility: hidden` keeps the box; CLS was 0 in every
   load, with and without a rewrite.
5. **A second view costs almost nothing** (corrected 2026-10-25). With the
   tag really in the browser cache, LCP moves by -2 to +18 ms: desktop 68 ms
   without the tag, 66 and 70 with it; phone profile 344, 348 and 362. The
   tag is not fetched (five minutes fresh, a day stale), and the `/select`
   round trip overlaps the page's own revalidation of its HTML and CSS
   (Cloudflare Pages sends `max-age=0, must-revalidate`). On a site whose
   CSS is cached for good the `/select` round trip would show (about 160 ms
   on the phone profile). As first written, this finding said 84 to 100 ms
   on desktop and 216 to 450 ms on the phone profile; those loads had the
   cache off (the correction at the top).
6. **The holdout shows in the ChatGPT arm.** 3 of 10 phone-profile loads and
   1 of 10 desktop loads drew the 20% test arm and kept the original; their
   lines were hidden as long as the others'.

## Limits

- One machine, one network, one day, 10 loads per cell. Medians, not
  percentiles of real traffic; Google scores the 75th percentile of real
  visits over 28 days.
- The lab page is tiny, so the tag's share of its load time looks large. On
  a heavier page the page's own time grows and the tag's absolute cost may
  not; we did not measure a heavier page today.
- The phone profile is emulated (Chromium throttling on a fast desktop CPU),
  not a phone.
- Headless Chromium only; no WebKit or Firefox run today. An iPhone WebKit
  run on 2026-10-01 is in the backlog.
- The page is plain HTML. On a server-rendered React site the snippet also
  waits for React to hydrate, up to 2,500 ms after the version arrives
  (packages/snippet/src/index.ts, `HYDRATION_WAIT_MS`), so the hold there can
  be longer than any number here.
- The tag sat first in the head. A tag placed late (after the page painted)
  hides nothing and leaves that load as built (docs/specs/late-tag.md); not
  measured here.
- INP was not measured: no interaction was scripted.
- A first run of 60 loads (10:59 to 11:05 UTC) was discarded: its control
  document was routed through Playwright and the tagged arms were not, which
  gave the control a shorter TTFB. Its file is not kept in the repo; its CLS
  was 0 in all 60 loads.

## The scripts

### select-curl.sh

```bash
#!/bin/bash
# 20 runs of /select for a ChatGPT-tagged visit to the lab page, and 20 for a plain visit.
# Each curl opens a new connection, so every run includes DNS, TCP and TLS.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
BASE="https://edge.example.com/select?customer_id=measure-lab&lang=en-US&self_host=lab.example.com&path=%2F&nav=navigate&plang=en"
for arm in chatgpt plain; do
  if [ $arm = chatgpt ]; then URL="$BASE&utm_source=chatgpt.com"; else URL="$BASE"; fi
  for i in $(seq 1 20); do
    curl -s -o "body-$arm-$i.json" -A "$UA" -H "Origin: https://lab.example.com" \
      -w "$arm $i code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n" "$URL"
  done
done
```

Server-Timing loop (20 runs, same ChatGPT-tagged URL):

```bash
for i in $(seq 1 20); do curl -s -D - -o /dev/null -A "$UA" "$URL" | grep -i server-timing; done | sort | uniq -c
```

### speed-test.cjs (as run; do not reuse for a second view)

This is the script as it ran, kept so the numbers above can be traced. Its
`page.route` calls turn the HTTP cache off, so its `-warm` arms are not a
second view, and its control is fair only because every arm is routed.
For new runs use docs/research/speed-test-scripts/tag-timing.cjs.

```js
// Speed test of the Rawuser tag on our own lab page, 25 October 2026.
// Five arms, each in a fresh browser context:
//   control       the lab page's own HTML with the tag line removed, cold (cache disabled)
//   plain         the lab page as published, no signal (the edge answers "keep the original"), cold
//   chatgpt       the lab page as published, ?utm_source=chatgpt.com (a version is written), cold
//   control-warm  control, second view in the same context (browser cache on)
//   plain-warm    plain, second view in the same context (browser cache on)
// Every arm's HTML goes through the same route interception; only the control drops the tag.
// Two conditions: desktop (1280x800, no throttling) and phone-like (390x844,
// 4x CPU slowdown, 150 ms RTT, 1.6 Mbps down, 750 kbps up, emulated in Chromium).
// Read only: requests to the edge's /event endpoint are aborted, so no row is written.
// Usage: PW=<path to playwright> CHROME=<chromium binary> node speed-test.cjs <runs-per-arm>
const { chromium } = require(process.env.PW || "playwright");

const URL_BASE = "https://lab.example.com/";
const RUNS = Number(process.argv[2] || 10);
const TAG = '<script src="https://edge.example.com/s/measure-lab.js"></script>';

const OBSERVE = `
(() => {
  const r = (window.__speed = { lcp: 0, lcpEl: "", cls: 0, shifts: [], fcp: 0,
    hiddenFirst: null, visibleAt: null, textChangedAt: null, origText: null, hiddenFrames: 0 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { r.lcp = e.startTime; r.lcpEl = e.element ? e.element.tagName + (e.element.className ? "." + e.element.className : "") : ""; } })
    .observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { r.cls += e.value; r.shifts.push([Math.round(e.startTime), +e.value.toFixed(4)]); } } })
    .observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") r.fcp = e.startTime; })
    .observe({ type: "paint", buffered: true });
  const tick = () => {
    const h = document.querySelector("section.hero h1");
    if (h) {
      const t = performance.now();
      const vis = getComputedStyle(h).visibility;
      if (r.origText === null) r.origText = h.textContent;
      if (vis === "hidden") { r.hiddenFrames++; if (r.hiddenFirst === null) r.hiddenFirst = t; }
      else if (r.visibleAt === null) r.visibleAt = t;
      if (r.textChangedAt === null && h.textContent !== r.origText) r.textChangedAt = t;
    }
    if (performance.now() < 6000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function run(browser, arm, cond) {
  const phone = cond === "phone";
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: phone ? 3 : 1,
    userAgent: phone
      ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const warm = arm.endsWith("-warm");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: !warm });
  if (phone) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  const req = { select: null, tag: null };
  await page.route("**/event**", (r) => r.abort());
  // Every arm's HTML goes through the same interception, so the document's
  // timing is the same path for all; only the control drops the tag line.
  await page.route((u) => u.origin + u.pathname === URL_BASE, async (route) => {
    const resp = await route.fetch();
    let html = await resp.text();
    if (arm.startsWith("control")) html = html.replace(TAG, "");
    await route.fulfill({ response: resp, body: html });
  });
  let answer = null;
  page.on("response", async (resp) => {
    if (!resp.url().includes("/select")) return;
    try {
      const j = await resp.json();
      answer = { source: j.source, key: j.variant_key, cohort: j.cohort, holdout: j.holdout ?? null };
    } catch {}
  });
  await page.addInitScript(OBSERVE);
  const url = arm === "chatgpt" ? URL_BASE + "?utm_source=chatgpt.com" : URL_BASE;
  if (warm) {
    // First view fills the browser cache (the tag, the CSS); the second view is measured.
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(3000);
  }
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(5000);
  const out = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource");
    const sel = res.find((e) => e.name.includes("/select"));
    const tag = res.find((e) => e.name.includes("/s/measure-lab.js"));
    const nav = performance.getEntriesByType("navigation")[0];
    const s = window.__speed;
    return {
      lcp: Math.round(s.lcp), lcpEl: s.lcpEl, fcp: Math.round(s.fcp), cls: +s.cls.toFixed(4), shifts: s.shifts,
      hiddenFirst: s.hiddenFirst && Math.round(s.hiddenFirst), visibleAt: s.visibleAt && Math.round(s.visibleAt),
      textChangedAt: s.textChangedAt && Math.round(s.textChangedAt), hiddenFrames: s.hiddenFrames,
      h1: document.querySelector("section.hero h1")?.textContent,
      selectStart: sel && Math.round(sel.startTime), selectDur: sel && Math.round(sel.duration),
      tagDur: tag && Math.round(tag.duration), tagBytes: tag && tag.transferSize,
      dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ttfb: Math.round(nav.responseStart),
    };
  });
  await context.close();
  return { arm, cond, ...out, answer };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
  const rows = [];
  for (const cond of ["desktop", "phone"]) {
    for (let i = 0; i < RUNS; i++) {
      // Interleave the arms so a slow minute hits all three alike.
      for (const arm of ["control", "plain", "chatgpt", "control-warm", "plain-warm"]) {
        const row = await run(browser, arm, cond);
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  await browser.close();
})();
```

## Raw numbers

### curl, `/select` (seconds)

```
chatgpt 1 code=200 connect=0.007400 tls=0.025511 ttfb=0.309445 total=0.309644 bytes=3488
chatgpt 2 code=200 connect=0.008884 tls=0.025575 ttfb=0.059365 total=0.059574 bytes=3488
chatgpt 3 code=200 connect=0.008542 tls=0.022851 ttfb=0.056964 total=0.057214 bytes=3488
chatgpt 4 code=200 connect=0.010454 tls=0.028009 ttfb=0.073401 total=0.073631 bytes=3488
chatgpt 5 code=200 connect=0.008111 tls=0.020979 ttfb=0.050151 total=0.050339 bytes=3488
chatgpt 6 code=200 connect=0.012105 tls=0.024424 ttfb=0.049105 total=0.049350 bytes=3488
chatgpt 7 code=200 connect=0.008119 tls=0.020583 ttfb=0.058625 total=0.058947 bytes=3488
chatgpt 8 code=200 connect=0.010468 tls=0.112381 ttfb=0.140207 total=0.140533 bytes=3488
chatgpt 9 code=200 connect=0.010193 tls=0.023407 ttfb=0.050048 total=0.050406 bytes=3488
chatgpt 10 code=200 connect=0.008333 tls=0.023819 ttfb=0.051245 total=0.051589 bytes=3488
chatgpt 11 code=200 connect=0.009276 tls=0.018614 ttfb=0.044859 total=0.045344 bytes=3488
chatgpt 12 code=200 connect=0.012768 tls=0.037112 ttfb=0.063548 total=0.063787 bytes=3488
chatgpt 13 code=200 connect=0.008881 tls=0.021019 ttfb=0.052205 total=0.052738 bytes=3488
chatgpt 14 code=200 connect=0.081881 tls=0.093850 ttfb=0.119466 total=0.119757 bytes=3488
chatgpt 15 code=200 connect=0.007751 tls=0.022787 ttfb=0.049780 total=0.050228 bytes=3488
chatgpt 16 code=200 connect=0.007979 tls=0.019809 ttfb=0.108325 total=0.110977 bytes=3488
chatgpt 17 code=200 connect=0.008970 tls=0.023084 ttfb=0.050946 total=0.051196 bytes=3488
chatgpt 18 code=200 connect=0.008464 tls=0.022837 ttfb=0.054623 total=0.054787 bytes=3488
chatgpt 19 code=200 connect=0.008945 tls=0.017198 ttfb=0.043399 total=0.049652 bytes=3488
chatgpt 20 code=200 connect=0.094950 tls=0.104205 ttfb=0.136763 total=0.136992 bytes=3488
plain 1 code=200 connect=0.012100 tls=0.061030 ttfb=0.084687 total=0.084858 bytes=419
plain 2 code=200 connect=0.017366 tls=0.030443 ttfb=0.052228 total=0.052345 bytes=419
plain 3 code=200 connect=0.007710 tls=0.019969 ttfb=0.039886 total=0.040037 bytes=419
plain 4 code=200 connect=0.007215 tls=0.021289 ttfb=0.038676 total=0.038775 bytes=419
plain 5 code=200 connect=0.011658 tls=0.026812 ttfb=0.042623 total=0.042788 bytes=419
plain 6 code=200 connect=0.014055 tls=0.028978 ttfb=0.056303 total=0.056473 bytes=419
plain 7 code=200 connect=0.015342 tls=0.107657 ttfb=0.129630 total=0.129909 bytes=419
plain 8 code=200 connect=0.010420 tls=0.028721 ttfb=0.052777 total=0.053801 bytes=419
plain 9 code=200 connect=0.010407 tls=0.023551 ttfb=0.058814 total=0.058981 bytes=419
plain 10 code=200 connect=0.008424 tls=0.024168 ttfb=0.040208 total=0.040353 bytes=419
plain 11 code=200 connect=0.010233 tls=0.025008 ttfb=0.047293 total=0.047428 bytes=419
plain 12 code=200 connect=0.009259 tls=0.020158 ttfb=0.041650 total=0.041816 bytes=419
plain 13 code=200 connect=0.009086 tls=0.026294 ttfb=0.044818 total=0.044991 bytes=419
plain 14 code=200 connect=0.085307 tls=0.097926 ttfb=0.122370 total=0.122481 bytes=419
plain 15 code=200 connect=0.008292 tls=0.020256 ttfb=0.044663 total=0.044804 bytes=419
plain 16 code=200 connect=0.008733 tls=0.018623 ttfb=0.041961 total=0.042094 bytes=419
plain 17 code=200 connect=0.008008 tls=0.019353 ttfb=0.039593 total=0.039755 bytes=419
plain 18 code=200 connect=0.008125 tls=0.017451 ttfb=0.036204 total=0.036387 bytes=419
plain 19 code=200 connect=0.008564 tls=0.023683 ttfb=0.043520 total=0.043719 bytes=419
plain 20 code=200 connect=0.008417 tls=0.017276 ttfb=0.036567 total=0.036912 bytes=419
```

### Server-Timing

```
   5 server-timing: kv;dur=3, total;dur=3
  12 server-timing: kv;dur=4, total;dur=4
   3 server-timing: kv;dur=5, total;dur=5
```

### Browser, final run (2026-10-25 11:05:41 to 11:16:58 UTC), one row per load, ms

`hidden_from` and `visible_at` are for the hero headline; `cohort` is the `/select` answer (`no_signal`, `personalized`, or `holdout`, the 20% test arm that keeps the original).

```csv
condition,arm,ttfb,fcp,lcp,lcp_element,cls,dcl,tag_ms,select_ms,hidden_from,visible_at,text_changed_at,cohort
desktop,control,160,248,248,H1,0,171,,,,240,,
desktop,plain,58,476,508,H1,0,450,380,40,464,505,,no_signal
desktop,chatgpt,139,300,636,H1,0,280,133,346,293,631,631,personalized
desktop,control-warm,28,64,64,H1,0,31,,,,59,,
desktop,plain-warm,31,80,96,H1,0,74,38,19,75,93,,no_signal
desktop,control,44,568,568,H1,0,49,,,,546,,
desktop,plain,53,332,348,H1,0,204,141,57,318,329,,no_signal
desktop,chatgpt,89,380,400,H1,0,345,249,46,359,395,395,personalized
desktop,control-warm,37,96,96,H1,0,41,,,,92,,
desktop,plain-warm,33,84,116,H1,0,78,38,26,80,114,,no_signal
desktop,control,51,268,268,H1,0,55,,,,244,,
desktop,plain,51,448,468,H1,0,414,354,37,432,462,,no_signal
desktop,chatgpt,61,252,524,H1,0,211,143,302,232,518,518,personalized
desktop,control-warm,36,84,84,H1,0,39,,,,67,,
desktop,plain-warm,27,88,108,H1,0,71,40,17,72,103,,no_signal
desktop,control,61,264,264,H1,0,65,,,,241,,
desktop,plain,61,252,268,H1,0,176,108,33,238,250,,no_signal
desktop,chatgpt,53,248,316,H1,0,194,134,111,234,313,313,personalized
desktop,control-warm,109,160,160,H1,0,112,,,,142,,
desktop,plain-warm,22,64,80,H1,0,57,31,21,58,79,,no_signal
desktop,control,75,248,248,H1,0,79,,,,240,,
desktop,plain,51,244,260,H1,0,191,133,31,237,242,,no_signal
desktop,chatgpt,199,456,724,H1,0,426,214,279,441,719,719,personalized
desktop,control-warm,95,152,152,H1,0,99,,,,133,,
desktop,plain-warm,33,100,116,H1,0,84,45,19,85,114,,no_signal
desktop,control,49,240,240,H1,0,54,,,,228,,
desktop,plain,65,332,352,H1,0,301,223,32,316,347,,no_signal
desktop,chatgpt,61,236,272,H1,0,205,135,53,221,268,268,personalized
desktop,control-warm,26,80,80,H1,0,31,,,,62,,
desktop,plain-warm,23,76,96,H1,0,59,30,19,60,91,,no_signal
desktop,control,44,252,252,H1,0,48,,,,244,,
desktop,plain,46,252,268,H1,0,160,107,49,236,250,,no_signal
desktop,chatgpt,43,256,456,H1,0,152,102,288,239,451,451,personalized
desktop,control-warm,21,64,64,H1,0,25,,,,60,,
desktop,plain-warm,24,80,96,H1,0,60,31,18,62,94,,no_signal
desktop,control,49,264,264,H1,0,52,,,,244,,
desktop,plain,46,484,500,H1,0,441,383,36,461,481,,no_signal
desktop,chatgpt,116,544,660,H1,0,514,391,126,529,656,656,personalized
desktop,control-warm,24,72,72,H1,0,27,,,,61,,
desktop,plain-warm,22,76,92,H1,0,59,33,19,60,90,,no_signal
desktop,control,50,264,264,H1,0,54,,,,247,,
desktop,plain,118,468,504,H1,0,446,315,44,460,500,,no_signal
desktop,chatgpt,56,232,500,H1,0,197,133,283,218,496,496,personalized
desktop,control-warm,31,88,88,H1,0,35,,,,68,,
desktop,plain-warm,34,100,116,H1,0,80,41,25,81,111,,no_signal
desktop,control,59,260,260,H1,0,64,,,,206,,
desktop,plain,57,236,272,H1,0,206,142,53,220,266,,no_signal
desktop,chatgpt,48,264,280,H1,0,185,130,42,243,246,,holdout
desktop,control-warm,28,84,84,H1,0,33,,,,69,,
desktop,plain-warm,32,88,104,H1,0,73,37,18,75,102,,no_signal
phone,control,45,320,320,P.lead,0,61,,,,250,,
phone,plain,183,580,1088,P.lead,0,521,312,557,569,1082,,no_signal
phone,chatgpt,292,728,1000,P.lead,0,709,338,327,657,995,995,personalized
phone,control-warm,55,248,248,P.lead,0,69,,,,228,,
phone,plain-warm,23,296,448,P.lead,0,276,240,161,280,443,,no_signal
phone,control,58,304,304,P.lead,0,74,,,,233,,
phone,plain,47,492,596,P.lead,0,414,340,169,466,592,,no_signal
phone,chatgpt,62,508,740,P.lead,0,497,355,276,444,730,730,personalized
phone,control-warm,26,212,212,P.lead,0,40,,,,197,,
phone,plain-warm,25,292,448,P.lead,0,287,244,160,282,445,,no_signal
phone,control,45,332,332,P.lead,0,61,,,,262,,
phone,plain,43,492,608,P.lead,0,420,352,171,469,605,,no_signal
phone,chatgpt,50,568,692,P.lead,0,551,425,178,500,688,688,personalized
phone,control-warm,104,288,288,P.lead,0,118,,,,275,,
phone,plain-warm,22,284,448,P.lead,0,272,238,160,276,446,,no_signal
phone,control,60,320,320,P.lead,0,75,,,,262,,
phone,plain,46,480,616,P.lead,0,460,343,187,411,612,,no_signal
phone,chatgpt,100,496,660,P.lead,0,488,311,206,436,653,653,personalized
phone,control-warm,24,208,208,P.lead,0,36,,,,192,,
phone,plain-warm,26,308,460,P.lead,0,291,246,160,286,457,,no_signal
phone,control,49,332,332,P.lead,0,63,,,,262,,
phone,plain,43,576,692,P.lead,0,509,438,175,560,689,,no_signal
phone,chatgpt,50,512,636,P.lead,0,448,369,178,494,630,,holdout
phone,control-warm,26,212,212,P.lead,0,39,,,,197,,
phone,plain-warm,31,304,456,P.lead,0,290,239,159,284,451,,no_signal
phone,control,41,432,432,P.lead,0,56,,,,365,,
phone,plain,88,536,640,P.lead,0,519,320,172,449,633,,no_signal
phone,chatgpt,46,476,676,P.lead,0,457,334,256,406,672,,holdout
phone,control-warm,44,240,240,P.lead,0,58,,,,221,,
phone,plain-warm,171,432,600,P.lead,0,427,237,162,422,597,,no_signal
phone,control,46,332,332,P.lead,0,61,,,,263,,
phone,plain,115,612,748,P.lead,0,604,409,183,551,743,,no_signal
phone,chatgpt,49,456,572,P.lead,0,385,311,170,432,567,,holdout
phone,control-warm,25,216,216,P.lead,0,38,,,,200,,
phone,plain-warm,23,296,448,P.lead,0,276,241,161,280,446,,no_signal
phone,control,50,324,324,P.lead,0,66,,,,263,,
phone,plain,109,532,668,P.lead,0,523,343,179,475,663,,no_signal
phone,chatgpt,39,580,720,P.lead,0,561,450,192,513,715,715,personalized
phone,control-warm,26,216,216,P.lead,0,39,,,,199,,
phone,plain-warm,24,292,444,P.lead,0,277,241,160,281,440,,no_signal
phone,control,46,372,372,P.lead,0,61,,,,312,,
phone,plain,49,484,620,P.lead,0,413,338,200,459,617,,no_signal
phone,chatgpt,122,564,704,P.lead,0,493,343,190,547,697,697,personalized
phone,control-warm,86,272,272,P.lead,0,102,,,,264,,
phone,plain-warm,111,384,536,P.lead,0,374,245,161,369,533,,no_signal
phone,control,48,332,332,P.lead,0,65,,,,240,,
phone,plain,58,592,696,P.lead,0,575,423,174,511,691,,no_signal
phone,chatgpt,44,496,612,P.lead,0,414,341,177,470,604,604,personalized
phone,control-warm,24,216,216,P.lead,0,39,,,,199,,
phone,plain-warm,23,292,452,P.lead,0,282,244,159,286,447,,no_signal
```

## Real network, DebugBear free test (2026-10-26)

WebPageTest now needs an account; DebugBear's free website speed test needs
none and shapes a real connection instead of simulating one. Profile used:
Mobile, US East, 12 Mbps, 70 ms RTT, 2x CPU, Chrome 155, a cold first view
each run. The control is `/no-tag/` on the lab (the homepage with the tag line
removed, byte for byte otherwise, deployed 2026-10-26).

| Arm | Runs | TTFB | FCP | LCP | CLS |
|---|---|---|---|---|---|
| `/no-tag/?utm_source=chatgpt.com` (control) | 2 | 371, 374 ms | 604, 611 ms | 604, 611 ms | 0 |
| `/?utm_source=chatgpt.com` (tag, signal, written) | 2 | 372, 362 ms | 992, 856 ms | 1.21, 1.13 s | 0 |
| `/` (tag, no signal) | 1 | 375 ms | 820 ms | 994 ms | 0 |

Reports: debugbear.com/test/website-speed/ `wpkHJDfz`, `SXxLZwzK` (tag),
`9UheUs4i`, `UpTlcn0W` (control), `uaobl9k2` (no signal).

What it says:
- On a cold first view over a real shaped connection, the tag adds about
  **+0.5 to +0.6 s to LCP with a signal** and **+0.4 s without one**. The lab's
  Chromium emulation gave +0.29 s (written) and +0.20 s (no signal) on its
  phone profile: emulation does not slow the handshakes, as this note said.
- About half of it is **FCP** (+0.25 to +0.39 s): the tag is a synchronous
  script on another host, so the whole page waits for a new connection to
  edge.example.com (DNS, TCP, TLS) and the boot download before its first
  paint. The rest is the `/select` round trip while the hero stays hidden
  (DebugBear: "h1 hidden until at least 1.07 s").
- CLS stays 0 in every run.

Options (not built, the founder's call):
1. A two-part tag: an inline `<style>` that hides only the targets, plus the
   script as `async`. The page paints at once; only the rewritten parts wait.
   Removes the FCP share. Costs a second pasted line and a hide rule that no
   longer comes from the script's manifest.
2. Serve the boot from the customer's own host (a proxy path) so no new
   connection opens. Works only where the customer can add a route.
3. Keep the tag as is and state the real number on the speed page.

The speed page stays unregistered until one of these is chosen.

### Two-part tag on a real network (2026-10-26, after edge `8fd5815e`)

Same DebugBear profile. The lab's `two-part` branch
(two-part.lab.example.com) serves the homepage with the pasted
style and the async tag. The version was written there in a browser check
("Invoices come in late."), and the paste was disabled after the write.

| Arm | Runs | TTFB | FCP | LCP |
|---|---|---|---|---|
| control `/no-tag/` (above) | 2 | 371, 374 ms | 604, 611 ms | 604, 611 ms |
| today's tag (above) | 2 | 372, 362 ms | 992, 856 ms | 1.21, 1.13 s |
| two-part tag | 2 | 389, 390 ms | 863, 665 ms | 1.44, 1.17 s |

Reports: `Zc8eQkZ2`, `AP4VMDXV`. The free queue delayed both runs.

What it says, with only two runs:
- **FCP comes back near the control in the clean run** (665 ms against
  604): the page paints without waiting for our connection. The first run
  (863 ms) was the branch's first, cold deployment.
- **LCP does not improve.** The hero headline is the LCP element and stays
  hidden until the same chain completes: a new connection to
  edge.example.com, the boot, then `/select`. The async script starts it
  no earlier than the sync one did.
- So option (a) removes the blank page, not the headline's wait. Cutting
  LCP needs the chain shorter:
  - an inline starter in the paste that sends `/select` at once, without
    waiting for the boot download (saves about one round trip);
  - or the edge on the customer's own origin (a proxy path), which removes
    the new connection (about three round trips).
