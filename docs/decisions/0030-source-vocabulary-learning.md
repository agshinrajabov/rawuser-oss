# ADR 0030 · Source vocabulary and its learning loop (L2 Layer F)

Date: 2026-09-12
Status: ACCEPTED. The ask was to widen the tables, think of every case and
build a loop that learns new ones; privacy review done, its conditions in.

## Context

The classifier could only name sources it had a row for. ChatGPT's own
`utm_source=chatgpt.com` was not one of them (docs/research/
ai-click-attribution-2026.md), free-form operator values
("linkedin_newsletter") fell through, and every new AI product meant a
code change nobody noticed was missing.

## Decision

1. **One vocabulary** (`packages/shared/src/signals/source-vocabulary.ts`):
   exact tables for utm_source, utm_medium and referrer hosts per channel
   (ai, social, paid, organic, community, email), then patterns for
   free-form values. The classifier and the AI-source detector read only
   this module.
2. **Learning in aggregate** (`signal_token_counts`, migration 0022; edge
   `signal-tokens.ts`): a value nothing recognises is counted per ISO
   week, customer bucket (SHA-256 first byte of customer_id||week), kind
   and token. No visit row, no path, no time finer than the week.
3. **Review by a human**: `pnpm source:proposals` writes a file of values
   seen across at least 2 buckets and 50 sessions; the Monday cron tells
   the ops channel only how many wait, never the values. A row is added by
   hand; `pnpm source:purge` deletes a personal value at once and it goes
   into `DO_NOT_LEARN`.

## Privacy review conditions (2026-09-12), all applied

1. `SOURCE_LEARNING = "off"` in every environment until the first pilot
   has traffic and the founder turns it on (the Layer E precedent).
2. This ADR records the layer's own review.
3. Threshold 50 sessions, the same as Layer E.
4. No automatic transmission of values to a third party: the Telegram
   message carries a count and a command.
5. Hosts that read like a person's own domain are never counted
   (`looksLikePersonalHost`).
6. Purge path plus `DO_NOT_LEARN`.
7. The spec names the real control: cross-customer repetition, not the
   character filter, is what screens out one-off personal labels.

## Consequences

The tables grow from real traffic with a human in the loop; nothing
classifies itself. Token length is 64 (hostnames), Layer E's 32 was for
UA words.
