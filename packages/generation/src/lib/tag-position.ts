/**
 * Where our tag sits on the page, and what delays it
 * (docs/specs/install-friction.md, D, "Detecting the position").
 *
 * The quiet swap needs our script to run before the hero is painted. A pure
 * function over the HTML the probe already fetched:
 *
 *   head_first  in <head>, and no external script holds it up. Meta, title,
 *               links (canonical, icon, preconnect, stylesheet), styles,
 *               inline scripts (no src: they run at once, nothing to
 *               download) and async, defer or module scripts before it
 *               change nothing: the hero is in the body, parsed after ours
 *               ran. A pilot site's Next.js head puts stylesheets and async
 *               chunks first; Framer puts its meta tags and two short inline
 *               scripts before "Start of <head>" code (2026-10-25).
 *   head_late   in <head>, after a classic external script without async or
 *               defer, always with `blocking_script_before`: that script's
 *               download delays ours (amber).
 *   body_top    in <body>, before the first h1 (else the first main or
 *               section). Webflow's free plan: a Code Embed at the top.
 *   body_late   in <body> after the hero, or after </body>.
 *   not_found   not in the HTML (with `gtm` when Google Tag Manager is on
 *               the page and the tag has run: a capture landed or an event
 *               arrived).
 *
 * Flags on our own tag: async, defer, module, rocket_loader (Cloudflare
 * Rocket Loader on the page and no data-cfasync="false" on our tag).
 */

export const TAG_POSITIONS = [
  "head_first",
  "head_late",
  "body_top",
  "body_late",
  "not_found",
] as const;
export type TagPosition = (typeof TAG_POSITIONS)[number];

export const TAG_FLAGS = [
  "async",
  "defer",
  "module",
  "rocket_loader",
  "gtm",
  "blocking_script_before",
] as const;
export type TagFlag = (typeof TAG_FLAGS)[number];

/** The edge worker on workers.dev, any account: an install without a custom domain, or an older tag. */
const WORKERS_DEV_EDGE = String.raw`rawuser-edge-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev`;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The host (with a port, when it has one) of an origin, lower case; null when it is not one. */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The two forms a tag of this install takes in a page's HTML. */
export interface TagPatterns {
  /**
   * The older generic tag: /snippet.js on an edge host, the customer id in
   * data-customer-id. Attributes may come before src (data-cfasync).
   */
  snippet: RegExp;
  /** The customer's own script (quiet swap): the id is in the path, /s/{id}.js. */
  customerScript: RegExp;
}

/**
 * The patterns for the origins a tag of this install may load from
 * (install-config.ts, edgeOrigins: the current one and its aliases) and the
 * edge worker on workers.dev. With no origin configured only the last one
 * is recognised.
 */
export function tagPatterns(edgeOrigins: readonly string[]): TagPatterns {
  const hosts = [...new Set(edgeOrigins.flatMap((o) => hostOf(o) ?? []))].map(escapeRe);
  const host = `(?:${[...hosts, WORKERS_DEV_EDGE].join("|")})`;
  return {
    snippet: new RegExp(
      String.raw`<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/${host}\/snippet\.js["']?[^>]*>`,
      "gi",
    ),
    customerScript: new RegExp(
      String.raw`<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/${host}\/s\/([a-z0-9-]+)\.js["']?[^>]*>`,
      "gi",
    ),
  };
}

export interface FoundTag {
  index: number;
  /** The opening <script …> tag as written. */
  tag: string;
  form: "script" | "generic";
  /** The origin the tag loads from: the install's current one, or an older one. */
  origin: string;
}

