/**
 * The free AI-traffic audit at the edge (docs/specs/ai-traffic-audit.md §3.4,
 * privacy review condition 1 of 2026-10-06). The rule itself is shared
 * (@rawuser/shared audit.ts, `auditRefusal`); this file reads its two inputs
 * at the edge.
 *
 * - The host comes from the browser-set `Origin` header. A page script cannot
 *   change it; `self_host` is only the page's own claim and is never used
 *   here. No `Origin`, or `null`: no host, refused.
 * - The bundle: `/select` passes the one it already read (no KV read of its
 *   own); `/s/{id}.js` reads it in its existing batch; `/event` reads it in
 *   `waitUntil`, kept four minutes per isolate (below, event-bundle.ts).
 *
 * A refused host is never stored, logged or alerted.
 */

import { type AuditRefusal, type VisitorBundle, auditRefusal } from "@rawuser/shared";
import { EVENT_BUNDLE_MEMO_MS, eventBundleFor } from "./event-bundle.ts";

/** What the audit adds to the visitor bundle (spec §3.4); absent for every other customer. */
export type AuditFields = Pick<VisitorBundle, "a" | "ad" | "ae">;

/**
 * The audit fields of a bundle, or null when it is not an audit customer's.
 * Read defensively: a KV value is whatever was written.
 */
export function auditOf(bundle: unknown): AuditFields | null {
  if (!bundle || typeof bundle !== "object") return null;
  const b = bundle as AuditFields;
  if (b.a !== 1) return null;
  return {
    a: 1,
    ...(typeof b.ad === "string" ? { ad: b.ad } : {}),
    ...(typeof b.ae === "number" && Number.isFinite(b.ae) ? { ae: b.ae } : {}),
  };
}

/** The host of a browser `Origin` header; null for none, `null`, or anything unparsable. */
export function originHost(origin: string | null): string | null {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Why this request must record nothing, from its `Origin` header and the audit fields, or null. */
export function refusedByAudit(
  audit: AuditFields | null,
  request: Request,
  now = Date.now(),
): AuditRefusal | null {
  if (!audit) return null;
  return auditRefusal(audit, originHost(request.headers.get("origin")), now);
}

// ---------------------------------------------------------------------------
// /event: the fields from the bundle, read after the 202, kept four minutes
// ---------------------------------------------------------------------------

export const AUDIT_MEMO_MS = EVENT_BUNDLE_MEMO_MS;

/**
 * The customer's audit fields for `/event`: one bundle read per customer per
 * isolate per four minutes, in `waitUntil`, never on the response path. A
 * failed read is not remembered and counts as no audit, the same choice as
 * the tombstone read (closed.ts). The read and its memo are event-bundle.ts's:
 * `/event` takes the sensitive flag from the same read.
 */
export async function auditFieldsFor(
  kv: KVNamespace,
  customerId: string,
  now = Date.now(),
): Promise<AuditFields | null> {
  return auditOf((await eventBundleFor(kv, customerId, now)).fields);
}
