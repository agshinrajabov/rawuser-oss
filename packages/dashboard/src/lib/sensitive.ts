/**
 * The sensitive-site control in Results' Admin block, superadmin only (mock
 * design/mock/sales-readiness/site-wide-and-sensitive.html, sections 05 to
 * 08, approved 2026-10-22; contract docs/specs/sensitive-customers.md, "The
 * endpoint (as built)", and packages/generation/src/admin/sensitive.ts).
 *
 * One row beside Test size: the flag and the count of kept sections, one
 * button. One dialog: the switch, the kept sections as chips, one input. A
 * refusal is the API's own sentence, shown as written. Turning the flag on
 * sends the ready versions back to be written again under the claims rules
 * (docs/specs/claims-lock.md), and the dialog says so before Save.
 *
 * Pure functions plus the two calls with an injectable fetch, tested in
 * test/analytics/sensitive.test.ts.
 */

import { validKeptSections } from "@rawuser/shared";
import { ApiError, apiFetch } from "./api";
import type { ReadinessCheck } from "./readiness";

export const SENSITIVE_PATH = "/admin/customers/sensitive";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** GET and POST answer with this. */
export interface SensitiveView {
  customer_id: string;
  sensitive: boolean;
  kept_sections: string[];
  /** Confirmed pages and counted picked buttons outside `/` and the list; empty while on. */
  outside: { pages: string[]; counted: string[] };
  limits: { sections: number; length: number; depth: number };
}

/** The POST answer: the view, plus what the change leaves behind. */
export interface SensitiveSaved extends SensitiveView {
  changed: boolean;
  /** Ready versions sent back to be written under the claims rules (the flag went on). */
  versions_marked_stale: number;
  rows_to_rewrite: null | { why: "marked" | "shortened"; removed: string[] };
  /** The API's own line for the founder; the row says it in the mock's words. */
  warning: string | null;
}

export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** The view, or null when the answer is not one. */
export function readView(raw: unknown): SensitiveView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sensitive !== "boolean") return null;
  const outside = (r.outside ?? {}) as Record<string, unknown>;
  const limits = (r.limits ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    customer_id: typeof r.customer_id === "string" ? r.customer_id : "",
    sensitive: r.sensitive,
    kept_sections: strings(r.kept_sections),
    outside: { pages: strings(outside.pages), counted: strings(outside.counted) },
    limits: {
      sections: n(limits.sections, 50),
      length: n(limits.length, 200),
      depth: n(limits.depth, 4),
    },
  };
}

function readSaved(raw: unknown): SensitiveSaved | null {
  const view = readView(raw);
  if (!view) return null;
  const r = raw as Record<string, unknown>;
  const rows = r.rows_to_rewrite as Record<string, unknown> | null | undefined;
  return {
    ...view,
    changed: r.changed === true,
    versions_marked_stale:
      typeof r.versions_marked_stale === "number" && r.versions_marked_stale > 0
        ? r.versions_marked_stale
        : 0,
    rows_to_rewrite:
      rows && (rows.why === "marked" || rows.why === "shortened")
        ? { why: rows.why, removed: strings(rows.removed) }
        : null,
    warning: typeof r.warning === "string" ? r.warning : null,
  };
}

/**
 * The read. `missing`: a worker without the endpoint (404) or an answer of
 * another shape; the row is not drawn. `failed`: any other failure; the row
 * says it could not be read.
 */
export type SensitiveRead =
  | { kind: "ok"; view: SensitiveView }
  | { kind: "missing" }
  | { kind: "failed" };

