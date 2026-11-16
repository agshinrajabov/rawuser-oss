/**
 * Reads a site's Content-Security-Policy and says whether our tag can run,
 * and the exact directives to change when it cannot
 * (docs/specs/install-friction.md, B and C).
 *
 * Pure functions over what the probe or the apply read already fetched:
 * the final response's headers and the HTML. No request is made here.
 *
 * What the snippet needs (listed from packages/snippet/src and the edge):
 *   script   /s/{id}.js, /rich.js, /picker.js  script-src-elem → script-src → default-src
 *   connect  /select, /event, /carry, /onboard/capture, /onboard/pick
 *                                              connect-src → default-src
 *   style    one <style> with HIDE_STYLE_TEXT  style-src-elem → style-src → default-src
 *   frames   the picker loads the page itself  frame-src → child-src → default-src,
 *                                              plus frame-ancestors / X-Frame-Options
 *
 * Every policy is enforced on its own, so the tag runs only when every one
 * allows it. Report-only policies are read the same way and reported apart.
 *
 * Privacy (privacy review ruling 2026-10-03, condition 6): only CspVerdict, a
 * closed-enum object with no host and no policy text, is ever stored. The
 * lines carry the site's own sources and are rebuilt on every read.
 */

/** The text of the one <style> the snippet creates (packages/snippet/src/boot.ts). */
export const HIDE_STYLE_TEXT = "[data-rawuser]{visibility:hidden!important}";
/** sha256 of HIDE_STYLE_TEXT; a test pins the two together. */
export const HIDE_STYLE_HASH = "'sha256-uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY='";

export const SCRIPT_VERDICTS = ["ok", "missing_host", "needs_nonce", "hash_only"] as const;
export const CONNECT_VERDICTS = ["ok", "missing_host"] as const;
export const STYLE_VERDICTS = ["ok", "blocked"] as const;
export const FRAMES_VERDICTS = ["ok", "blocked"] as const;
export const CSP_SOURCES = ["header", "meta", "both", "none"] as const;

export type ScriptVerdict = (typeof SCRIPT_VERDICTS)[number];
export type ConnectVerdict = (typeof CONNECT_VERDICTS)[number];
export type StyleVerdict = (typeof STYLE_VERDICTS)[number];
export type FramesVerdict = (typeof FRAMES_VERDICTS)[number];
export type CspSource = (typeof CSP_SOURCES)[number];

export interface KindVerdicts {
  script: ScriptVerdict;
  connect: ConnectVerdict;
  style: StyleVerdict;
  frames: FramesVerdict;
}

/** What may be stored: closed enums only. */
export interface CspVerdict {
  source: CspSource;
  /** null when the site enforces no policy. */
  enforced: KindVerdicts | null;
  /** null when the site sends no report-only policy. */
  report_only: KindVerdicts | null;
  /** require-trusted-types-for 'script' (spec C): /rich.js and the picker need a policy. */
  trusted_types: boolean;
}

export type CspNote =
  /** frames blocked: the picker cannot measure wraps; lengths by characters. Not a step. */
  | "frames_blocked"
  /** 'strict-dynamic' with hashes only: no line can fix it (spec C). */
  | "hash_only"
  /**
   * The style element is blocked on a nonce policy. The snippet copies its own
   * nonce onto the hide style (spec E1), so the fix is the page's nonce on our
   * tag: the lines carry the tag with a nonce slot, as for needs_nonce.
   */
  | "style_nonce"
  /** Inline style attributes are blocked: a cloned word loses its start state on word-built headlines. */
  | "style_attr_blocked"
  | "trusted_types";

export interface CspReport {
  verdict: CspVerdict;
  /** The enforced policy stops the tag outright (script or connect not ok). */
  blocks: boolean;
  /** The enforced policy lets the tag run, but the style element is blocked (a flash before the swap). */
  degrades: boolean;
  /** The report-only policy would stop the tag once enforced. */
  report_only_blocks: boolean;
  /**
   * Whole new directives for the enforced policy, or the tag with a nonce slot
   * when script is needs_nonce or the style is blocked on a nonce policy.
   */
  lines: string[];
  /** The same for the report-only policy. */
  report_only_lines: string[];
  notes: CspNote[];
}

