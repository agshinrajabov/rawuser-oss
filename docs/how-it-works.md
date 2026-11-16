# How it works

One idea carries the whole design:

    writing is offline and slow · choosing is at the edge and fast

A model never runs while a visitor waits. Every version of a page is
written ahead of time and stored. When a visit arrives, the edge reads
what the visit discloses, picks a ready version and answers. That is why
a visit costs a cache read and not a model call.

## The parts

| Part | Where | What it does |
|---|---|---|
| The script | `packages/snippet` | Runs in the visitor's browser: hides the parts to be rewritten, asks the edge once, writes the answer into the page |
| The edge worker | `packages/edge` | The visitor path: classifies a visit, picks a version from KV, takes event rows |
| The generation worker | `packages/generation` | Everything offline: reads a site's page, writes versions, counts results, serves the dashboard's API |
| The dashboard | `packages/dashboard` | Where a site owner sets a site up and reads the results |
| Shared code | `packages/shared` | The signal tables, the classifier and the types both workers and the script use |

Storage is Workers KV for what a visitor needs (the versions and one
small bundle per site) and D1 for the rest (sites, briefs, versions with
their history, event rows, totals). On your own server the two workers
run as they are in one Node process (`packages/server`), and both stores
are SQLite files.

## Setting a site up

1. **Connect.** The site owner pastes one tag, first in `<head>`.
2. **Read.** Rawuser reads the home page. A page built in the browser is
   read from the owner's own browser through a one-time link, because a
   plain fetch would see an empty shell.
3. **Find the parts.** A model names the parts worth rewriting (headline,
   paragraph, buttons, section headings) and gives each a selector. The
   owner sees them outlined on the real page and can pick others by
   clicking. Nothing is rewritten until the owner confirms.
4. **The brief.** A draft of what the product is and who it is for, taken
   from the page's own sentences. The owner corrects it.
5. **Go live.** The versions are written in the background, a few every
   five minutes, and each appears for visitors as it is ready.

### What a version is

A version is the same parts of the same page, written for one reason to
visit and one kind of source: a visitor comparing you with a rival who
came from an AI assistant, a visitor who clicked a pricing ad, and so
on. The reasons are six (`competitor`, `evaluation`, `feature`,
`problem`, `brand`, `pricing`) and a site gets only the ones it can
serve: no pricing page, no pricing versions.

Each version is checked by code before it is stored
(`packages/generation/src/lint`): no number the brief never gave, the
right language and script, no part repeating another, a button that still
says what it does. A version that fails is not shown; the page keeps what
it had.

Words change, the design does not. The script writes into the page's own
text nodes and keeps its icons, emphasis and markup. Each headline and
paragraph is written in three lengths, and the script tries them while
the part is still hidden and keeps the one that takes the same number of
lines as the original, so nothing below it moves.

After the first go live, a changed version waits for the owner's OK
unless the owner turned that off.

## A visit

1. The browser loads the tag, about 4 KB. Its first act is to hide the
   parts that will be rewritten, and only those, with
   `visibility: hidden`, which keeps their box. The rest of the page
   paints as usual.
2. The script asks the edge one question, `/select`, with what the visit
   discloses: campaign tags, the referring host, click id names, the
   language, the page's path, and the tab's visit marker
   ([signals.md](signals.md)).
3. The edge worker turns those into a vector: six scores for why, six for
   from where. The highest of each picks a version. It reads KV and
   answers. No database and no model is on this path.
4. The script writes the version into the hidden parts and shows them.

When something goes wrong the page wins. If the edge has not answered in
1.5 seconds the parts are shown as built, and a late answer is not
written over them. If the script dies, a CSS rule shows them after 4
seconds on its own. A crawler or an AI fetcher is answered with no
version at all and gets the page as built, so what a search engine
indexes is what the owner wrote.

A visit with no signal gets the original page, or what the owner chose
for such visits ([decision 0038](decisions/0038-direct-visitors.md)).

### The next pages

A visitor who lands from an assistant and then opens another page has
lost the signal: the second page has no tags and a referrer from the same
site. So the tab remembers the two words of the landing for thirty
minutes, and later pages of the same visit stay in the same kind of
version. It ends with the tab.

## Measuring

Each page view writes one event row after the answer has gone out, and a
click on a button the owner chose to count writes another. Rows carry the
visit marker, so a visit is counted once however many pages it opens.

To know whether versions help, an owner can start a test: a share of
visits, picked at random by the visit marker, see the original page. The
dashboard compares counted clicks between the two groups and shows a
difference only once each group has enough of them.

## Where to read the code

| To understand | Start at |
|---|---|
| What is read about a visit | `packages/shared/src/signals/extract.ts` |
| Signals to a vector | `packages/shared/src/classify/index.ts` |
| A vector to a version | `packages/shared/src/select/index.ts` |
| The visitor path | `packages/edge/src/index.ts` |
| Hiding and showing | `packages/snippet/src/boot.ts` |
| Writing into the page | `packages/snippet/src/apply.ts` |
| Writing a version | `packages/generation/src/orchestrator.ts` |
| The checks on a version | `packages/generation/src/lint/` |

The decisions behind these are in [decisions/](decisions/README.md), and
the research on where a visit comes from in [research/](research/).
