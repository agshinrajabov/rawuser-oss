# Self-hosting

There are two ways to run Rawuser yourself, and they run the same code:

- **On your own server.** One process on any machine that runs Node, or
  in Docker, with your data in SQLite files.
- **On Cloudflare.** Two Workers, KV, D1 and Pages in your own Cloudflare
  account, answered from Cloudflare's edge.

Either way nothing is sent to us. Your install talks to your own host,
your own site and the model you chose. If you would like us to know you run
it, say so in
[Show and tell](https://github.com/agshinrajabov/rawuser-oss/discussions/categories/show-and-tell);
that is the only way we find out.

For both you need Node 22, pnpm 9 and a model that writes the versions:
any OpenAI-compatible endpoint with its key. On Cloudflare, Workers AI in
the same account can be the model.

## On your own server

    git clone https://github.com/agshinrajabov/rawuser-oss.git
    cd rawuser-oss
    pnpm install
    pnpm server:setup
    pnpm server:start

`pnpm server:setup` asks, writes the answers to `.env`, and is safe to
run again:

1. The three addresses people will reach it at. Each needs its own host
   or port: your site's visitors' browsers call the first, the dashboard
   calls the second, and the third is the dashboard itself.
2. The model: its endpoint, a model id, an optional second model and the
   key. The key is typed unseen and written to `.env`, which only your
   user can read.
3. It builds the dashboard for those addresses.
4. It makes your sign-in. You type an email and a password.

`pnpm server:start` runs everything in one process: the edge on port
8787, the API on 8788, the dashboard on 8789, and the four schedules. It
applies new migrations when it starts.

**How long it takes.** On a laptop with Docker, from `git clone` to a
running install with a sign-in: 2 minutes 36 seconds (the image build is
most of it). From adding a site to Go live: 95 seconds. From Go live until
a page's 30 versions are written: about 3 minutes, set mostly by the model.
Measured on 17 November 2026; the README has each step.

**Choosing a model.** Any model behind an OpenAI-compatible endpoint
that can return JSON. If yours is a reasoning model, turn its reasoning
off: reasoning is drawn from the same budget as the answer, and the page
read then comes back empty. The dashboard tells whoever runs the install
which it was: no model set, the model wrote nothing, it refused the key,
or it did not answer. The setting is `MODEL_EXTRA_BODY`, a JSON object added to every
request, in whatever form your provider takes, for example
`MODEL_EXTRA_BODY='{"thinking":{"type":"disabled"}}'`. You can name a
stronger model for reading the page's parts alone with `MODEL_ID_DETECT`.

**With Docker.** Copy `packages/server/.env.example` to `.env`, fill it
in, then:

    docker compose up -d
    docker compose run --rm rawuser pnpm server:user

The second line makes your sign-in. Your data is in the volume
`rawuser-data`.

**In front of it.** A real site is served over https, and a browser will
not let an https page call an http address. So put a reverse proxy with
TLS in front, with one host for each of the three ports, and set
`EDGE_ORIGIN`, `API_ORIGIN` and `DASHBOARD_ORIGIN` to those hosts. Then
set `TRUST_PROXY=on`, so the sign-in limit counts the visitor's address
and not your proxy's. Rawuser then believes the last address in
`X-Forwarded-For`, the one your proxy added; with more than one proxy in
front, make the last one pass on the address it trusts. Leave it off when the ports are open to the
internet: a client could then claim any address.

**Your data.** Two SQLite files in `DATA_DIR` (`./data` unless you set
it): `main.sqlite` holds your sites, versions and event rows, and
`kv.sqlite` the ready versions. Back the folder up. The folder and every
backup of it hold visit markers and, if you turn the memory on,
returning-visitor codes: keep them readable by the service's own user
only, and apply your retention period to the backups too. To copy it while the
process runs, use SQLite's own backup (`sqlite3 main.sqlite ".backup
copy.sqlite"`), not a plain file copy.

**Updating.** Pull the new code, run `pnpm install`, and start it again.

**Trying it on your own machine first.** It runs on `localhost` with the
defaults, and a site on `localhost` works too: add it as `localhost:4100`
and the dashboard opens it over `http`, as it does for any address you
type with `http://` in front. Every other site is opened over `https`.
The reads the server starts by itself (the weekly look at your site's
menu) leave a local address alone: the check that keeps a public install
from reading private addresses refuses it.

In Docker, `localhost` inside the container is the container, not your
machine. A site on your machine still works, because your browser opens
it and sends the page with the setup link, and visits reach the edge on
its published port. Only the tag check cannot reach it, so Connect says
it could not read the site and Look says it does not see the tag yet.
Both are about that check, not about the site; go live as usual.

**No lookup outside.** Before the server reads a page of your site by
itself, it checks that the address is a public one. On your own server it
asks the machine's own resolver for that, so nothing is asked of anyone
else. On Cloudflare the check asks Cloudflare's resolver. A page you open
with the setup link is not looked up at all.

**What is different from Cloudflare.**

- A visit is answered from where your server is, not from an edge near
  the visitor. The rule that protects your page is the same: with no
  answer in 1.5 seconds, it is shown as built.
- The visitor's country is not known unless a proxy in front of you sets
  a header with it. Name that header in `COUNTRY_HEADER`, and only when
  your proxy overwrites it: a header a client can send would let anyone
  claim a country. Unset, every
  visit's country is recorded as `other`, and versions for your top
  countries go by the browser's language.
- A page that is built in the browser is read through the link you open
  yourself. Cloudflare can render such a page on its own; a plain server
  does not.
- The model is an OpenAI-compatible endpoint. Workers AI is Cloudflare's.
- Invite emails are not sent. The dashboard gives you the link to send.

## On Cloudflare

You also need a Cloudflare account.

    npx wrangler login
    pnpm self-host

`pnpm self-host` says what it is about to do and asks before it changes
anything. In order:

1. Reads the account you are logged in to and asks whether to install
   there. With more than one account, name it:
   `CLOUDFLARE_ACCOUNT_ID=<id> pnpm self-host`.
2. Finds or makes the KV namespace `rawuser-variants` and the D1 database
   `rawuser_db`. It asks whether to keep the database inside the European
   Union.
3. Finds or makes the Pages project for the dashboard.
4. Asks for the model: Workers AI and a model id, or your endpoint's
   address, a model id, an optional second model and the key. The key is
   typed unseen and kept as a Cloudflare secret. It is written to no
   file.
5. Writes the two ids into `packages/edge/wrangler.toml` and
   `packages/generation/wrangler.toml`, builds the script, deploys the
   edge worker, applies the migrations, and deploys the generation worker
   with this install's own addresses.
6. Builds the dashboard against those addresses and deploys it.
7. Makes the first sign-in. You type an email and a password.
8. Asks both workers for `/health` and prints the three addresses.

Then sign in to the dashboard, add your site, and it gives you the tag to
paste.

`pnpm self-host --dry-run` reads the account and says what it would do,
and changes nothing.

It is safe to run again: it makes nothing twice and keeps the key that
seals stored two-step secrets. To update, pull the new code, run
`pnpm install`, and run `pnpm self-host` again.

Two cases where it stops on purpose:

- The checkout's configs already name other storage. That checkout runs
  another install, and the installer does not touch it.
- The checkout is fresh but the account already holds `rawuser-variants`
  or `rawuser_db`. Deploying would go over a running install. If that is
  what you mean, a new checkout taking over an install, run
  `pnpm self-host --adopt`.

### Your own domains on Cloudflare

The install answers on the `workers.dev` and `pages.dev` addresses
Cloudflare gives it. To use your own:

1. In both `wrangler.toml` files, take the comment marks off the
   `[[env.production.routes]]` block and put your host in.
2. In `packages/generation/wrangler.toml`, set `EDGE_ORIGIN`,
   `API_ORIGIN`, `OWN_HOSTS` and `DASHBOARD_ORIGIN` to the new addresses.
3. Deploy with `pnpm deploy:edge` and `pnpm deploy:generation`.
4. Build the dashboard with `NEXT_PUBLIC_ADMIN_API_ORIGIN`,
   `NEXT_PUBLIC_EDGE_ORIGIN` and `NEXT_PUBLIC_APP_ORIGIN` set to the new
   addresses, deploy it to your Pages project, and give that project its
   custom domain in Cloudflare.

The installer does not know about custom domains yet. A later
`pnpm self-host` writes the `workers.dev` addresses back, so once you
have your own domains, update with the two deploy commands instead. The
tag on your site names the edge address, so a site tagged before the move
needs the new tag.

## Settings

Everything about the install is a value with a comment beside it: in
`packages/generation/wrangler.toml` and `packages/edge/wrangler.toml` on
Cloudflare, and under the same names in `.env` on your own server. Unset, a feature says so or goes without:
no mail is sent without `SENDER_ADDRESS`, no tag is handed out without
`EDGE_ORIGIN`.

What a fresh install does and does not do:

| | Fresh install |
|---|---|
| Remembering returning visitors | off; `REMEMBER_DEFAULT = "on"` turns it on for new customers |
| The same on a site marked sensitive | never, unless `REMEMBER_ON_SENSITIVE = "on"` |
| The question on the page | off, per customer |
| Learning unknown sources and app marks | off (`SOURCE_LEARNING`, `UA_TOKEN_LEARNING`) |
| A test group that sees the original | 0% until a customer starts a test |
| The country on each event | on; each customer can turn it off |
| The carry between pages of one visit | on; each customer can turn it off |
| Keyword reading, page one to page two, the learned default, market versions | only after the customer answered "no" to the special-category question |
| Deleting old event rows | off; `RAW_EVENT_RETENTION_DAYS` turns it on |
| Two-step sign-in | available to every account; `MFA_REQUIRED_ROLES` makes it required |

## What the law asks of you

This is what we know from building it. It is not legal advice, and your
own lawyer's word counts for more than this page.

**You are the controller.** You decide that Rawuser runs on your site,
so under the GDPR you are the controller of what it processes about your
visitors. We are no party to it: we do not receive, see or store anything
from your install.

**Your processors are your host and your model provider.** On Cloudflare,
Cloudflare runs the workers and holds the database; on your own server,
whoever runs that machine does. The model provider receives the
text of your pages and your brief when versions are written. It never
receives anything about a visitor. Check both providers' terms as you
would for any processor, above all where the model provider is based.

**Never capture a signed-in page.** Setup reads a page of your site, and
for a site built in the browser it does so from your own browser, as you
see it. Whatever is on that page is stored for setup and sent to the
model. Open the setup link on a public page, signed out.

**What the script keeps on a visitor's device.** Four things, and the
ePrivacy Directive's Art. 5(3) (PECR regulation 6 in the UK) covers each
of them, whatever the storage is called:

| What | Where | How long |
|---|---|---|
| The visit marker: a random code | tab storage | thirty idle minutes, gone with the tab |
| The carry: two words, and the adapted text of your own pages | tab storage | the same |
| The asked mark: the question was shown, if you turn the question on | tab storage | until the tab closes |
| The returning visitor's code and last reason, if you turn it on | local storage | 13 months from the first page |

There are two readings, and we claim neither as settled:

- One treats the first two as audience measurement and continuity of a
  visit in progress: first-party, short-lived, no cross-site use,
  totals only. Under it some regulators allow storage without consent.
  The carry is the weaker case even here, because its purpose is to
  change what the page says and not to measure.
- The stricter one (the German reading of TDDDG section 25 is the
  clearest) says storage needs consent unless it is strictly necessary
  for a service the visitor asked for. None of the four is.

We claim no exemption for any of them. If your visitors are in the EU or
the UK, the safe way is to load the tag after your consent tool has a
yes. Know what that costs: a tag that starts after the page has painted
leaves that page as built, so a visitor's first page shows your original
and the versions begin with the next one. The returning visitor's code is
the clearest case of the four: 13 months, an identifier. Do not turn it
on for EU or UK visitors without consent.

**Answer the special-category question truthfully.** The dashboard asks
whether your site is about health, religion, politics, sexuality or
another special category. A "yes" marks the site sensitive: product and
article pages are then recorded as a group and not beside a visit marker,
keywords are not read, and versions may not speak about the reader's own
condition. A wrong "no" removes those protections from the people who
need them most.

**Set a retention period.** Event rows, with the visit marker and, if
you use it, the returning visitor's code, stay until you delete the
customer. The GDPR asks for a period you can state. Set
`RAW_EVENT_RETENTION_DAYS` (61 or more; the counts read 60 days back) and
rows older than that are deleted every six hours, while the daily totals
stay. To remove one customer and everything of theirs, the API has an
export and a delete for the first account: `GET /admin/customers/export`
and `POST /admin/customers/delete`, which takes a dry run first.

**Tell your visitors.** [privacy-notice.md](privacy-notice.md) has the
paragraph and a sentence for each switch. Put your own name where it says
"the operator".

**The connecting address.** Rawuser stores no address. It reads the
address a request came from in two places, to limit how often one
connection may try to sign in to the dashboard or post the lead form.
On your own server that is the socket's address, or your proxy's word
for it when `TRUST_PROXY` is on.

**In California.** Nothing an install collects is sold, and nothing is
shared for advertising across sites, because nothing leaves your
install. Say so in your notice if the CCPA applies to you.

**The lead form, if you use it.** The edge worker can take a contact
form from your own site. It is off until you set `PILOT_FORM_ORIGINS`.
Once on, it stores what the person typed (an email, a site, a note) in
your database and deletes it 12 months after the request last changed,
and it limits how often one connection
may post by reading the connecting address and keeping a keyed tag of it
for an hour. That is the one place the address is read. Say in your
notice what you do with the form's answers and for how long.

**Where the tag goes.** On your public pages. Not on signed-in or admin
pages: a path there is still counted, masked, and no version is served.