type Policy = Map<string, string[]>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One serialized policy → directive name (lowercase) → its sources as written. First of a name wins. */
export function parsePolicy(text: string): Policy {
  const policy: Policy = new Map();
  for (const part of text.split(";")) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .filter((t) => t !== "");
    const name = tokens[0]?.toLowerCase();
    if (!name || !/^[a-z0-9-]+$/.test(name) || policy.has(name)) continue;
    policy.set(name, tokens.slice(1));
  }
  return policy;
}

/** A header value may carry several policies separated by commas (and Headers.get joins repeats with ", "). */
export function parseHeaderPolicies(value: string | null | undefined): Policy[] {
  if (!value) return [];
  return value
    .split(",")
    .map(parsePolicy)
    .filter((p) => p.size > 0);
}

/** Directives a <meta> policy cannot carry (CSP3 §3.3). */
const META_IGNORED = ["frame-ancestors", "report-uri", "report-to", "sandbox"];

function metaPolicy(text: string): Policy {
  const policy = parsePolicy(text);
  for (const name of META_IGNORED) policy.delete(name);
  return policy;
}

const FALLBACK: Record<string, string[]> = {
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  "connect-src": ["connect-src", "default-src"],
  "style-src-elem": ["style-src-elem", "style-src", "default-src"],
  "style-src-attr": ["style-src-attr", "style-src", "default-src"],
  "frame-src": ["frame-src", "child-src", "default-src"],
};

