/**
 * Source vocabulary learning (L2 Layer F, docs/specs/source-recovery.md).
 * Off unless SOURCE_LEARNING = "on".
 *
 * The vocabulary (shared/signals/source-vocabulary.ts) can only name what
 * it already knows. When a visit carries a utm_source, a utm_medium, a
 * referrer host or an Android app package that nothing in the vocabulary
 * recognises, add 1 to a
 * weekly counter per (kind, token) per customer BUCKET in D1. A counter,
 * not a row: no path, no time beyond the ISO week, nothing joins to it.
 * The weekly job lists tokens seen across at least two buckets and twenty
 * sessions, and a human adds them to the vocabulary with a channel.
 *
 * Privacy: the character filter (no "@", no long digit runs, no IP shape,
 * at most 64 characters, hosts that read like a person's domain skipped,
 * DO_NOT_LEARN) is the first screen; the real control is the review
 * threshold: a value must repeat verbatim across at least two customer
 * buckets and fifty sessions in a week before a human sees it, and a
 * one-off personal label never does that (ADR 0030). Cost: at most three
 * fire-and-forget UPSERTs on a qualifying request, never on the response
 * path.
 */

import type { Signals } from "@rawuser/shared";
import {
  DO_NOT_LEARN,
  isUnknownReferrerHost,
  isUnknownUtmMedium,
  isUnknownUtmSource,
  looksLikePersonalHost,
} from "@rawuser/shared/signals/source-vocabulary";
import { isoWeek } from "./ua-tokens.ts";

/**
 * "app_package" is the package id of an `android-app://` referrer the exact
 * table does not know (Layer G); never mixed with web hosts.
 */
export type TokenKind = "utm_source" | "utm_medium" | "referrer_host" | "app_package";

const MAX_LEN = 64;
const DIGIT_RUN = /\d{6,}/;
const IP_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Sanitised token or null when it must not be counted. Exported for tests. */
export function learnableToken(raw: string | null | undefined): string | null {
  const t = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!t || t.length > MAX_LEN) return null;
  if (t.includes("@") || DIGIT_RUN.test(t) || IP_LIKE.test(t)) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return null;
  if (DO_NOT_LEARN.has(t)) return null;
  return t;
}

/** The (kind, token) pairs a visit contributes: only what the vocabulary missed. */
export function unknownTokens(signals: Signals): Array<{ kind: TokenKind; token: string }> {
  const out: Array<{ kind: TokenKind; token: string }> = [];
  if (isUnknownUtmSource(signals.utm.source)) {
    const t = learnableToken(signals.utm.source);
    if (t) out.push({ kind: "utm_source", token: t });
  }
  if (isUnknownUtmMedium(signals.utm.medium)) {
    const t = learnableToken(signals.utm.medium);
    if (t) out.push({ kind: "utm_medium", token: t });
  }
  // A package id (android-app://) is unknown unless the exact table has it,
  // is never judged as a web host, and is counted under its own kind so the
  // weekly job checks it against the package table (Layer G).
  const isApp = signals.referrerIsApp === true;
  if (isUnknownReferrerHost(signals.referrerHost, isApp)) {
    const t = learnableToken(signals.referrerHost);
    // A token that reads like a person's own domain is never counted.
    if (t && !looksLikePersonalHost(t)) {
      out.push({ kind: isApp ? "app_package" : "referrer_host", token: t });
    }
  }
  return out;
}

async function bucketFor(customerId: string, week: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(customerId + week));
  return (new Uint8Array(digest)[0] ?? 0).toString(16).padStart(2, "0");
}

export async function countSignalTokens(
  db: D1Database,
  customerId: string,
  signals: Signals,
): Promise<void> {
  const tokens = unknownTokens(signals);
  if (tokens.length === 0) return;
  const week = isoWeek();
  const bucket = await bucketFor(customerId, week);
  try {
    await db.batch(
      tokens.map((t) =>
        db
          .prepare(
            `INSERT INTO signal_token_counts (week, customer_bucket, kind, token, count)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(week, customer_bucket, kind, token) DO UPDATE SET count = count + 1`,
          )
          .bind(week, bucket, t.kind, t.token),
      ),
    );
  } catch {
    console.error("[rawuser/signal-tokens] count failed (non-critical)");
  }
}