export async function readSensitive(
  customerId: string,
  api: Api = apiFetch,
): Promise<SensitiveRead> {
  try {
    const raw = await api<unknown>(
      `${SENSITIVE_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    const view = readView(raw);
    return view ? { kind: "ok", view } : { kind: "missing" };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { kind: "missing" };
    return { kind: "failed" };
  }
}

export type SaveOutcome =
  | { kind: "ok"; saved: SensitiveSaved }
  /** The API's sentence (400 the list line, 409 the pages in the way, 500 send again), as written. */
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

export const SAVE_FAILED = "That did not go through. Try again in a minute.";

/** The API's `error`, exactly as written; null when the body has none. */
export function apiSentence(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const raw = e.message.replace(/^API error \d+: ?/, "");
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

/** POST the flag and the list together (mock A15: "Save sends the flag and the list together"). */
export async function saveSensitive(
  customerId: string,
  sensitive: boolean,
  kept: readonly string[],
  api: Api = apiFetch,
): Promise<SaveOutcome> {
  try {
    const raw = await api<unknown>(SENSITIVE_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, sensitive, kept_sections: [...kept] }),
    });
    const saved = readSaved(raw);
    return saved ? { kind: "ok", saved } : { kind: "failed", message: SAVE_FAILED };
  } catch (e) {
    const sentence = apiSentence(e);
    if (sentence && e instanceof ApiError && e.status !== 403) {
      return { kind: "refused", sentence };
    }
    return { kind: "failed", message: SAVE_FAILED };
  }
}

// ---------------------------------------------------------------------------
// The kept sections, as chips
// ---------------------------------------------------------------------------

/**
 * What one typed section becomes: the shared rule's own form (`products/`
 * gives `/products`), or the text as typed when the rule refuses it, so the
 * server's own line says why on Save. Null for nothing, or for `/`, which is
 * always kept.
 */
export function sectionOf(typed: string): string | null {
  let v = typed.trim().split(/[?#]/, 1)[0] ?? "";
  if (v === "") return null;
  if (!v.startsWith("/")) v = `/${v}`;
  if (v === "/") return null;
  const valid = validKeptSections([v]);
  return valid?.[0] ?? v;
}

/** The list with one more section, once; the same list when there is nothing to add. */
export function addSection(list: readonly string[], typed: string): string[] {
  const s = sectionOf(typed);
  if (s === null || list.includes(s)) return [...list];
  return [...list, s];
}

export function removeSection(list: readonly string[], section: string): string[] {
  return list.filter((s) => s !== section);
}

// ---------------------------------------------------------------------------
// The words (mock section 09)
// ---------------------------------------------------------------------------

export const ROW_KEY = "Sensitive site";
export const ON = "On";
export const OFF = "Off";
export const MARK_THIS_SITE = "Mark this site";
export const CHANGE = "Change";
export const NOT_READ = "Could not be read just now.";

export const DIALOG_TITLE = "Sensitive site";
export const DIALOG_LEAD = "A site about health or another special category.";
export const SWITCH_LABEL = "Record pages as groups";
export const SWITCH_SUB = "No single page path is stored beside a visit.";
/** The claims lock (claims-lock.md): said before Save, only when the flag goes on. */
export const CLAIMS_LINE =
  "Saving sends the ready versions back to be written under the claims rules.";
export const KEPT_LABEL = "Kept sections";
export const ADD = "Add";
export const SECTION_PLACEHOLDER = "/section";
export const KEPT_HELP = "Pages under a kept section are recorded as a group, others as one group.";
export const CANCEL = "Cancel";
export const SAVE = "Save";

export const REWRITE_LINE = "Older visits may still name a page. Run the rewrite.";
export const HOW = "How";
export const HIDE = "Hide";
export const REWRITE_STEPS = [
  "Wait ten minutes, so the edge reads the new list.",
  "Run the rewrite statements on the older rows.",
  "Rebuild daily counts, below.",
] as const;

/** "5 kept sections", "1 kept section", "No kept sections". */
export function keptWord(n: number): string {
  if (n <= 0) return "No kept sections";
  return n === 1 ? "1 kept section" : `${n} kept sections`;
}

/** "20 versions are being rewritten under the claims rules."; null for none. */
export function rewritingLine(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n} ${n === 1 ? "version is" : "versions are"} being rewritten under the claims rules.`;
}

/**
 * The versions waiting to be written again, from GET /admin/variants/list
 * (an array, or `{ items }` with `summary=1`). For a marked site every
 * rewrite runs under the claims rules, so the count is what the line says.
 */
export function staleCount(raw: unknown): number {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items as unknown[])
      : [];
  return items.filter(
    (v) => !!v && typeof v === "object" && (v as { status?: unknown }).status === "stale",
  ).length;
}

/** The claims line shows only while the dialog would turn the flag on. */
export function showsClaimsLine(wasOn: boolean, on: boolean): boolean {
  return on && !wasOn;
}

// ---------------------------------------------------------------------------
// "Mark it" on the readiness list
// ---------------------------------------------------------------------------

/**
 * The category line of a Yes that is not yet marked (readiness-check.md,
 * check 3): red, blocking, and for a superadmin session the API's "Mark it".
 * That action opens the sensitive dialog in place.
 */
export function isMarkIt(c: Pick<ReadinessCheck, "id" | "state" | "action">): boolean {
  return c.id === "category" && c.state === "red" && c.action !== null;
}
