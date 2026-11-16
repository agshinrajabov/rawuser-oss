/**
 * New versions wait for the customer's OK (docs/specs/versions-approval.md,
 * the founder, 2026-11-02). Every call and field of the approval flow is
 * read here, so the screens (Overview, Versions, Settings, the sidebar)
 * never touch the wire shape.
 *
 * Contract §4: list items carry `pending` and `pending_since` (also as
 * `approval` and `waiting_since`); GET /admin/variants/pending pairs the
 * live words with the new ones; approve, approve all, discard; the
 * customer's auto_approve switch, default off.
 */

import type { VariantListItem } from "@/types/api";
import { ApiError, apiFetch } from "./api";

export const PENDING_PATH = "/admin/variants/pending";
export const APPROVE_PATH = "/admin/variant/approve";
export const APPROVE_ALL_PATH = "/admin/variants/approve-all";
export const DISCARD_PATH = "/admin/variant/discard";
export const AUTO_APPROVE_PATH = "/admin/customers/auto-approve";

// ---------------------------------------------------------------------------
// The list's fields
// ---------------------------------------------------------------------------

type WithApproval = VariantListItem & { approval?: unknown; waiting_since?: unknown };

export function isWaiting(item: VariantListItem): boolean {
  const i = item as WithApproval;
  return i.pending === true || i.approval === "waiting";
}

export function waitingSince(item: VariantListItem): number | null {
  const i = item as WithApproval;
  const v = i.pending_since ?? i.waiting_since;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The versions waiting for an OK, oldest first. */
export function waitingVersions(items: readonly VariantListItem[] | null): VariantListItem[] {
  return (items ?? [])
    .filter(isWaiting)
    .sort((a, b) => (waitingSince(a) ?? 0) - (waitingSince(b) ?? 0));
}

/** "Rewritten 2 hours ago." for the waiting box; null without a time. */
export function rewrittenAgo(since: number | null, now: number): string | null {
  if (since === null) return null;
  const min = Math.max(0, Math.round((now - since) / 60_000));
  if (min < 2) return "Rewritten just now.";
  if (min < 60) return `Rewritten ${min} min ago.`;
  const h = Math.round(min / 60);
  if (h < 48) return `Rewritten ${h} ${h === 1 ? "hour" : "hours"} ago.`;
  return `Rewritten ${Math.round(h / 24)} days ago.`;
}

/** The Overview's count: `pending_versions` when the API gives it, else the list's. */
export function pendingCount(
  overview: { pending_versions?: unknown } | null | undefined,
  items: readonly VariantListItem[] | null,
): number {
  const n = overview?.pending_versions;
  return typeof n === "number" && Number.isFinite(n) ? n : waitingVersions(items).length;
}

// ---------------------------------------------------------------------------
// GET /admin/variants/pending
// ---------------------------------------------------------------------------

export interface PendingPart {
  path: string;
  /** The live body's words; null when the cell has no live body or the part is new. */
  live: string | null;
  /** The waiting body's words; null for a part only the live body has. */
  next: string | null;
}

export interface PendingItem {
  page_path: string;
  intent_dim: string;
  source_dim: string;
  pending_since: number | null;
  has_live: boolean;
  parts: PendingPart[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** The answer as the screen reads it; items that are not one are dropped. */
export function readPending(raw: unknown): PendingItem[] {
  const r = (raw ?? {}) as { items?: unknown };
  if (!Array.isArray(r.items)) return [];
  return r.items.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.intent_dim !== "string" || typeof o.source_dim !== "string") return [];
    const parts = Array.isArray(o.parts) ? o.parts : [];
    return [
      {
        page_path: typeof o.page_path === "string" ? o.page_path : "/",
        intent_dim: o.intent_dim,
        source_dim: o.source_dim,
        pending_since: typeof o.pending_since === "number" ? o.pending_since : null,
        has_live: o.has_live === true,
        parts: parts.flatMap((p) => {
          if (!p || typeof p !== "object") return [];
          const q = p as Record<string, unknown>;
          if (typeof q.path !== "string") return [];
          return [{ path: q.path, live: str(q.live), next: str(q.new) }];
        }),
      },
    ];
  });
}