/** This customer's tag in the HTML, or null. The per-customer form wins over the older one. */
export function findOurTag(
  html: string,
  customerId: string,
  edgeOrigins: readonly string[],
): FoundTag | null {
  const patterns = tagPatterns(edgeOrigins);
  const originOf = (tag: string) => {
    const m = /\bsrc\s*=\s*["']?(https?:\/\/[^/"'\s>]+)/i.exec(tag);
    return (m?.[1] ?? "").toLowerCase();
  };
  for (const m of html.matchAll(patterns.customerScript)) {
    if (m[1] === customerId) {
      return { index: m.index ?? 0, tag: m[0], form: "script", origin: originOf(m[0]) };
    }
  }
  for (const m of html.matchAll(patterns.snippet)) {
    const id = /\bdata-customer-id\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1];
    if (id === customerId) {
      return { index: m.index ?? 0, tag: m[0], form: "generic", origin: originOf(m[0]) };
    }
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    String.raw`\s${name}(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?(?=[\s/>])`,
    "i",
  );
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** Script types a browser does not run as classic JavaScript. */
function isRunnableType(type: string | null): "classic" | "module" | "none" {
  if (type === null || type.trim() === "") return "classic";
  const t = type.trim().toLowerCase();
  if (t === "module") return "module";
  if (/^(text|application)\/(x-)?(java|ecma)script$/.test(t) || t === "text/jscript")
    return "classic";
  // Rocket Loader rewrites types to "<hash>-text/javascript"; it runs them later, not in place.
  return "none";
}

function firstIndex(html: string, re: RegExp): number {
  const m = re.exec(html);
  return m ? m.index : -1;
}

export interface PositionInput {
  html: string;
  customerId: string;
  /** Every origin a tag of this install may load from (install-config.ts, edgeOrigins). */
  edgeOrigins: readonly string[];
  /** The tag has run on this site: a capture landed (tag_seen_at) or an event arrived. */
  tagRuns?: boolean;
}

export interface PositionResult {
  position: TagPosition;
  flags: TagFlag[];
  tag: FoundTag | null;
}

export function tagPosition(input: PositionInput): PositionResult {
  const { html } = input;
  const found = findOurTag(html, input.customerId, input.edgeOrigins);
  const flags: TagFlag[] = [];
  if (!found) {
    const gtm = /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]{4,}\b/.test(html);
    if (gtm && input.tagRuns) flags.push("gtm");
    return { position: "not_found", flags, tag: null };
  }

  const tag = found.tag;
  if (attr(tag, "async") !== null) flags.push("async");
  if (attr(tag, "defer") !== null) flags.push("defer");
  if ((attr(tag, "type") ?? "").trim().toLowerCase() === "module") flags.push("module");
  const cfasync = (attr(tag, "data-cfasync") ?? "").trim().toLowerCase();
  if (/rocket-loader(?:\.min)?\.js/i.test(html) && cfasync !== "false") flags.push("rocket_loader");

  const headEndCandidates = [firstIndex(html, /<\/head\s*>/i), firstIndex(html, /<body\b/i)].filter(
    (i) => i >= 0,
  );
  const headEnd = headEndCandidates.length > 0 ? Math.min(...headEndCandidates) : -1;
  const inHead = headEnd >= 0 && found.index < headEnd;

  if (inHead) {
    const before = html.slice(0, found.index).replace(/<!--[\s\S]*?-->/g, "");
    let blockedBefore = false;
    for (const m of before.matchAll(/<script\b[^>]*>/gi)) {
      const t = m[0];
      const kind = isRunnableType(attr(t, "type"));
      if (kind !== "classic") continue; // modules are deferred, data blocks never run
      // An inline script runs at once with nothing to download (Framer's two).
      if (attr(t, "src") === null) continue;
      if (attr(t, "async") !== null || attr(t, "defer") !== null) continue;
      blockedBefore = true;
    }
    if (blockedBefore) flags.push("blocking_script_before");
    const dedup = [...new Set(flags)];
    return { position: blockedBefore ? "head_late" : "head_first", flags: dedup, tag: found };
  }

  const body = html.slice(Math.max(headEnd, 0));
  const offset = Math.max(headEnd, 0);
  let hero = firstIndex(body, /<h1\b/i);
  if (hero < 0) hero = firstIndex(body, /<(?:main|section)\b/i);
  const bodyClose = firstIndex(html, /<\/body\s*>/i);
  const afterBody = bodyClose >= 0 && found.index > bodyClose;
  const top = !afterBody && (hero < 0 || found.index < offset + hero);
  return { position: top ? "body_top" : "body_late", flags, tag: found };
}
