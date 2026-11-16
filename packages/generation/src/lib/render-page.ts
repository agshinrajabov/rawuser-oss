/**
 * Reads a page built in the browser with Cloudflare Browser Run
 * (docs/specs/install-friction.md, A).
 *
 * A Vite, Lovable or v0 site sends an empty shell to a server fetch, so the
 * apply read, the quickstart, the brief suggestions and the URL-first
 * detection used to see nothing. The render opens the page once in a
 * Cloudflare-hosted browser and reads its text. It runs only after a server
 * read came back as a shell (lib/read-page.ts), never for a visitor, never
 * on the visitor path: offline, at the customer's, applicant's or
 * operator's request.
 *
 * Privacy-privacy review ruling 2026-10-03, the conditions this file carries:
 *
 *   1. Logs. Never err.message, never the page's console or pageerror
 *      (Puppeteer errors carry URLs). A failure logs one of the six kinds
 *      and an 8-character digest of the URL. No console or pageerror
 *      listener is ever attached.
 *   2. Isolation. Service workers bypassed; WebSocket, WebTransport and
 *      EventSource (and Worker, SharedWorker, whose requests the page's
 *      interception does not see) removed before any page script runs;
 *      every main-frame navigation, redirect hops included, goes through
 *      assertPublicUrl (DNS, fail closed) and must stay on the page's own
 *      host (www and the apex as one; another host ends the render as
 *      `off_host`, never loaded); subframe navigations and
 *      subresources are checked by syntax. No stealth plugin, no user-agent
 *      change, no challenge solving: a challenge page is `blocked`, final.
 *   3. No fake visit. Every request to a Rawuser host (lib/own-hosts.ts) is
 *      aborted, so a page that already carries our tag can never call
 *      /select or /event from here. The edge's own bot path for Browser
 *      Run's headers is the second layer (edge pass).
 *
 * Confirmed at build (2026-10-04): request interception in
 * @cloudflare/puppeteer 1.4.0 emits one `request` per redirect hop, each a
 * main-frame navigation request, so the hop check holds inside the browser.
 * Browser Run is enabled on the account (Workers Paid limits: 200
 * concurrent sessions). Its session history keeps the session id, start and
 * end time and the close reason; no address, no content.
 *
 * The rendered HTML lives in memory only: cleaned, capped and handed to the
 * same code as a server read. It is never stored here and never logged.
 */

import puppeteer from "@cloudflare/puppeteer";
import { stripNonContent } from "@rawuser/shared";
import { sendAlert } from "./alert.ts";
import { metaCspFromHtml } from "./csp.ts";
import { type OwnHostsEnv, isOwnHost, ownHosts } from "./own-hosts.ts";
import { NotPublicUrlError, assertPublicUrl, publicUrlProblem, sameSite } from "./public-url.ts";

export type RenderErrorKind =
  | "not_public"
  | "off_host"
  | "timeout"
  | "blocked"
  | "empty"
  | "failed";

export class RenderError extends Error {
  constructor(readonly kind: RenderErrorKind) {
    super(kind);
    this.name = "RenderError";
  }
}

/** The binding as the Workers runtime gives it; @cloudflare/puppeteer's BrowserWorker. */
export interface BrowserBinding {
  fetch: typeof fetch;
}

/** With the install's own hosts (OwnHostsEnv): the render never calls them. */
export interface RenderEnv extends OwnHostsEnv {
  /** [browser] binding = "BROWSER" in wrangler.toml. Absent: no render. */
  BROWSER?: BrowserBinding;
  /** "off" turns the render off without a deploy of code. Anything else, or unset: on. */
  BROWSER_RUN?: string;
  VARIANTS: KVNamespace;
  ALERT_WEBHOOK_URL?: string;
}

export interface RenderResult {
  /** Cleaned, capped at 50 KB: the same shape as fetchPageHtml's answer. */
  html: string;
  /** Every Content-Security-Policy meta in the rendered DOM (a meta added by script counts). In memory only. */
  meta_csp: string[];
  ms: number;
}

// ---------------------------------------------------------------------------
// The browser, as narrow as we use it (a fake implements it in tests)
// ---------------------------------------------------------------------------

