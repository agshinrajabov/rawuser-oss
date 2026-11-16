/**
 * Admin route router — maps /admin/* pathnames to their handlers.
 *
 * Public routes (no auth): /admin/login, /admin/login/mfa, OPTIONS preflight.
 * All other /admin/* routes require a valid session (X-Rawuser-Admin header
 * looked up in D1 via getSessionUser).
 */

import {
  handleAnalyticsBreakdown,
  handleAnalyticsOverview,
  handleAnalyticsTimeseries,
} from "./analytics.ts";
import {
  handleApplicationsArchive,
  handleApplicationsDelete,
  handleApplicationsInvite,
  handleApplicationsList,
  handleApplyInvite,
  handleApplyRead,
  handleApplySubmit,
} from "./apply.ts";
import {
  handleAuditBuild,
  handleAuditEnd,
  handleAuditMakePilot,
  handleAuditOpen,
  handleAuditPilotTerms,
  handleAuditRelease,
  handleAuditReport,
  handleAuditReportPublic,
  handleAuditReview,
  handleAuditRevoke,
  handleAuditShareLink,
  handleAuditStatus,
  handleAuditSubmit,
  handleAuditSummary,
} from "./audit.ts";
import { getSessionUser } from "./auth.ts";
import { handleButtonSet, handleButtonsGet } from "./buttons.ts";
import { handleChoice } from "./choice.ts";
import { jsonWithCors, preflightResponse } from "./cors.ts";
import { handleCountPickStatus, handleCountPickToken } from "./count-pick.ts";
import { handleCountrySwitch } from "./country.ts";
import { handleCustomerDelete, handleCustomerExport } from "./customer-data.ts";
import {
  handleCustomerUsersCreate,
  handleCustomerUsersList,
  handleCustomerUsersSetup,
} from "./customer-users.ts";
import { handleDirectInsightsSwitch } from "./direct-insights.ts";
import { handleDirectSwitches } from "./direct-switches.ts";
import { handleDnaSuggest } from "./dna-suggest.ts";
import { handleEmailTest } from "./email.ts";
import type { AdminEnv } from "./handlers.ts";
import {
  handleCaptureStatus,
  handleCaptureToken,
  handleConversionsConfirm,
  handleConversionsCount,
  handleConversionsDelete,
  handleConversionsList,
  handleConversionsUpsert,
  handleCustomersCreate,
  handleCustomersList,
  handleDnaGet,
  handleDnaUpsert,
  handleLogin,
  handleLogout,
  handleMe,
  handleOnboardConfirm,
  handleOnboardDetect,
  handleOnboardManifest,
  handleVariantGet,
  handleVariantRegenerate,
  handleVariantsList,
  handleVariantsStaleAll,
  handleVerify,
} from "./handlers.ts";
import { handleInstallPreCheck, handleInstallPreGet } from "./install-pre.ts";
import { handleKeywordsOff } from "./keywords.ts";
import {
  handleMfaDisable,
  handleMfaEnrolConfirm,
  handleMfaEnrolStart,
  handleMfaRecoveryCodes,
  handleMfaReset,
  handleMfaStatus,
} from "./mfa.ts";
import { handlePageGroupDelete, handlePageGroupSet, handlePageGroupsGet } from "./page-groups.ts";
import { handlePickStatus, handlePickToken } from "./pick.ts";
import { handlePilotRequestUpdateStatus, handlePilotRequestsList } from "./pilot-requests.ts";
import { handlePortfolioAttention, handlePortfolioCustomers } from "./portfolio.ts";
import {
  handleCustomerTest,
  handleHoldoutGet,
  handleHoldoutSet,
  handleLiftReport,
  handleProofBackfill,
  handleWeeklyDraft,
} from "./proof.ts";
import { handleGoLive, handleQuickstart, handleQuickstartGet } from "./quickstart.ts";
import { handleReadiness } from "./readiness.ts";
import { requireCustomerScope } from "./scope.ts";
import { handleSensitiveGet, handleSensitiveSet } from "./sensitive.ts";
import { handleLoginMfa, handleSessionsRevokeAll } from "./sign-in.ts";
import { handleSiteMapGet, handleSiteMapSet, handleSiteMapWrite } from "./site-map.ts";
import { handleHealthIssues } from "./snippet-issues.ts";
import { handleSnippetStatusProbe } from "./snippet-status.ts";
import { handleSpecialCategorySet } from "./special-category.ts";
import {
  handleApprove,
  handleApproveAll,
  handleAutoApproveGet,
  handleAutoApproveSet,
  handleDiscard,
  handlePendingList,
} from "./version-approval.ts";
import { handleVisitors } from "./visitors.ts";