function effective(policy: Policy, kind: string): { name: string; sources: string[] } | null {
  for (const name of FALLBACK[kind] ?? [kind]) {
    const sources = policy.get(name);
    if (sources) return { name, sources };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching (CSP3 §6.7.2, the parts a URL of ours can meet)
// ---------------------------------------------------------------------------

const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\d+|\*))?(\/[^?#]*)?$/i;

function schemeMatches(source: string, url: URL): boolean {
  const s = source.toLowerCase();
  const target = url.protocol;
  if (s === target) return true;
  // An insecure scheme in a source also allows its secure form.
  return (s === "http:" && target === "https:") || (s === "ws:" && target === "wss:");
}

/** True when one source expression allows this URL. Keywords, nonces and hashes never match a URL. */
export function sourceMatchesUrl(source: string, url: URL, self?: URL): boolean {
  const s = source.trim();
  if (s === "*") return /^(https?|wss?):$/.test(url.protocol);
  if (s.toLowerCase() === "'self'") return self !== undefined && self.origin === url.origin;
  if (s.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) return schemeMatches(s, url);
  const m = HOST_SOURCE.exec(s);
  if (!m) return false;
  const [, scheme, hostPart = "", port, path] = m;
  if (scheme && !schemeMatches(`${scheme}:`, url)) return false;
  if (!scheme && !/^(https?|wss?):$/.test(url.protocol)) return false;
  const host = hostPart.toLowerCase();
  const target = url.hostname.toLowerCase();
  if (host === "*") {
    // a bare * host matches any host
  } else if (host.startsWith("*.")) {
    if (!target.endsWith(host.slice(1))) return false;
  } else if (host !== target) {
    return false;
  }
  if (port && port !== "*") {
    const targetPort = url.port || (url.protocol === "http:" ? "80" : "443");
    if (port !== targetPort) return false;
  }
  if (path && path !== "") {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return false;
    }
    if (decoded.endsWith("/")) {
      if (!url.pathname.startsWith(decoded)) return false;
    } else if (url.pathname !== decoded) {
      return false;
    }
  }
  return true;
}

function allMatch(sources: string[], urls: URL[], self?: URL): boolean {
  return urls.every((u) => sources.some((s) => sourceMatchesUrl(s, u, self)));
}

const lower = (sources: string[]) => sources.map((s) => s.toLowerCase());
const hasNonce = (sources: string[]) => lower(sources).some((s) => s.startsWith("'nonce-"));
const hasHash = (sources: string[]) => lower(sources).some((s) => /^'sha(256|384|512)-/.test(s));

// ---------------------------------------------------------------------------
// Verdicts per policy
// ---------------------------------------------------------------------------

interface Needs {
  scripts: URL[];
  connects: URL[];
}

function needsFor(edgeOrigin: string, customerId: string): Needs {
  const at = (path: string) => new URL(path, edgeOrigin);
  return {
    scripts: [at(`/s/${customerId}.js`), at("/rich.js"), at("/picker.js")],
    connects: [
      at("/select"),
      at("/event"),
      at("/carry"),
      at("/onboard/capture"),
      at("/onboard/pick"),
    ],
  };
}

function scriptVerdict(policy: Policy, needs: Needs): ScriptVerdict {
  const eff = effective(policy, "script-src-elem");
  if (!eff) return "ok";
  if (lower(eff.sources).includes("'strict-dynamic'")) {
    // Host and scheme sources and 'unsafe-inline' are ignored: only the page's nonce lets the tag in.
    return hasNonce(eff.sources) ? "needs_nonce" : "hash_only";
  }
  return allMatch(eff.sources, needs.scripts) ? "ok" : "missing_host";
}

function connectVerdict(policy: Policy, needs: Needs): ConnectVerdict {
  const eff = effective(policy, "connect-src");
  if (!eff) return "ok";
  return allMatch(eff.sources, needs.connects) ? "ok" : "missing_host";
}

function inlineAllowed(sources: string[], hash?: string): boolean {
  if (hash && sources.some((s) => s === hash || s.toLowerCase() === hash.toLowerCase()))
    return true;
  // A nonce or a hash in the list makes browsers ignore 'unsafe-inline'.
  return lower(sources).includes("'unsafe-inline'") && !hasNonce(sources) && !hasHash(sources);
}

function styleVerdict(policy: Policy): StyleVerdict {
  const eff = effective(policy, "style-src-elem");
  if (!eff) return "ok";
  return inlineAllowed(eff.sources, HIDE_STYLE_HASH) ? "ok" : "blocked";
}

function styleAttrBlocked(policy: Policy): boolean {
  const eff = effective(policy, "style-src-attr");
  if (!eff) return false;
  return (
    !lower(eff.sources).includes("'unsafe-inline'") || hasNonce(eff.sources) || hasHash(eff.sources)
  );
}

function framesVerdict(policy: Policy, page: URL): FramesVerdict {
  const eff = effective(policy, "frame-src");
  if (eff && !eff.sources.some((s) => sourceMatchesUrl(s, page, page))) return "blocked";
  const ancestors = policy.get("frame-ancestors");
  if (ancestors && !ancestors.some((s) => sourceMatchesUrl(s, page, page))) return "blocked";
  return "ok";
}

const ORDER_SCRIPT: ScriptVerdict[] = ["ok", "missing_host", "needs_nonce", "hash_only"];
const worse = <T>(order: readonly T[], a: T, b: T): T =>
  order.indexOf(b) > order.indexOf(a) ? b : a;

function combine(per: KindVerdicts[]): KindVerdicts | null {
  if (per.length === 0) return null;
  return per.reduce((acc, v) => ({
    script: worse(ORDER_SCRIPT, acc.script, v.script),
    connect: worse(CONNECT_VERDICTS, acc.connect, v.connect),
    style: worse(STYLE_VERDICTS, acc.style, v.style),
    frames: worse(FRAMES_VERDICTS, acc.frames, v.frames),
  }));
}

// ---------------------------------------------------------------------------
// The exact lines
// ---------------------------------------------------------------------------

/** The explicit directive a fallback becomes; we never widen default-src itself. */
const OWN_NAME: Record<string, string> = {
  "script-src-elem": "script-src",
  "connect-src": "connect-src",
  "style-src-elem": "style-src",
};

/** The whole new directive: the site's own sources in their order, ours appended once. */
function directiveLine(policy: Policy, kind: string, token: string): string | null {
  const eff = effective(policy, kind);
  if (!eff) return null;
  const name = eff.name === "default-src" ? (OWN_NAME[kind] ?? kind) : eff.name;
  const kept = eff.sources.filter((s) => s.toLowerCase() !== "'none'");
  if (!kept.includes(token)) kept.push(token);
  return `${name} ${kept.join(" ")}`;
}

/** The tag with the page's nonce on it, for a 'strict-dynamic' policy (spec B, Next.js row). */
export function nonceTagLine(edgeOrigin: string, customerId: string, jsx: boolean): string {
  const src = `${edgeOrigin}/s/${customerId}.js`;
  return jsx
    ? `<script data-cfasync="false" src="${src}" nonce={nonce} />`
    : `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${src}"></script>`;
}

function linesFor(
  policy: Policy,
  v: KindVerdicts,
  edgeOrigin: string,
  customerId: string,
  jsx: boolean,
): string[] {
  const out: string[] = [];
  const tag = nonceTagLine(edgeOrigin, customerId, jsx);
  if (v.script === "missing_host") {
    const line = directiveLine(policy, "script-src-elem", edgeOrigin);
    if (line) out.push(line);
  } else if (v.script === "needs_nonce") {
    out.push(tag);
  }
  if (v.connect === "missing_host") {
    const line = directiveLine(policy, "connect-src", edgeOrigin);
    if (line) out.push(line);
  }
  if (v.style === "blocked") {
    const eff = effective(policy, "style-src-elem");
    if (eff && hasNonce(eff.sources)) {
      // On a nonce policy the snippet copies its own nonce onto the hide style
      // (spec E1). That works only when our tag carries the page's nonce, and a
      // tag allowed by host usually does not: the line is the tag with the slot.
      if (!out.includes(tag)) out.push(tag);
    } else if (eff) {
      const line = directiveLine(policy, "style-src-elem", HIDE_STYLE_HASH);
      if (line) out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface CspInput {
  /** The final response's headers (after redirects). */
  headers: Headers | null;
  /** The HTML the read saw; its <meta> policies count. */
  html: string;
  /** Extra <meta> policies from a rendered DOM (a meta added by script counts too). */
  extraMeta?: string[];
  /** The page's own URL: frames are checked against it. */
  pageUrl: URL;
  customerId: string;
  /**
   * The origin the customer's tag loads from: the one on the page when a
   * tag was found (an older install may use an alias), else the install's
   * EDGE_ORIGIN.
   */
  edgeOrigin: string;
  /** Write the nonce tag as JSX (Next.js App Router layout). */
  jsx?: boolean;
}

function uniq(lines: string[]): string[] {
  return [...new Set(lines)];
}

export function readCsp(input: CspInput): CspReport {
  const edgeOrigin = input.edgeOrigin;
  const needs = needsFor(edgeOrigin, input.customerId);
  const jsx = input.jsx ?? false;

  const headerPolicies = parseHeaderPolicies(input.headers?.get("content-security-policy"));
  const metaTexts = [...metaCspFromHtml(input.html), ...(input.extraMeta ?? [])];
  const metaPolicies = uniq(metaTexts)
    .map(metaPolicy)
    .filter((p) => p.size > 0);
  const roPolicies = parseHeaderPolicies(input.headers?.get("content-security-policy-report-only"));

  const enforcedPolicies = [...headerPolicies, ...metaPolicies];
  const verdictOf = (p: Policy): KindVerdicts => ({
    script: scriptVerdict(p, needs),
    connect: connectVerdict(p, needs),
    style: styleVerdict(p),
    frames: framesVerdict(p, input.pageUrl),
  });
  const enforcedPer = enforcedPolicies.map(verdictOf);
  const roPer = roPolicies.map(verdictOf);
  let enforced = combine(enforcedPer);
  const reportOnly = combine(roPer);

  // X-Frame-Options stops the picker's frames even without a CSP
  // (frame-ancestors, when present, takes precedence in browsers).
  const xfo = (input.headers?.get("x-frame-options") ?? "").trim().toLowerCase();
  const hasAncestors = headerPolicies.some((p) => p.has("frame-ancestors"));
  if (xfo === "deny" && !hasAncestors) {
    enforced = enforced
      ? { ...enforced, frames: "blocked" }
      : { script: "ok", connect: "ok", style: "ok", frames: "blocked" };
  }

  const fromHeader = headerPolicies.length > 0 || roPolicies.length > 0;
  const fromMeta = metaPolicies.length > 0;
  const source: CspSource =
    fromHeader && fromMeta ? "both" : fromHeader ? "header" : fromMeta ? "meta" : "none";
  const trustedTypes = enforcedPolicies.some((p) =>
    lower(p.get("require-trusted-types-for") ?? []).includes("'script'"),
  );

  const lines = uniq(
    enforcedPolicies.flatMap((p, i) =>
      linesFor(p, enforcedPer[i] as KindVerdicts, edgeOrigin, input.customerId, jsx),
    ),
  );
  const roLines = uniq(
    roPolicies.flatMap((p, i) =>
      linesFor(p, roPer[i] as KindVerdicts, edgeOrigin, input.customerId, jsx),
    ),
  );

  const notes: CspNote[] = [];
  if (enforced?.frames === "blocked") notes.push("frames_blocked");
  if (enforced?.script === "hash_only") notes.push("hash_only");
  if (
    enforced?.style === "blocked" &&
    enforcedPolicies.some((p) => {
      const eff = effective(p, "style-src-elem");
      return eff !== null && hasNonce(eff.sources);
    })
  ) {
    notes.push("style_nonce");
  }
  if (enforcedPolicies.some(styleAttrBlocked)) notes.push("style_attr_blocked");
  if (trustedTypes) notes.push("trusted_types");

  const stops = (v: KindVerdicts | null) => v !== null && (v.script !== "ok" || v.connect !== "ok");
  return {
    verdict: { source, enforced, report_only: reportOnly, trusted_types: trustedTypes },
    blocks: stops(enforced),
    degrades: !stops(enforced) && enforced?.style === "blocked",
    report_only_blocks: stops(reportOnly) || reportOnly?.style === "blocked",
    lines,
    report_only_lines: roLines,
    notes,
  };
}

/** Every <meta http-equiv="Content-Security-Policy"> policy in the HTML, decoded. */
export function metaCspFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const equiv = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const name = (equiv?.[1] ?? equiv?.[2] ?? equiv?.[3] ?? "").trim().toLowerCase();
    if (name !== "content-security-policy") continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value) out.push(decodeEntities(value));
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// The pasted style of the two-part tag (docs/specs/faster-tag.md step 6)
// ---------------------------------------------------------------------------

/**
 * What the enforced policy says about the pasted `<style data-rawuser-pre>`,
 * worst first wins across policies:
 *   none        no enforced policy restricts style elements;
 *   inline      'unsafe-inline' is in force (no nonce, no hash beside it);
 *   nonce       the paste on the page carries a nonce and the policy has one
 *               (the site's server adds it; a new paste needs no new line);
 *   listed      the policy lists the hash of the paste found on the page;
 *   needs_hash  the policy refuses the paste found (or would refuse one):
 *               it needs the current paste's hash.
 * A closed word; stored as snippet_status.pre_policy. No source, no policy
 * text: the lines are rebuilt on each read and never stored.
 */
export const PRE_POLICIES = ["none", "inline", "nonce", "listed", "needs_hash"] as const;
export type PrePolicy = (typeof PRE_POLICIES)[number];

export interface PrePolicyInput {
  headers: Headers | null;
  html: string;
  extraMeta?: string[];
  /** The CSP hash of the paste found on the page, `'sha256-...'`; null when none. */
  foundHash: string | null;
  /** The paste found on the page carries a nonce attribute. */
  foundNonce: boolean;
  /** The CSP hash of the paste the dashboard hands out now; null when there is none. */
  currentHash: string | null;
}

export interface PrePolicyReport {
  policy: PrePolicy;
  /** Whole new style directives carrying the current paste's hash; empty when none is needed. */
  lines: string[];
}

export function prePolicy(input: PrePolicyInput): PrePolicyReport {
  const policies = [
    ...parseHeaderPolicies(input.headers?.get("content-security-policy")),
    ...uniq([...metaCspFromHtml(input.html), ...(input.extraMeta ?? [])])
      .map(metaPolicy)
      .filter((p) => p.size > 0),
  ];
  let worst: PrePolicy = "none";
  const lines: string[] = [];
  for (const p of policies) {
    const eff = effective(p, "style-src-elem");
    let word: PrePolicy;
    if (!eff) word = "none";
    else if (inlineAllowed(eff.sources)) word = "inline";
    else if (input.foundNonce && hasNonce(eff.sources)) word = "nonce";
    else if (input.foundHash && eff.sources.includes(input.foundHash)) word = "listed";
    else word = "needs_hash";
    if (PRE_POLICIES.indexOf(word) > PRE_POLICIES.indexOf(worst)) worst = word;
    if (
      (word === "listed" || word === "needs_hash") &&
      input.currentHash &&
      !eff?.sources.includes(input.currentHash)
    ) {
      const line = directiveLine(p, "style-src-elem", input.currentHash);
      if (line) lines.push(line);
    }
  }
  return { policy: worst, lines: uniq(lines) };
}
