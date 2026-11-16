/**
 * detectElements: AI-powered element auto-detection for the onboarding flow.
 *
 * Fetches a customer's public landing page HTML, sends it to the model of
 * the `detect` role (once per page), and returns a Manifest mapping section
 * dot-paths to three resilient selector types per element.
 *
 * This function runs OFFLINE only (operator-initiated, admin endpoint).
 * It MUST NOT be imported by packages/edge: the edge's bundle test enforces
 * this by reading the built worker for the model layer's own strings.
 *
 * Privacy invariants:
 * - fetchPageHtml does NOT log the URL or HTML body. On failure, only a
 *   constant error string + 8-char SHA-1 prefix of the URL is logged, so
 *   multiple failures can be correlated without leaking the URL itself.
 * - The full HTML is consumed in-memory only; never written to D1 or KV.
 * - The manifest stores CSS selectors and text signatures (first 30 chars of
 *   public marketing copy): this is the customer's own public content, not PII.
 * - Detection is operator-initiated against a public URL (no visitor sessions).
 *   If the target URL is gated (login required), detection should be skipped;
 *   callers are responsible for passing only public URLs. The admin endpoint
 *   documents this constraint.
 */

import type { ElementTargets, Manifest } from "@rawuser/shared";
import { stripNonContent } from "@rawuser/shared";
import { callWithTimeout } from "./call-model.ts";
import type { GenerateEnv } from "./generateVariant.ts";
import { generateVariant } from "./generateVariant.ts";
import { fetchOnHost } from "./lib/public-url.ts";
import type { SiteResolver } from "./lib/public-url.ts";
import { looksLikeChallenge } from "./lib/render-page.ts";
import { buildDetectionPreamble, buildDetectionUserPrompt } from "./prompts/element-detection.ts";

// Re-export so callers in this package can import from a single location.
export type { ElementTargets, Manifest };

/**
 * The longest a detection may take. 4,096 output tokens on a slow model run
 * past a minute; past this the request is not coming back.
 */
export const DETECT_TIMEOUT_MS = 120_000;

export interface DetectResult {
  manifest: Manifest;
  cost_usd: number;
  source_html_bytes: number;
}

const SIZE_CAP_BYTES = 50 * 1024; // truncate CLEANED HTML at 50KB
const FETCH_TIMEOUT_MS = 15_000; // 15s timeout on fetchPageHtml

/**
 * Strips non-content markup before the HTML reaches the LLM (T1a). The
 * implementation lives in @rawuser/shared (capture.ts) because the edge's
 * capture route applies the same diet; this name stays for callers here.
 */
export const cleanHtml = stripNonContent;

/**
 * The server answered with an error, or with a bot check instead of the
 * page (docs/specs/install-friction.md, C). The message keeps the old form
 * ("HTTP 403 fetching page"); `challenge` tells bot protection apart.
 */
export class PageFetchError extends Error {
  constructor(
    readonly status: number,
    readonly challenge: boolean,
  ) {
    super(
      challenge && status < 300 ? "Bot check instead of the page" : `HTTP ${status} fetching page`,
    );
    this.name = "PageFetchError";
  }
}

/**
 * Fetches a public URL and returns the HTML body, truncated at SIZE_CAP_BYTES.
 *
 * Redirects are followed by hand and only on one site: `sameHostAs`, or the
 * URL's own host when absent, with `www.` and the apex counted as one. A
 * hop to any other host throws OffHostRedirectError and is never fetched
 * (docs/specs/site-shaped-intents.md §13.2 point 4; the /bot page says so).
 *
 * Privacy note: on fetch failure we log only a constant string plus the first
 * 8 hex chars of the URL's SHA-1 digest: enough to correlate logs without
 * revealing the actual URL.
 */
