/**
 * Rendered-DOM capture, shared by the edge and the generation worker.
 *
 * The operator's own browser sends the rendered HTML of their own public
 * page, once, under a one-time token an authenticated operator minted
 * (element-detection-v2, script-first-onboarding). Both workers bind the
 * same KV namespace, so the key shapes and the receive logic live here and
 * neither worker carries the other's code (bundle invariant, ADR 0003).
 *
 * Privacy: KV only, fifteen minutes, single use, script/style/svg/iframe
 * stripped before storage, 200 KB cap. Nothing about a visitor is involved;
 * a visitor never holds a token. The `capture:` prefix is never read by the
 * visitor path (/select), which a test pins.
 */

export const CAPTURE_TTL_S = 15 * 60;
/** Raw payload cap (pre-clean). */
export const CAPTURE_MAX_RAW_BYTES = 512 * 1024;
/** Stored capture cap (post-clean), the budget detection reads. */
export const CAPTURE_MAX_STORED_BYTES = 200 * 1024;
/** Query parameter the snippet watches for; the value is the one-time token. */
export const CAPTURE_PARAM = "rawuser_capture";

export function captureTokenKey(token: string): string {
  return `capture-token:${token}`;
}

export function captureKey(customerId: string, pagePath: string): string {
  return `capture:${customerId}:${pagePath}`;
}

/** An input whose `value` is the label the page shows on it. */
const LABEL_INPUT = /\btype\s*=\s*["']?(?:submit|button|reset)\b/i;
const VALUE_ATTR = /\s(?:value|data-value)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;

/**
 * Takes out what a form field holds: the `value` of every input that is not
 * a button, and the text of every textarea. A page sent from the operator's
 * own browser is the page as that browser shows it, and a signed-in page
 * carries a name, an address or a hidden session token in its fields. None
 * of it is page copy, so none of it is stored or shown to a model. A
 * button's `value` stays: it is the words on the button. Placeholders stay.
 */
export function stripFieldValues(html: string): string {
  return (
    html
      // A tag ends at the first ">" outside a quoted value.
      .replace(/<input\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, (tag) =>
        LABEL_INPUT.test(tag) ? tag : tag.replace(VALUE_ATTR, ""),
      )
      .replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea\s*>)/gi, "$1$2")
  );
}

/**
 * Strips non-content markup (comments, script, style, noscript, svg,
 * iframe, link) and what form fields hold, and collapses whitespace. Regex
 * on purpose: Workers have no DOM, and a token diet does not need a parser.
 */
export function stripNonContent(html: string): string {
  return (
    stripFieldValues(html)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "")
      .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, "")
      .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
      // Keep hreflang alternates: they declare the site's languages
      // (docs/specs/per-language.md); every other <link> is dropped.
      .replace(/<link\b(?![^>]*\bhreflang)[^>]*>/gi, "")
      .replace(/[ \t\r\n]{2,}/g, " ")
  );
}

/** The subset of KVNamespace the capture flow touches. */
export interface CaptureStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CaptureTokenMeta {
  customer_id: string;
  page_path: string;
}

export type CaptureOutcome =
  | { status: 200; body: { ok: true; page_path: string; customer_id: string; bytes: number } }
  | { status: 400 | 403 | 413 | 500; body: { error: string } };

/**
 * Validates a capture payload against its one-time token, stores the
 * cleaned HTML under the customer/path key, burns the token. Pure with
 * respect to HTTP so each worker wraps it in its own CORS envelope.
 */
export async function receiveCapture(
  payload: unknown,
  store: CaptureStore,
): Promise<CaptureOutcome> {
  const params = (payload ?? {}) as { token?: unknown; html?: unknown };
  if (typeof params.token !== "string" || params.token.length === 0 || params.token.length > 64) {
    return { status: 400, body: { error: "token is required" } };
  }
  if (typeof params.html !== "string" || params.html.length === 0) {
    return { status: 400, body: { error: "html is required" } };
  }
  if (params.html.length > CAPTURE_MAX_RAW_BYTES) {
    return { status: 413, body: { error: "html too large" } };
  }

  const tokenKey = captureTokenKey(params.token);
  const meta = await store.get(tokenKey);
  if (meta === null) {
    return { status: 403, body: { error: "invalid or expired token" } };
  }

  let parsed: CaptureTokenMeta;
  try {
    parsed = JSON.parse(meta) as CaptureTokenMeta;
  } catch {
    return { status: 500, body: { error: "invalid token state" } };
  }

  // Clean server-side too (the sender also strips), then cap at the stored budget.
  const cleaned = stripNonContent(params.html).slice(0, CAPTURE_MAX_STORED_BYTES);
  await store.put(captureKey(parsed.customer_id, parsed.page_path), cleaned, {
    expirationTtl: CAPTURE_TTL_S,
  });
  // Single use: a leaked token cannot overwrite later.
  await store.delete(tokenKey);

  return {
    status: 200,
    body: {
      ok: true,
      page_path: parsed.page_path,
      customer_id: parsed.customer_id,
      bytes: cleaned.length,
    },
  };
}
