/**
 * GET /admin/analytics/visitors?customer_id=&window=24h|7d|30d|90d
 *   &country=&source=&name=&version=&page=&version_by=version|source
 *   &device=&view=&landing=
 *
 * The Visitors page (docs/specs/visitors-page.md, the API contract):
 * visits, page views and counted clicks by source, country, page, version
 * and button, and country by version, source and page, filtered by one row
 * of any breakdown. Customer-scoped (a superadmin too), read-only, counts
 * only. Read live from the event rows (lib/visitors.ts). `direct` splits the
 * visits with no signal by landing page, country, device and in-app browser
 * (ADR 0038, part 1); `device`, `view` and `landing` narrow that panel only.
 */

import type { VisitorsVersionBy } from "@rawuser/shared";
import { sensitiveSettings } from "../lib/sensitive-pages.ts";
import {
  VisitorsFloorError,
  computeVisitors,
  isVisitorsWindow,
  parseDirectFilters,
  parseVisitorsFilters,
} from "../lib/visitors.ts";
import type { SessionUser } from "./auth.ts";
import { jsonWithCors } from "./cors.ts";
import type { AdminEnv } from "./handlers.ts";
import { requireCustomerScope } from "./scope.ts";

export async function handleVisitors(
  request: Request,
  env: AdminEnv,
  user: SessionUser,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams;
  const customerId = q.get("customer_id");
  const window = q.get("window") ?? "7d";
  const versionBy = q.get("version_by") ?? "version";

  const scope = requireCustomerScope(user, customerId);
  if (!scope.ok) return jsonWithCors({ error: scope.reason }, env, 403);
  if (!customerId) return jsonWithCors({ error: "customer_id is required" }, env, 400);
  if (!isVisitorsWindow(window)) {
    return jsonWithCors({ error: "window must be 24h, 7d, 30d or 90d" }, env, 400);
  }
  if (versionBy !== "version" && versionBy !== "source") {
    return jsonWithCors({ error: "version_by must be version or source" }, env, 400);
  }
  const parsed = parseVisitorsFilters(
    {
      country: q.get("country"),
      source: q.get("source"),
      name: q.get("name"),
      version: q.get("version"),
      page: q.get("page"),
    },
    versionBy as VisitorsVersionBy,
  );
  if (!parsed.ok) return jsonWithCors({ error: parsed.error }, env, 400);
  const direct = parseDirectFilters({
    device: q.get("device"),
    view: q.get("view"),
    landing: q.get("landing"),
  });
  if (!direct.ok) return jsonWithCors({ error: direct.error }, env, 400);

  const customer = await env.DB.prepare(
    "SELECT country_off, direct_insights_off FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{ country_off: number | null; direct_insights_off: number | null }>();
  if (!customer) return jsonWithCors({ error: "Customer not found" }, env, 404);

  try {
    const body = await computeVisitors(env.DB, {
      customerId,
      window,
      now,
      sensitive: await sensitiveSettings(env.DB, customerId),
      countryOff: Number(customer.country_off) === 1,
      filters: parsed.filters,
      versionBy: versionBy as VisitorsVersionBy,
      directOff: Number(customer.direct_insights_off) === 1,
      directFilters: direct.filters,
    });
    return jsonWithCors(body, env, 200);
  } catch (err) {
    if (err instanceof VisitorsFloorError) {
      return jsonWithCors({ error: err.message }, env, 400);
    }
    throw err;
  }
}