export function pendingPath(customerId: string, pagePath?: string): string {
  const q = new URLSearchParams({ customer_id: customerId });
  if (pagePath) q.set("page_path", pagePath);
  return `${PENDING_PATH}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Approve, approve all, discard, and the switch
// ---------------------------------------------------------------------------

export type Api = typeof apiFetch;

export type ApprovalOutcome =
  | { kind: "ok"; pendingLeft: number | null; approved?: number; failed?: number }
  | { kind: "gone" }
  | { kind: "failed"; message: string };

export const APPROVAL_LINES = {
  approved: "Approved. Visitors see it from now on.",
  approvedAll: (n: number) => (n === 1 ? "1 version approved." : `${n} versions approved.`),
  discarded: "Discarded. Visitors keep the version they had.",
  gone: "Nothing waits here any more.",
  failed: "That did not go through. Try again in a minute.",
} as const;

/** The 409's own sentence (an ended audit, a page outside a sensitive site), else a plain line. */
function refusal(e: unknown): ApprovalOutcome {
  if (e instanceof ApiError) {
    if (e.status === 404) return { kind: "gone" };
    if (e.status === 409) {
      const body = e.message.replace(/^API error \d+: /, "");
      try {
        const j = JSON.parse(body) as { error?: unknown; message?: unknown };
        const m =
          typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : null;
        if (m && /\s/.test(m)) return { kind: "failed", message: m };
      } catch {
        // not JSON
      }
    }
  }
  return { kind: "failed", message: APPROVAL_LINES.failed };
}

const left = (v: unknown): number | null => (typeof v === "number" ? v : null);

export interface Cell {
  page_path: string;
  intent_dim: string;
  source_dim: string;
}

async function post(
  api: Api,
  path: string,
  body: Record<string, unknown>,
): Promise<ApprovalOutcome> {
  try {
    const a = (await api<Record<string, unknown>>(path, {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    if (a.ok === false)
      return a.error === "nothing_waiting"
        ? { kind: "gone" }
        : { kind: "failed", message: APPROVAL_LINES.failed };
    return {
      kind: "ok",
      pendingLeft: left(a.pending_left),
      ...(typeof a.approved === "number" ? { approved: a.approved } : {}),
      ...(typeof a.failed === "number" ? { failed: a.failed } : {}),
    };
  } catch (e) {
    return refusal(e);
  }
}

export function approve(customerId: string, cell: Cell, api: Api = apiFetch) {
  return post(api, APPROVE_PATH, { customer_id: customerId, ...cell });
}

export function discard(customerId: string, cell: Cell, api: Api = apiFetch) {
  return post(api, DISCARD_PATH, { customer_id: customerId, ...cell });
}

export function approveAll(customerId: string, pagePath: string | null, api: Api = apiFetch) {
  return post(api, APPROVE_ALL_PATH, {
    customer_id: customerId,
    ...(pagePath ? { page_path: pagePath } : {}),
  });
}

export interface AutoApprove {
  on: boolean;
  pending: number | null;
}

function readAuto(raw: unknown): AutoApprove | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = r.auto_approve;
  if (typeof v !== "boolean" && v !== 0 && v !== 1) return null;
  return { on: v === true || v === 1, pending: left(r.pending) };
}

/** The switch's state; null on a worker without it (the row then hides). */
export async function getAutoApprove(customerId: string, api: Api = apiFetch) {
  try {
    return readAuto(
      await api<unknown>(`${AUTO_APPROVE_PATH}?customer_id=${encodeURIComponent(customerId)}`),
    );
  } catch {
    return null;
  }
}

export async function setAutoApprove(
  customerId: string,
  on: boolean,
  api: Api = apiFetch,
): Promise<{ kind: "ok"; state: AutoApprove } | { kind: "failed"; message: string }> {
  try {
    const state = readAuto(
      await api<unknown>(AUTO_APPROVE_PATH, {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, on }),
      }),
    );
    return { kind: "ok", state: state ?? { on, pending: null } };
  } catch {
    return { kind: "failed", message: APPROVAL_LINES.failed };
  }
}

export const AUTO_LINES = {
  label: "New versions",
  off: "Wait for your OK",
  on: "Published without asking",
  turnOn: "Publish new versions without asking",
  turnOff: "Ask me first",
  subOff: "A rewritten version goes live only after you approve it on Versions.",
  subOn: "A rewritten version goes live at once. Versions waiting now still need your OK.",
} as const;