export async function fetchPageHtml(
  url: string,
  options: {
    /**
     * The fetcher's user agent (install-config.ts, fetcherUserAgent). Asked
     * of every caller, so no read goes out under an agent the install did
     * not configure.
     */
    userAgent: string;
    /**
     * Refuse private, loopback and link-local hosts on every hop
     * (lib/public-url.ts). Set for reads a customer starts from outside the
     * team, the apply page (docs/specs/pilot-apply.md, 2026-10-01); a
     * refusal throws NotPublicUrlError.
     */
    publicOnly?: boolean;
    /**
     * The customer's recorded host. Every hop, the first included, must be
     * on it (`www.` folded) or the read ends with OffHostRedirectError.
     * Default: the URL's own host.
     */
    sameHostAs?: string;
    /** The cleaned HTML's cap; default 50 KB. */
    maxBytes?: number;
    /** The install's own resolver for the public-address check, where it has one. */
    resolver?: SiteResolver;
  },
): Promise<string> {
  // Validate URL: http/https only.
  const parsed = new URL(url); // throws if malformed
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs supported");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const init: RequestInit = {
      headers: { "User-Agent": options.userAgent, Accept: "text/html" },
      signal: controller.signal,
    };
    const { resp } = await fetchOnHost(
      parsed,
      init,
      options.sameHostAs ?? parsed.hostname,
      options.publicOnly === true,
      options.resolver,
    );

    if (!resp.ok) {
      // Do not log the URL: log a safe constant plus a URL digest prefix.
      const urlDigest = await sha1Prefix(url);
      console.error(`[rawuser/detect] fetch failed (non-critical) url_id=${urlDigest}`);
      const body = resp.status === 503 ? (await resp.text().catch(() => "")).slice(0, 65_536) : "";
      const headers = (resp.headers as Headers | undefined) ?? null;
      throw new PageFetchError(
        resp.status,
        looksLikeChallenge({ status: resp.status, headers, html: body }),
      );
    }

    const text = await resp.text();
    // A bot check can answer 200 too; it is not the customer's page.
    if (
      looksLikeChallenge({
        headers: (resp.headers as Headers | undefined) ?? null,
        html: text.slice(0, 65_536),
      })
    ) {
      const urlDigest = await sha1Prefix(url);
      console.error(
        `[rawuser/detect] bot check instead of the page (non-critical) url_id=${urlDigest}`,
      );
      throw new PageFetchError(resp.status, true);
    }
    // Clean FIRST, then cap: the 50KB budget should buy content, not scripts.
    const cleaned = cleanHtml(text);
    const cap = options.maxBytes ?? SIZE_CAP_BYTES;
    return cleaned.length > cap ? cleaned.slice(0, cap) : cleaned;
  } catch (err) {
    // Re-throw AbortError and other errors, but sanitize the log.
    if (err instanceof Error && err.name === "AbortError") {
      const urlDigest = await sha1Prefix(url);
      console.error(`[rawuser/detect] fetch timeout (non-critical) url_id=${urlDigest}`);
      throw new Error("Page fetch timed out");
    }
    // For non-HTTP errors (network, DNS) rethrow as-is: the message is safe.
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the page HTML to the model and returns the parsed manifest.
 *
 * Detection has its own role because its quality matters more than its
 * price: wrong selectors shipped to visitors degrade the page, and the call
 * is made once per page. MODEL_ID_DETECT names a stronger model for it;
 * unset, it runs on the writer's.
 *
 * One call, as it always was: no tier of an outage. A fallback or the spare
 * route would read the page with another model than the one chosen for
 * detection, and nobody would be told. It runs under a time limit all the
 * same: a model that takes the request and sends nothing back once left
 * the apply page on "Reading your page..." for as long as the browser
 * waited (2026-10-02).
 *
 * The preamble is the same for every customer, so a provider that caches a
 * repeated prefix reads it from its cache on the second page.
 */
export async function detectElements(html: string, env: GenerateEnv): Promise<DetectResult> {
  const systemPreamble = buildDetectionPreamble();
  const userPrompt = buildDetectionUserPrompt(html);

  const call = await callWithTimeout(
    () =>
      generateVariant(
        {
          prompt: userPrompt,
          cachedPreamble: systemPreamble,
          role: "detect", // its own model id when MODEL_ID_DETECT is set; once per page
          maxTokens: 4096,
        },
        env,
      ),
    DETECT_TIMEOUT_MS,
  );
  if (!call.ok) throw new Error(call.error);
  const result = call.value;

  const manifest = parseAndValidateManifest(result.text);

  return {
    manifest,
    cost_usd: result.costUsd,
    source_html_bytes: html.length,
  };
}

/**
 * Strips any leading non-JSON content, parses the response, and validates
 * each entry against the ElementTargets shape.
 *
 * Throws a descriptive Error on any validation failure so the caller
 * (admin endpoint) can return a useful 422/500 without leaking internals.
 */
export function parseAndValidateManifest(text: string): Manifest {
  // Strip any accidental leading/trailing text before the first '{'.
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Manifest parse failed: no JSON object found in model output");
  }
  const jsonEnd = text.lastIndexOf("}");
  if (jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error("Manifest parse failed: unmatched braces in model output");
  }

  const jsonSlice = text.slice(jsonStart, jsonEnd + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Manifest parse failed: invalid JSON: ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Manifest parse failed: expected a JSON object at the top level");
  }

  const manifest: Manifest = {};
  for (const [path, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(`Manifest validation failed: invalid section path key "${path}"`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Manifest validation failed: entry for "${path}" must be an object, got ${typeof entry}`,
      );
    }

    const e = entry as Record<string, unknown>;

    // css: required, non-empty string[]
    if (!Array.isArray(e.css) || e.css.length === 0) {
      throw new Error(
        `Manifest validation failed: "${path}.css" must be a non-empty array of strings`,
      );
    }
    for (const sel of e.css) {
      if (typeof sel !== "string") {
        throw new Error(`Manifest validation failed: "${path}.css" contains a non-string value`);
      }
    }

    // text: required, string[] (may be empty)
    if (!Array.isArray(e.text)) {
      throw new Error(`Manifest validation failed: "${path}.text" must be an array of strings`);
    }
    for (const sel of e.text) {
      if (typeof sel !== "string") {
        throw new Error(`Manifest validation failed: "${path}.text" contains a non-string value`);
      }
    }

    // structural: required, non-empty string
    if (typeof e.structural !== "string" || e.structural.trim() === "") {
      throw new Error(
        `Manifest validation failed: "${path}.structural" must be a non-empty string`,
      );
    }

    // original_char_length / original_word_count: optional, non-negative integers.
    // Treat invalid or missing values as undefined: generation falls back to
    // no length constraint (backward compatible with pre-D6.2 manifests).
    const charLength =
      typeof e.original_char_length === "number" &&
      Number.isFinite(e.original_char_length) &&
      e.original_char_length >= 0
        ? Math.round(e.original_char_length)
        : undefined;
    const wordCount =
      typeof e.original_word_count === "number" &&
      Number.isFinite(e.original_word_count) &&
      e.original_word_count >= 0
        ? Math.round(e.original_word_count)
        : undefined;

    // conversion_candidate: optional boolean (V2 Module 3). Absent on legacy
    // manifests; seeded by the operator review screen for the new ones.
    const conversionCandidate =
      typeof e.conversion_candidate === "boolean" ? e.conversion_candidate : undefined;

    manifest[path] = {
      css: e.css as string[],
      text: e.text as string[],
      structural: e.structural,
      ...(charLength !== undefined ? { original_char_length: charLength } : {}),
      ...(wordCount !== undefined ? { original_word_count: wordCount } : {}),
      ...(conversionCandidate !== undefined ? { conversion_candidate: conversionCandidate } : {}),
    };
  }

  return manifest;
}

/**
 * Returns the first 8 hex characters of a SHA-1 digest of the input string.
 * Used for privacy-safe logging: correlates log entries without leaking the URL.
 */
async function sha1Prefix(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}