export interface RenderRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  resourceType(): string;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface RenderPage {
  setBypassServiceWorker(bypass: boolean): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  evaluateOnNewDocument(fn: () => void): Promise<unknown>;
  on(event: "request", handler: (request: RenderRequest) => void): unknown;
  mainFrame(): unknown;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<{ status(): number } | null>;
  waitForFunction(fn: () => boolean, options: { timeout: number }): Promise<unknown>;
  title(): Promise<string>;
  content(): Promise<string>;
}

export interface RenderBrowser {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

/** The two DOM members the wait reads, typed here because the worker has no DOM lib. */
interface PageDocument {
  body: { innerText: string } | null;
  querySelector(selector: string): unknown;
}

export type Launcher = (binding: BrowserBinding) => Promise<RenderBrowser>;

export interface RenderDeps {
  launch?: Launcher;
  assertPublic?: (url: URL) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The whole call's cap; tests shorten it. */
  hardCapMs?: number;
}

// ---------------------------------------------------------------------------
// Limits (spec A, "The function")
// ---------------------------------------------------------------------------

/** Launch, load, wait and read, all of it. */
export const RENDER_HARD_CAP_MS = 25_000;
export const GOTO_TIMEOUT_MS = 15_000;
/** Wait for 200 characters of text or an h1, at most this long. */
export const WAIT_FOR_TEXT_MS = 8_000;
/** Then let the page settle (the capture mode waits 1,500 ms after load). */
export const SETTLE_MS = 750;
/** page.content() is cut here before cleaning. */
export const RAW_CAP_BYTES = 2 * 1024 * 1024;
/** The existing cap on cleaned HTML (detect-elements.ts). */
export const CLEAN_CAP_BYTES = 50 * 1024;
/** Under this many characters of text the render read nothing. */
export const MIN_TEXT_CHARS = 80;
/** Renders a UTC day for the whole account; over it, renders fail as `failed`. */
export const DAILY_RENDER_CEILING = 300;

const RENDER_DAY_PREFIX = "render:day:";
const RENDER_CAP_ALERT_KEY = "ops:alert:render-cap";
const DAY_S = 24 * 60 * 60;

/** Requests the render never makes: we read text. */
const SKIPPED_TYPES = new Set(["image", "media", "font", "websocket", "eventsource"]);

/**
 * Runs in every frame before the page's own scripts: the transports
 * request interception cannot see are removed. Must stay self-contained
 * (it is serialised into the browser).
 */
export function disableUnseenTransports(): void {
  const names = ["WebSocket", "WebTransport", "EventSource", "Worker", "SharedWorker"];
  for (const name of names) {
    try {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      // already non-configurable in this frame; nothing more we can do
    }
  }
}

/** True when the binding is there and the flag is not "off". */
export function renderEnabled(env: Pick<RenderEnv, "BROWSER" | "BROWSER_RUN">): boolean {
  return Boolean(env.BROWSER) && (env.BROWSER_RUN ?? "").toLowerCase() !== "off";
}

// ---------------------------------------------------------------------------
// Bot challenges (shared with the server read, lib/read-page.ts)
// ---------------------------------------------------------------------------

/** A bot check by its own words: enough on a 200 page. */
const STRONG_CHALLENGE = [
  /<title>\s*just a moment\.{0,3}\s*<\/title>/i,
  /<title>\s*attention required!?\s*\|\s*cloudflare\s*<\/title>/i,
  /<title>\s*vercel security checkpoint\s*<\/title>/i,
];
/**
 * Markers that also appear on normal pages (Cloudflare's JavaScript
 * detections inject /cdn-cgi/challenge-platform/ into ordinary pages): they
 * count only on an error status.
 */
const WEAK_CHALLENGE = [
  /\/cdn-cgi\/challenge-platform\//i,
  /\bcf-chl-[a-z]|_cf_chl_opt/i,
  /vercel security checkpoint/i,
  /<title>\s*access denied\s*<\/title>/i,
];

/** A page that is a bot check, not the site. Status 403 or 429 counts on its own. */
export function looksLikeChallenge(input: {
  status?: number;
  title?: string;
  html?: string;
  headers?: Headers | null;
}): boolean {
  const status = input.status ?? 200;
  if (status === 403 || status === 429) return true;
  const mitigated = `${input.headers?.get("cf-mitigated") ?? ""} ${input.headers?.get("x-vercel-mitigated") ?? ""}`;
  if (/challenge/i.test(mitigated)) return true;
  const title = input.title ?? "";
  if (/^\s*(just a moment|attention required|vercel security checkpoint)/i.test(title)) return true;
  const html = input.html ?? "";
  if (STRONG_CHALLENGE.some((re) => re.test(html))) return true;
  return status >= 400 && WEAK_CHALLENGE.some((re) => re.test(html));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First 8 hex characters of the URL's SHA-1: correlates log lines without the URL. */
export async function urlDigest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

/** Visible text length of cleaned HTML, the same measure as the apply read's shell check. */
export function textLength(cleaned: string): number {
  return cleaned
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Takes one render from today's ceiling. Counts attempts, not successes,
 * so a run of failures cannot spend browser time without bound. One KV read
 * and one write per render: a few hundred writes a day at most.
 */
async function takeRenderSlot(env: RenderEnv, now: number): Promise<boolean> {
  const key = `${RENDER_DAY_PREFIX}${utcDay(now)}`;
  const used = Number.parseInt((await env.VARIANTS.get(key)) ?? "0", 10) || 0;
  if (used >= DAILY_RENDER_CEILING) return false;
  await env.VARIANTS.put(key, String(used + 1), { expirationTtl: 2 * DAY_S });
  return true;
}

/** One line a day to the ops channel when the ceiling is reached. */
async function alertRenderCap(env: RenderEnv): Promise<void> {
  if (await env.VARIANTS.get(RENDER_CAP_ALERT_KEY)) return;
  await env.VARIANTS.put(RENDER_CAP_ALERT_KEY, "1", { expirationTtl: DAY_S });
  console.error("[rawuser/render] render-cap: daily ceiling reached");
  await sendAlert(
    env.ALERT_WEBHOOK_URL,
    `render-cap: ${DAILY_RENDER_CEILING} page renders today. Pages built in the browser are not read until 00:00 UTC.`,
  );
}

const defaultLauncher: Launcher = async (binding) =>
  (await puppeteer.launch(binding)) as unknown as RenderBrowser;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

// ---------------------------------------------------------------------------
// renderPage
// ---------------------------------------------------------------------------

/**
 * Opens a public page in Browser Run and returns its cleaned HTML. Throws
 * RenderError with one of six kinds; never anything else.
 */
export async function renderPage(
  url: URL,
  env: RenderEnv,
  deps: RenderDeps = {},
): Promise<RenderResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const digest = await urlDigest(url.toString());
  const fail = (kind: RenderErrorKind): never => {
    // Condition 1: the kind and the digest, nothing else.
    console.error(`[rawuser/render] ${kind} url_id=${digest}`);
    throw new RenderError(kind);
  };

  const binding = env.BROWSER;
  if (!binding || !renderEnabled(env)) return fail("failed");
  // Read once: the hosts the page may not call from inside the render.
  const own = ownHosts(env);

  if (publicUrlProblem(url)) return fail("not_public");
  try {
    await (deps.assertPublic ?? assertPublicUrl)(url);
  } catch (e) {
    return fail(e instanceof NotPublicUrlError ? "not_public" : "failed");
  }

  if (!(await takeRenderSlot(env, now()))) {
    await alertRenderCap(env);
    return fail("failed");
  }

  const launch = deps.launch ?? defaultLauncher;
  const assertPublic = deps.assertPublic ?? assertPublicUrl;
  const sleep = deps.sleep ?? defaultSleep;
  let browser: RenderBrowser | null = null;
  let launching: Promise<RenderBrowser> | null = null;
  let refused = false;
  /** A main-frame navigation left the page's own host. */
  let offHost = false;

  const work = async (): Promise<RenderResult> => {
    launching = launch(binding);
    browser = await launching;
    const page = await browser.newPage();
    await page.setBypassServiceWorker(true);
    await page.evaluateOnNewDocument(disableUnseenTransports);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void screen(request, page).catch(() => {
        // a request the page already dropped; nothing to resolve
      });
    });

    let status = 0;
    try {
      const response = await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: GOTO_TIMEOUT_MS,
      });
      status = response?.status() ?? 0;
    } catch (e) {
      if (offHost) throw new RenderError("off_host");
      if (refused) throw new RenderError("not_public");
      throw new RenderError(isTimeoutError(e) ? "timeout" : "failed");
    }
    if (offHost) throw new RenderError("off_host");
    if (refused) throw new RenderError("not_public");
    if (status === 403 || status === 429) throw new RenderError("blocked");

    await page
      .waitForFunction(
        () => {
          // Runs in the browser; the worker's types have no DOM.
          const doc = (globalThis as unknown as { document: PageDocument }).document;
          return (doc.body?.innerText ?? "").length >= 200 || doc.querySelector("h1") !== null;
        },
        { timeout: WAIT_FOR_TEXT_MS },
      )
      .catch(() => {
        // read what is there; the empty check below decides
      });
    await sleep(SETTLE_MS);
    if (offHost) throw new RenderError("off_host");
    if (refused) throw new RenderError("not_public");

    const title = await page.title().catch(() => "");
    const raw = (await page.content()).slice(0, RAW_CAP_BYTES);
    if (looksLikeChallenge({ status, title, html: raw })) throw new RenderError("blocked");

    const cleaned = stripNonContent(raw);
    const html = cleaned.length > CLEAN_CAP_BYTES ? cleaned.slice(0, CLEAN_CAP_BYTES) : cleaned;
    if (textLength(html) < MIN_TEXT_CHARS) throw new RenderError("empty");
    return { html, meta_csp: metaCspFromHtml(raw), ms: now() - started };
  };

  /** Interception: one decision per request, the privacy review's rules in order. */
  const screen = async (request: RenderRequest, page: RenderPage): Promise<void> => {
    let target: URL;
    try {
      target = new URL(request.url());
    } catch {
      await request.abort("blockedbyclient");
      return;
    }
    if (
      target.protocol === "data:" ||
      target.protocol === "blob:" ||
      target.protocol === "about:"
    ) {
      await request.continue();
      return;
    }
    if (isOwnHost(target.hostname, own)) {
      await request.abort("blockedbyclient");
      return;
    }
    if (SKIPPED_TYPES.has(request.resourceType())) {
      await request.abort("blockedbyclient");
      return;
    }
    const frame = request.frame();
    const mainNavigation =
      request.isNavigationRequest() && (frame === null || frame === page.mainFrame());
    if (mainNavigation) {
      // Every hop of the document, redirects included: the page's own host
      // only (the /bot page), then syntax and DNS.
      if (!sameSite(target.hostname, url.hostname)) {
        offHost = true;
        await request.abort("blockedbyclient");
        return;
      }
      try {
        if (publicUrlProblem(target)) throw new NotPublicUrlError("syntax");
        await assertPublic(target);
      } catch {
        refused = true;
        await request.abort("blockedbyclient");
        return;
      }
      await request.continue();
      return;
    }
    // Subframe navigations and subresources: syntax only (a DNS lookup per
    // request would cost seconds).
    if (publicUrlProblem(target)) {
      await request.abort("blockedbyclient");
      return;
    }
    await request.continue();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RenderError("timeout")),
      deps.hardCapMs ?? RENDER_HARD_CAP_MS,
    );
  });
  const running = work();
  running.catch(() => {
    // the race below reports it; this only keeps a late rejection quiet
  });
  try {
    const result = await Promise.race([running, capped]);
    console.log(`[rawuser/render] ok url_id=${digest} ms=${result.ms}`);
    return result;
  } catch (e) {
    return fail(e instanceof RenderError ? e.kind : "failed");
  } finally {
    clearTimeout(timer);
    const open = browser as RenderBrowser | null;
    if (open) {
      await open.close().catch(() => {});
    } else if (launching) {
      // The cap fired while the browser was still starting: close it when it arrives.
      (launching as Promise<RenderBrowser>).then((b) => b.close()).catch(() => {});
    }
  }
}
