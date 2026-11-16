/**
 * The server read first, the render only on a shell
 * (docs/specs/install-friction.md, A, "Where it is used").
 *
 * Every caller keeps its own server read (fetchPageHtml). When
 * that read comes back as a shell (under 80 characters of text: a Vite,
 * Lovable or v0 page that builds itself in the browser), renderIfShell
 * opens the page in Browser Run and returns the rendered HTML instead. A
 * server-rendered page costs nothing new.
 */

import { type InstallEnv, edgeOrigins, fetcherUserAgent } from "../install-config.ts";
import { type InstallFacts, installFacts } from "./install-facts.ts";
import { fetchOnHost } from "./public-url.ts";
import {
  MIN_TEXT_CHARS,
  type RenderDeps,
  type RenderEnv,
  RenderError,
  type RenderErrorKind,
  renderEnabled,
  renderPage,
  textLength,
} from "./render-page.ts";

export interface ReadOutcome {
  /** The HTML to use: the render's when it worked, else the server's. */
  html: string;
  source: "server" | "render";
  /** True when the server read was a shell and no render replaced it. */
  shell: boolean;
  /** Why the render did not replace the shell; absent when it did or was never tried. */
  render_error?: RenderErrorKind;
  /** CSP metas from the rendered DOM; in memory only. */
  meta_csp: string[];
}

/** A per-chain allowance of renders (the quickstart's secondary language pages get two). */
export interface RenderBudget {
  left: number;
}

/** True when cleaned server HTML has too little text to read: a page built in the browser. */
export function isShell(cleanedHtml: string): boolean {
  return textLength(cleanedHtml) < MIN_TEXT_CHARS;
}

/**
 * Returns the server HTML when it has text; otherwise renders the page,
 * when the render is on and the budget allows. Never throws: a failed
 * render leaves the shell and names the kind.
 */
export async function renderIfShell(
  serverHtml: string,
  url: string,
  env: RenderEnv,
  options: { budget?: RenderBudget; deps?: RenderDeps } = {},
): Promise<ReadOutcome> {
  const shellOutcome = (render_error?: RenderErrorKind): ReadOutcome => ({
    html: serverHtml,
    source: "server",
    shell: true,
    ...(render_error ? { render_error } : {}),
    meta_csp: [],
  });
  if (!isShell(serverHtml)) {
    return { html: serverHtml, source: "server", shell: false, meta_csp: [] };
  }
  if (!renderEnabled(env)) return shellOutcome();
  if (options.budget && options.budget.left <= 0) return shellOutcome();
  if (options.budget) options.budget.left--;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return shellOutcome("not_public");
  }
  try {
    const rendered = await renderPage(target, env, options.deps);
    return { html: rendered.html, source: "render", shell: false, meta_csp: rendered.meta_csp };
  } catch (e) {
    return shellOutcome(e instanceof RenderError ? e.kind : "failed");
  }
}

// ---------------------------------------------------------------------------
// Install facts from a server read (the apply submit)
// ---------------------------------------------------------------------------

const FACTS_TIMEOUT_MS = 10_000;
const FACTS_CAP_BYTES = 200 * 1024;

/** Reads at most `cap` bytes of a response body. */
export async function readCapped(resp: Response, cap: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= cap) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all).slice(0, cap);
}

/**
 * Platform, tag position and the CSP verdict with its lines for a public
 * page, from one guarded server read (every redirect hop checked and kept
 * on the typed host, lib/public-url.ts). The apply done screen shows the platform's step and,
 * when the policy would block the tag, the lines (spec G6). Null when the
 * page cannot be read; the screen then shows the plain steps.
 */
export async function fetchInstallFacts(
  url: URL,
  customerId: string,
  env: Pick<InstallEnv, "EDGE_ORIGIN" | "EDGE_ORIGIN_ALIASES" | "BOT_INFO_URL" | "SITE_RESOLVER">,
): Promise<InstallFacts | null> {
  try {
    // The typed host only (www and the apex as one): a redirect to another
    // host ends the read, never followed.
    const { resp, finalUrl: pageUrl } = await fetchOnHost(
      url,
      {
        headers: { "User-Agent": fetcherUserAgent(env), Accept: "text/html" },
        signal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
      },
      url.hostname,
      true,
      env.SITE_RESOLVER,
    );
    if (!resp.ok) return null;
    const html = await readCapped(resp, FACTS_CAP_BYTES);
    return installFacts({
      html,
      headers: resp.headers ?? null,
      pageUrl,
      customerId,
      edgeOrigins: edgeOrigins(env),
    });
  } catch {
    console.error("[rawuser/install] facts read failed (non-critical)");
    return null;
  }
}
