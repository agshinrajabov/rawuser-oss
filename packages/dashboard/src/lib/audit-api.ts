"use client";

/**
 * The audit's calls (docs/specs/ai-traffic-audit.md §17.4).
 *
 * Public (no session): every token rides in a POST body, never in a URL, a
 * query string, a header or storage. The invite and report tokens come from
 * the `#t=` fragment, which the browser never sends anywhere, and the page
 * drops the fragment from the address bar once read. The setup token lives in
 * component memory only, for one POST.
 *
 * Signed in: apiFetch with the session, customer_id in the query (an id,
 * never a token).
 */

import type { AuditReport, AuditReview, AuditStatus } from "@rawuser/shared";
import { API_ORIGIN, apiFetch } from "./api";
import { hashToken } from "./audit";

// ---------------------------------------------------------------------------
// The fragment
// ---------------------------------------------------------------------------

/**
 * Reads `t` from the fragment and removes the fragment from the address bar
 * (history.replaceState keeps the path and any query, drops the hash), so the
 * token is not left in the bar, in a screenshot or in a copied address.
 */
export function takeHashToken(): string {
  if (typeof window === "undefined") return "";
  const t = hashToken(window.location.hash);
  if (window.location.hash) {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------

export interface PublicAnswer<T> {
  status: number;
  data: T | null;
}

async function post<T>(path: string, body: unknown): Promise<PublicAnswer<T>> {
  const resp = await fetch(`${API_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  let data: T | null = null;
  try {
    data = (await resp.json()) as T;
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

export interface AuditOpenAnswer {
  ok: boolean;
  status?: "invited" | "used" | "expired";
  invited_name?: string | null;
  invited_site?: string | null;
  privacy_line?: string;
  error?: string;
}

export function openAuditInvite(t: string): Promise<PublicAnswer<AuditOpenAnswer>> {
  return post("/admin/audit/open", { t });
}

export interface AuditSubmitFields {
  url: string;
  name: string;
  email: string;
  banner: boolean;
  terms: boolean;
}

export interface AuditSubmitAnswer {
  ok: boolean;
  customer_id?: string;
  domain?: string;
  setup_token?: string;
  tag?: string;
  privacy_line?: string;
  error?: string;
  field?: string;
  message?: string;
}

export function submitAudit(
  t: string,
  f: AuditSubmitFields,
): Promise<PublicAnswer<AuditSubmitAnswer>> {
  return post("/admin/audit/submit", { t, ...f });
}

/** "Set your password": the setup token from the submit answer, posted once. */
export function setAuditPassword(
  setupToken: string,
  password: string,
): Promise<PublicAnswer<Record<string, unknown>>> {
  return post("/admin/customer-users/setup", { token: setupToken, password });
}

export interface PublicReportAnswer {
  ok: boolean;
  report?: AuditReport;
  released_at?: number;
  expires_at?: number;
  error?: string;
}

export function readPublicReport(t: string): Promise<PublicAnswer<PublicReportAnswer>> {
  return post("/admin/audit/report/public", { t });
}

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

const q = (id: string) => `customer_id=${encodeURIComponent(id)}`;

export function getAuditStatus(customerId: string): Promise<AuditStatus> {
  return apiFetch<AuditStatus>(`/admin/audit?${q(customerId)}`);
}

export interface SignedInReport {
  report: AuditReport;
  built_at: number;
  released_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export function getAuditReport(customerId: string): Promise<SignedInReport> {
  return apiFetch<SignedInReport>(`/admin/audit/report?${q(customerId)}`);
}

export interface LinkAnswer {
  link: string;
  expires_at: number;
  ends_at: number | null;
}

export function makeShareLink(customerId: string): Promise<LinkAnswer> {
  return apiFetch<LinkAnswer>("/admin/audit/share-link", {
    method: "POST",
    body: JSON.stringify({ customer_id: customerId }),
  });
}

export interface AuditSummary {
  open: number;
  max: number;
  invites_on: boolean;
}

export function getAuditSummary(): Promise<AuditSummary> {
  return apiFetch<AuditSummary>("/admin/audit/summary");
}

export interface AuditReviewAnswer {
  status: AuditStatus;
  report: AuditReport | null;
  review: AuditReview | null;
  built_at: number | null;
  released_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  can_make_pilot: boolean;
}

export function getAuditReview(customerId: string): Promise<AuditReviewAnswer> {
  return apiFetch<AuditReviewAnswer>(`/admin/audit/review?${q(customerId)}`);
}

function act<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export const releaseReport = (id: string) =>
  act<LinkAnswer>("/admin/audit/release", { customer_id: id });
export const revokeReport = (id: string) =>
  act<{ ok: true }>("/admin/audit/revoke", { customer_id: id });
export const endAuditNow = (id: string) =>
  act<{ ok: true; ended_at: number; delete_at: number }>("/admin/audit/end", { customer_id: id });
export const recordPilotTerms = (id: string, signedAt?: number) =>
  act<{ ok: true; pilot_terms_at: number }>("/admin/audit/pilot-terms", {
    customer_id: id,
    ...(signedAt !== undefined ? { signed_at: signedAt } : {}),
  });
export const makePilot = (id: string) =>
  act<{ ok: true; plan: "pilot"; status: "active"; was_ended: boolean }>(
    "/admin/audit/make-pilot",
    { customer_id: id },
  );

export interface AuditInviteAnswer {
  id: string;
  kind: "audit";
  link: string;
  expires_at: number;
}

export function makeAuditInvite(body: {
  name?: string;
  site?: string;
}): Promise<AuditInviteAnswer> {
  return act<AuditInviteAnswer>("/admin/applications/invite", { ...body, kind: "audit" });
}
