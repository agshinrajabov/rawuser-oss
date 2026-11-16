/**
 * CORS header helpers for admin endpoints.
 *
 * Production: CORS is restricted to the DASHBOARD_ORIGIN env var.
 * Dev: falls back to "*" for ergonomics. Never wildcard in production.
 */

export interface CorsEnv {
  DASHBOARD_ORIGIN: string;
  ENVIRONMENT?: string;
}

/**
 * Returns the CORS origin to allow.
 * Production: must be set to the dashboard URL. Dev: falls back to "*".
 */
export function getAllowedOrigin(env: CorsEnv): string {
  if (env.DASHBOARD_ORIGIN && env.DASHBOARD_ORIGIN !== "") {
    return env.DASHBOARD_ORIGIN;
  }
  // Dev fallback — acceptable locally, blocked in production by the wrangler check
  return "*";
}

/**
 * Build CORS response headers for admin endpoints.
 */
export function corsHeaders(env: CorsEnv): Record<string, string> {
  return {
    "access-control-allow-origin": getAllowedOrigin(env),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Rawuser-Admin",
    "access-control-max-age": "86400",
  };
}

/** Respond to CORS preflight. */
export function preflightResponse(env: CorsEnv): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env),
  });
}

/** Wrap a JSON payload with CORS headers. */
export function jsonWithCors(payload: unknown, env: CorsEnv, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(env),
    },
  });
}
