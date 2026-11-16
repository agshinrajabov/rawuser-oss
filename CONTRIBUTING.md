# Contributing

Thank you for looking. A few things work differently here than in most
repositories, so please read this once.

## Before you write code

For anything larger than a small fix, open an issue first and say what you
want to change and why. It saves you from building something we cannot
take.

## Setting up

Node 22 (see `.nvmrc`) and pnpm 9.

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm lint

The tests need no account and no network. A change comes with tests that
fail without it.

## Lines a change may not cross

These are the product, not preferences. A pull request that crosses one is
closed.

- No fingerprinting: never combine device or browser attributes to
  recognise a visitor.
- No cross-site identity and no third-party cookies.
- Never link one visitor's activity across customers.
- No inference of a special category (health, religion, politics,
  sexuality, ethnicity, union membership), and no visitor type that
  decides prices, eligibility, job ads or admissions.
- Never sell or share data about a single visitor.

And three that keep it fast and cheap:

- No model call, no database write of personal data and no extra network
  round trip while a visitor waits. Versions are written ahead of time.
- The snippet stays under 15 KB gzipped. A test fails the build above it.
- The snippet hides only the parts it rewrites, never the whole page, and
  on a timeout the page stays as built.

A new signal (anything read about a visit) needs a sentence on its lawful
basis and what a site owner would tell its visitors. Open an issue before
the code.

## How a change lands

This repository is published from our working repository at each release.
We apply an accepted change there, and it appears here with the next
release, with your name on it. Your pull request is closed at that point,
not merged; that is how it is meant to look.

## The contributor agreement

We can only take a change from someone who has agreed to
[CLA.md](CLA.md). You agree by writing this sentence in your pull request:

> I have read the contributor agreement in CLA.md and I agree to it.

## Licences

What you add to `packages/shared`, `packages/snippet`, `packages/signals`
or `packages/intent` is MIT. Everything else is AGPL, version 3 only.
See [NOTICE.md](NOTICE.md).

## Security

Do not open an issue for a vulnerability. See [SECURITY.md](SECURITY.md).