/** What an enrol-only session may call (security-hardening.md §1.4). */
const ENROL_ROUTES = new Set([
  "GET /admin/me",
  "POST /admin/logout",
  "GET /admin/mfa/status",
  "POST /admin/mfa/enrol/start",
  "POST /admin/mfa/enrol/confirm",
]);

/**
 * Returns true when the pathname starts with /admin or is an OPTIONS preflight.
 * Used in index.ts to decide whether to enter the admin layer.
 */
export function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin");
}

/**
 * Handle the full admin request: preflight bypass, auth check, route.
 * Called from index.ts for all /admin/* requests.
 *
 * ctx is threaded through to getSessionUser for background last_seen_at updates.
 */
export async function handleAdmin(
  request: Request,
  env: AdminEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // CORS preflight — always allowed, no auth
  if (method === "OPTIONS") {
    return preflightResponse(env);
  }

  // Public route — login does not require an existing session
  if (pathname === "/admin/login" && method === "POST") {
    return handleLogin(request, env, ctx);
  }

  // Public route: the second step of a sign-in; the challenge from
  // /admin/login is the proof (security-hardening.md §1.4).
  if (pathname === "/admin/login/mfa" && method === "POST") {
    return handleLoginMfa(request, env, ctx);
  }

  // Public route — customer-user setup. The setup token IS the auth proof;
  // a customer who has never logged in must be able to hit this without a
  // session header. The handler validates the token + 7-day expiry + single-
  // use semantics internally before granting a session.
  if (pathname === "/admin/customer-users/setup" && method === "POST") {
    return handleCustomerUsersSetup(request, env);
  }

  // Public routes: the pilot apply page (docs/specs/pilot-apply.md). The
  // invite token IS the auth proof; each handler hashes it, checks expiry
  // and single use itself.
  if (pathname === "/admin/apply/invite" && method === "POST") {
    return handleApplyInvite(request, env);
  }
  if (pathname === "/admin/apply/read" && method === "POST") {
    return handleApplyRead(request, env);
  }
  if (pathname === "/admin/apply/submit" && method === "POST") {
    return handleApplySubmit(request, env, ctx);
  }

  // Public routes: the free audit's sign-up and the shared report
  // (docs/specs/ai-traffic-audit.md §17.4). The token is in the body, every
  // answer no-store (privacy review condition 3).
  if (pathname === "/admin/audit/open" && method === "POST") {
    return handleAuditOpen(request, env);
  }
  if (pathname === "/admin/audit/submit" && method === "POST") {
    return handleAuditSubmit(request, env, ctx);
  }
  if (pathname === "/admin/audit/report/public" && method === "POST") {
    return handleAuditReportPublic(request, env);
  }

  // All remaining /admin/* routes require a valid session.
  const user = await getSessionUser(request, env, ctx);
  if (!user) {
    return jsonWithCors({ error: "Unauthorized" }, env, 401);
  }

  // A session that may only set up two-step sign-in (its role requires it
  // and it is off) reaches these routes and nothing else.
  if (user.scope === "enrol" && !ENROL_ROUTES.has(`${method} ${pathname}`)) {
    return jsonWithCors(
      { error: "Set up two-step sign-in first.", code: "mfa_enrolment_required" },
      env,
      403,
    );
  }

  // Auth-gated route table
  if (pathname === "/admin/logout" && method === "POST") {
    return handleLogout(request, env);
  }

  if (pathname === "/admin/me" && method === "GET") {
    return handleMe(request, env, user);
  }

  // Sessions and two-step sign-in (security-hardening.md §1.3, §1.4).
  if (pathname === "/admin/sessions/revoke-all" && method === "POST") {
    return handleSessionsRevokeAll(request, env, user);
  }
  if (pathname === "/admin/mfa/status" && method === "GET") {
    return handleMfaStatus(request, env, user);
  }
  if (pathname === "/admin/mfa/enrol/start" && method === "POST") {
    return handleMfaEnrolStart(request, env, user, ctx);
  }
  if (pathname === "/admin/mfa/enrol/confirm" && method === "POST") {
    return handleMfaEnrolConfirm(request, env, user);
  }
  if (pathname === "/admin/mfa/recovery-codes" && method === "POST") {
    return handleMfaRecoveryCodes(request, env, user, ctx);
  }
  if (pathname === "/admin/mfa/disable" && method === "POST") {
    return handleMfaDisable(request, env, user, ctx);
  }
  if (pathname === "/admin/mfa/reset" && method === "POST") {
    return handleMfaReset(request, env, user, ctx);
  }

  // One customer's data: export and delete (security-hardening.md §2).
  // Superadmin only; the delete is never run by an agent against production.
  if (
    (pathname === "/admin/customers/export" || pathname === "/admin/customers/delete") &&
    user.role !== "superadmin"
  ) {
    return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
  }
  if (pathname === "/admin/customers/export" && method === "GET") {
    return handleCustomerExport(request, env);
  }
  if (pathname === "/admin/customers/delete" && method === "POST") {
    return handleCustomerDelete(request, env);
  }

  if (pathname === "/admin/verify" && method === "POST") {
    return handleVerify(request, env);
  }

  if (pathname === "/admin/customers/list" && method === "GET") {
    return handleCustomersList(request, env, user);
  }

  if (pathname === "/admin/customers/create" && method === "POST") {
    // Superadmin only — creating customers is an operator action.
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handleCustomersCreate(request, env);
  }

  if (pathname === "/admin/dna/get" && method === "GET") {
    return handleDnaGet(request, env, user);
  }

  if (pathname === "/admin/dna/upsert" && method === "POST") {
    return handleDnaUpsert(request, env, user, ctx);
  }

  if (pathname === "/admin/dna/suggest" && method === "GET") {
    return handleDnaSuggest(request, env, user);
  }

  if (pathname === "/admin/variants/list" && method === "GET") {
    return handleVariantsList(request, env, user);
  }

  if (pathname === "/admin/variant/get" && method === "GET") {
    return handleVariantGet(request, env, user);
  }

  if (pathname === "/admin/variants/stale-all" && method === "POST") {
    return handleVariantsStaleAll(request, env, user);
  }
  if (pathname === "/admin/variant/regenerate" && method === "POST") {
    return handleVariantRegenerate(request, env, user);
  }
  // A changed version waits for the customer's OK
  // (docs/specs/versions-approval.md). Customer-scoped.
  if (pathname === "/admin/variants/pending" && method === "GET") {
    return handlePendingList(request, env, user);
  }
  if (pathname === "/admin/variant/approve" && method === "POST") {
    return handleApprove(request, env, user);
  }
  if (pathname === "/admin/variants/approve-all" && method === "POST") {
    return handleApproveAll(request, env, user);
  }
  if (pathname === "/admin/variant/discard" && method === "POST") {
    return handleDiscard(request, env, user);
  }
  if (pathname === "/admin/customers/auto-approve" && method === "GET") {
    return handleAutoApproveGet(request, env, user);
  }
  if (pathname === "/admin/customers/auto-approve" && method === "POST") {
    return handleAutoApproveSet(request, env, user);
  }

  if (pathname === "/admin/onboard/detect" && method === "POST") {
    return handleOnboardDetect(request, env, user);
  }

  if (pathname === "/admin/onboard/confirm" && method === "POST") {
    return handleOnboardConfirm(request, env, user);
  }

  if (pathname === "/admin/onboard/manifest" && method === "GET") {
    return handleOnboardManifest(request, env, user);
  }

  // One button's "rewrite its words" switch (lib/button-rewrite.ts).
  if (pathname === "/admin/onboard/buttons" && method === "GET") {
    return handleButtonsGet(request, env, user);
  }

  if (pathname === "/admin/onboard/button" && method === "POST") {
    return handleButtonSet(request, env, user);
  }

  // Element-detection-v2 T2: operator-browser DOM capture for CSR sites.
  if (pathname === "/admin/onboard/capture-token" && method === "POST") {
    return handleCaptureToken(request, env, user);
  }

  if (pathname === "/admin/onboard/capture-status" && method === "GET") {
    return handleCaptureStatus(request, env, user);
  }

  // Script-first onboarding: capture → one chain → confirm.
  if (pathname === "/admin/onboard/quickstart" && method === "POST") {
    return handleQuickstart(request, env, user);
  }

  if (pathname === "/admin/onboard/quickstart" && method === "GET") {
    return handleQuickstartGet(request, env, user);
  }

  if (pathname === "/admin/onboard/go-live" && method === "POST") {
    return handleGoLive(request, env, user, ctx);
  }

  // The readiness check before go live and the special-category question
  // (docs/specs/readiness-check.md). Both customer-scoped.
  if (pathname === "/admin/onboard/readiness" && method === "GET") {
    return handleReadiness(request, env, user);
  }
  if (pathname === "/admin/customers/special-category" && method === "POST") {
    return handleSpecialCategorySet(request, env, user, ctx);
  }

  // Pick on the page (docs/specs/visual-picker.md).
  if (pathname === "/admin/onboard/pick-token" && method === "POST") {
    return handlePickToken(request, env, user);
  }

  if (pathname === "/admin/onboard/pick-status" && method === "GET") {
    return handlePickStatus(request, env, user);
  }

  // V2 Module 3: conversion target management
  if (pathname === "/admin/conversions/list" && method === "GET") {
    return handleConversionsList(request, env, user);
  }

  if (pathname === "/admin/conversions/upsert" && method === "POST") {
    return handleConversionsUpsert(request, env, user);
  }

  if (pathname === "/admin/conversions/confirm" && method === "POST") {
    return handleConversionsConfirm(request, env, user);
  }

  if (pathname === "/admin/conversions/delete" && method === "POST") {
    return handleConversionsDelete(request, env, user);
  }

  // "Count this button": one enabled target, the others disabled.
  if (pathname === "/admin/conversions/count" && method === "POST") {
    return handleConversionsCount(request, env, user);
  }

  // Count-only pick: the button to count, picked on the page (visual-picker.md §9).
  if (pathname === "/admin/conversions/pick-token" && method === "POST") {
    return handleCountPickToken(request, env, user);
  }

  if (pathname === "/admin/conversions/pick-status" && method === "GET") {
    return handleCountPickStatus(request, env, user);
  }

  // Page groups: a counted place over many pages (docs/specs/page-groups.md).
  if (pathname === "/admin/pages/groups" && method === "GET") {
    return handlePageGroupsGet(request, env, user);
  }

  if (pathname === "/admin/pages/groups" && method === "POST") {
    return handlePageGroupSet(request, env, user);
  }

  if (pathname === "/admin/pages/groups/delete" && method === "POST") {
    return handlePageGroupDelete(request, env, user);
  }

  // Snippet liveness probe; the Connect screen verifies the tag with it.
  if (pathname === "/admin/snippet-status/probe" && method === "POST") {
    return handleSnippetStatusProbe(request, env, user);
  }

  // The two-part tag for a live customer (docs/specs/faster-tag.md step 6).
  if (pathname === "/admin/install/pre" && method === "GET") {
    return handleInstallPreGet(request, env, user);
  }

  if (pathname === "/admin/install/pre/check" && method === "POST") {
    return handleInstallPreCheck(request, env, user);
  }

  // V2 Module 3 Batch C P1: invite a customer user (superadmin only).
  // The complementary /admin/customer-users/setup endpoint is public and
  // is handled above the auth gate.
  if (pathname === "/admin/customer-users/create" && method === "POST") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handleCustomerUsersCreate(request, env);
  }

  // A customer's users with their two-step state, for the superadmin's
  // reset (two-step mock, A2). Customer users only.
  if (pathname === "/admin/customer-users" && method === "GET") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handleCustomerUsersList(request, env);
  }

  // V2 Module 3 Batch C P6: analytics endpoints (customer + superadmin).
  if (pathname === "/admin/analytics/overview" && method === "GET") {
    return handleAnalyticsOverview(request, env, user);
  }

  if (pathname === "/admin/analytics/breakdown" && method === "GET") {
    return handleAnalyticsBreakdown(request, env, user);
  }

  if (pathname === "/admin/analytics/timeseries" && method === "GET") {
    return handleAnalyticsTimeseries(request, env, user);
  }

  // The Visitors page (docs/specs/visitors-page.md) and the country switch
  // (ADR 0036, point 6). Customer-scoped.
  if (pathname === "/admin/analytics/visitors" && method === "GET") {
    return handleVisitors(request, env, user);
  }
  if (pathname === "/admin/country/off" && method === "POST") {
    return handleCountrySwitch(request, env, user, true);
  }
  if (pathname === "/admin/country/on" && method === "POST") {
    return handleCountrySwitch(request, env, user, false);
  }
  // What direct is made of (ADR 0038, part 1): its own switch. Customer-scoped.
  if (pathname === "/admin/direct-insights/off" && method === "POST") {
    return handleDirectInsightsSwitch(request, env, user, true);
  }
  if (pathname === "/admin/direct-insights/on" && method === "POST") {
    return handleDirectInsightsSwitch(request, env, user, false);
  }

  // Visitors with no signal (ADR 0038 parts 3 to 5): the three switches.
  // Customer-scoped (docs/specs/direct-visitors.md §6).
  if (pathname === "/admin/customers/direct-switches" && (method === "GET" || method === "POST")) {
    return handleDirectSwitches(request, env, user);
  }

  // The visitor's own choice (ADR 0038 part 2; docs/specs/direct-visitors.md
  // §2). Customer-scoped; the kill switch superadmin only.
  if (pathname === "/admin/choice" && (method === "GET" || method === "POST")) {
    return handleChoice(request, env, user, "");
  }
  if (pathname === "/admin/choice/write" && method === "POST") {
    return handleChoice(request, env, user, "write");
  }
  if (pathname === "/admin/choice/preview-link" && method === "POST") {
    return handleChoice(request, env, user, "preview-link");
  }
  if (pathname === "/admin/choice/kill" && method === "POST") {
    return handleChoice(request, env, user, "kill");
  }

  // The proof engine (docs/specs/proof-engine.md, G). The lift report is
  // customer-scoped (its checks row goes to a superadmin only); the holdout
  // control, the weekly draft and the backfills are superadmin only.
  if (pathname === "/admin/analytics/lift" && method === "GET") {
    return handleLiftReport(request, env, user);
  }
  // The site map (docs/specs/site-shaped-intents.md §16): the Look row, the
  // Change dialog and its off switch, the Pages card's Write. Customer-scoped.
  if (pathname === "/admin/site-map" && method === "GET") {
    return handleSiteMapGet(request, env, user);
  }
  if (pathname === "/admin/site-map" && method === "POST") {
    return handleSiteMapSet(request, env, user, ctx);
  }
  if (pathname === "/admin/site-map/write" && method === "POST") {
    return handleSiteMapWrite(request, env, user, ctx);
  }
  // The customer's own test: start (20% only) and stop, customer-scoped.
  if (pathname === "/admin/proof/test" && method === "POST") {
    return handleCustomerTest(request, env, user);
  }
  // The keyword off switch (docs/specs/keyword-intent.md; privacy review 10e):
  // customer-scoped, a superadmin too, as the customer's own test above.
  if (pathname === "/admin/keywords/off" && method === "POST") {
    return handleKeywordsOff(request, env, user, ctx);
  }
  if (
    (pathname === "/admin/customers/holdout" ||
      pathname === "/admin/analytics/weekly" ||
      pathname === "/admin/proof/backfill") &&
    user.role !== "superadmin"
  ) {
    return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
  }
  // A customer whose site is about health or another special category
  // (docs/specs/sensitive-customers.md): the flag and the kept sections.
  if (pathname === "/admin/customers/sensitive" && user.role !== "superadmin") {
    return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
  }
  if (pathname === "/admin/customers/sensitive" && method === "GET") {
    return handleSensitiveGet(request, env);
  }
  if (pathname === "/admin/customers/sensitive" && method === "POST") {
    return handleSensitiveSet(request, env);
  }
  if (pathname === "/admin/customers/holdout" && method === "GET") {
    return handleHoldoutGet(request, env);
  }
  if (pathname === "/admin/customers/holdout" && method === "POST") {
    return handleHoldoutSet(request, env);
  }
  if (pathname === "/admin/analytics/weekly" && method === "GET") {
    return handleWeeklyDraft(request, env);
  }
  if (pathname === "/admin/proof/backfill" && method === "POST") {
    return handleProofBackfill(request, env);
  }

  // V2 Module 3 Batch C P6: portfolio endpoints (superadmin only).
  if (pathname === "/admin/portfolio/customers" && method === "GET") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handlePortfolioCustomers(request, env);
  }

  if (pathname === "/admin/portfolio/attention" && method === "GET") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handlePortfolioAttention(request, env);
  }

  // Snippet issues per page and code (aggregates only,
  // docs/specs/snippet-issues.md). A customer reads only its own pages
  // (privacy review condition 7: the data serves fixing that customer's pages).
  if (pathname === "/admin/health/issues" && method === "GET") {
    const scope = requireCustomerScope(user, url.searchParams.get("customer_id"));
    if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
    return handleHealthIssues(request, env);
  }

  // Pilot-lead inbox over D1.pilot_requests (superadmin only).
  if (pathname === "/admin/pilot-requests/list" && method === "GET") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handlePilotRequestsList(request, env);
  }

  if (pathname === "/admin/pilot-requests/update-status" && method === "POST") {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    return handlePilotRequestUpdateStatus(request, env);
  }

  // The free audit, signed in (docs/specs/ai-traffic-audit.md §17.4): the
  // customer's own Audit page, report and share link; the rest superadmin.
  if (pathname === "/admin/audit" && method === "GET") {
    return handleAuditStatus(request, env, user);
  }
  if (pathname === "/admin/audit/report" && method === "GET") {
    return handleAuditReport(request, env, user);
  }
  if (pathname === "/admin/audit/share-link" && method === "POST") {
    return handleAuditShareLink(request, env, user);
  }
  if (pathname.startsWith("/admin/audit/")) {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    if (pathname === "/admin/audit/summary" && method === "GET") return handleAuditSummary(env);
    if (pathname === "/admin/audit/review" && method === "GET") {
      return handleAuditReview(request, env);
    }
    if (method === "POST") {
      if (pathname === "/admin/audit/build") return handleAuditBuild(request, env);
      if (pathname === "/admin/audit/release") return handleAuditRelease(request, env);
      if (pathname === "/admin/audit/revoke") return handleAuditRevoke(request, env);
      if (pathname === "/admin/audit/end") return handleAuditEnd(request, env);
      if (pathname === "/admin/audit/pilot-terms") return handleAuditPilotTerms(request, env);
      if (pathname === "/admin/audit/make-pilot") return handleAuditMakePilot(request, env);
    }
  }

  // The invite email's deliverability test (superadmin only,
  // docs/specs/invite-email.md): the same message with a dummy link.
  if (pathname.startsWith("/admin/email/")) {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    if (pathname === "/admin/email/test" && method === "POST") {
      return handleEmailTest(request, env, user);
    }
  }

  // Pilot applications (superadmin only, docs/specs/pilot-apply.md).
  if (pathname.startsWith("/admin/applications/")) {
    if (user.role !== "superadmin") {
      return jsonWithCors({ error: "Forbidden: superadmin role required" }, env, 403);
    }
    if (pathname === "/admin/applications/invite" && method === "POST") {
      return handleApplicationsInvite(request, env, user);
    }
    if (pathname === "/admin/applications/list" && method === "GET") {
      return handleApplicationsList(request, env);
    }
    if (pathname === "/admin/applications/archive" && method === "POST") {
      return handleApplicationsArchive(request, env);
    }
    if (pathname === "/admin/applications/delete" && method === "POST") {
      return handleApplicationsDelete(request, env);
    }
  }

  return jsonWithCors({ error: "Not found" }, env, 404);
}
