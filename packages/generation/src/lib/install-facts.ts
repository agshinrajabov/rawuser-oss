/**
 * What a read of the customer's page says about installing the tag:
 * platform, hosting, tag position and the CSP verdict with its lines
 * (docs/specs/install-friction.md, B and D). One function for the probe
 * and the apply submit, so both screens say the same thing.
 *
 * Storage (privacy review ruling 2026-10-03, condition 6): only
 * `storedInstallFacts` writes to D1. It rebuilds every value from the
 * closed enums, so nothing outside them (a host, a source, policy text) can
 * reach the row even if a caller passes it; a value that fails validation
 * is stored as NULL. A test pins the stored key sets.
 */

import {
  CONNECT_VERDICTS,
  CSP_SOURCES,
  type CspReport,
  type CspVerdict,
  FRAMES_VERDICTS,
  type KindVerdicts,
  SCRIPT_VERDICTS,
  STYLE_VERDICTS,
  readCsp,
} from "./csp.ts";
import {
  type Hosting,
  PLATFORMS,
  type Platform,
  detectHosting,
  detectPlatform,
} from "./platform.ts";
import {
  TAG_FLAGS,
  TAG_POSITIONS,
  type TagFlag,
  type TagPosition,
  tagPosition,
} from "./tag-position.ts";

/** Where the screen tells the customer to edit the policy (spec B, "Where the policy lives"). */
export const CSP_WHERE = [
  "next_config",
  "next_middleware",
  "next_layout",
  "vercel_json",
  "netlify_headers",
  "cloudflare_headers",
  "meta_tag",
  "header",
] as const;
export type CspWhere = (typeof CSP_WHERE)[number];

export interface InstallCsp extends CspReport {
  /** null when nothing needs changing. */
  where: CspWhere | null;
}

export interface InstallFacts {
  platform: Platform;
  hosting: Hosting | null;
  tag_position: TagPosition;
  tag_flags: TagFlag[];
  csp: InstallCsp;
}

export interface InstallInput {
  html: string;
  headers: Headers | null;
  pageUrl: URL;
  customerId: string;
  /**
   * Every origin a tag of this install may load from, the current one
   * first (install-config.ts, edgeOrigins).
   */
  edgeOrigins: readonly string[];
  tagRuns?: boolean;
  /** CSP metas from a rendered DOM. */
  extraMeta?: string[];
}

function whereFor(
  report: CspReport,
  platform: Platform,
  hosting: Hosting | null,
  policyHasNonce: boolean,
): CspWhere | null {
  const needed = report.blocks || report.degrades || report.report_only_blocks;
  if (!needed) return null;
  if (report.verdict.source === "meta") return "meta_tag";
  if (platform === "nextjs") {
    // The line is the tag with the page's nonce: it goes in the layout.
    if (report.verdict.enforced?.script === "needs_nonce") return "next_layout";
    if (!report.blocks && report.notes.includes("style_nonce")) return "next_layout";
    return policyHasNonce ? "next_middleware" : "next_config";
  }
  if (hosting === "vercel") return "vercel_json";
  if (hosting === "netlify") return "netlify_headers";
  if (hosting === "cloudflare_pages") return "cloudflare_headers";
  return "header";
}

/**
 * Null when the policy cannot be judged: no tag on the page and no
 * EDGE_ORIGIN to judge it against. The screens then show the plain steps,
 * as for a page that could not be read.
 */
export function installFacts(input: InstallInput): InstallFacts | null {
  const host = input.pageUrl.hostname;
  const platform = detectPlatform({ html: input.html, headers: input.headers, host });
  const hosting = detectHosting({ headers: input.headers, host });
  const position = tagPosition({
    html: input.html,
    customerId: input.customerId,
    edgeOrigins: input.edgeOrigins,
    tagRuns: input.tagRuns,
  });
  const edgeOrigin = position.tag?.origin || input.edgeOrigins[0];
  if (!edgeOrigin) return null;
  const report = readCsp({
    headers: input.headers,
    html: input.html,
    extraMeta: input.extraMeta,
    pageUrl: input.pageUrl,
    customerId: input.customerId,
    edgeOrigin,
    jsx: platform === "nextjs",
  });
  const policyText = `${input.headers?.get("content-security-policy") ?? ""} ${input.html.slice(0, 200_000)}`;
  const policyHasNonce = /'nonce-/i.test(policyText);
  return {
    platform,
    hosting,
    tag_position: position.position,
    tag_flags: position.flags,
    csp: { ...report, where: whereFor(report, platform, hosting, policyHasNonce) },
  };
}

// ---------------------------------------------------------------------------
// Validation and the stored form (condition 6)
// ---------------------------------------------------------------------------

/** The exact keys of the stored csp_verdict JSON, and of each kind object in it. */
export const CSP_VERDICT_KEYS = ["source", "enforced", "report_only", "trusted_types"] as const;
export const KIND_KEYS = ["script", "connect", "style", "frames"] as const;

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function cleanKinds(v: unknown): KindVerdicts | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (
    !oneOf(SCRIPT_VERDICTS, o.script) ||
    !oneOf(CONNECT_VERDICTS, o.connect) ||
    !oneOf(STYLE_VERDICTS, o.style) ||
    !oneOf(FRAMES_VERDICTS, o.frames)
  ) {
    return undefined;
  }
  // Rebuilt key by key: nothing but the four enums survives.
  return { script: o.script, connect: o.connect, style: o.style, frames: o.frames };
}

/** A CspVerdict made only of closed enums, or null when the input is anything else. */
export function validateCspVerdict(v: unknown): CspVerdict | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!oneOf(CSP_SOURCES, o.source) || typeof o.trusted_types !== "boolean") return null;
  const enforced = cleanKinds(o.enforced);
  const reportOnly = cleanKinds(o.report_only);
  if (enforced === undefined || reportOnly === undefined) return null;
  return {
    source: o.source,
    enforced,
    report_only: reportOnly,
    trusted_types: o.trusted_types,
  };
}

export function validatePlatform(v: unknown): Platform | null {
  return oneOf(PLATFORMS, v) ? v : null;
}

export function validateTagPosition(v: unknown): TagPosition | null {
  return oneOf(TAG_POSITIONS, v) ? v : null;
}

export function validateTagFlags(v: unknown): TagFlag[] | null {
  if (!Array.isArray(v)) return null;
  const flags = v.filter((f): f is TagFlag => oneOf(TAG_FLAGS, f));
  return flags.length === v.length ? [...new Set(flags)] : null;
}

export interface StoredInstallFacts {
  csp_verdict: string | null;
  platform: string | null;
  tag_position: string | null;
  tag_flags: string | null;
}

/** The four snippet_status columns, each validated; an invalid value becomes NULL. */
export function storedInstallFacts(f: {
  csp_verdict?: unknown;
  platform?: unknown;
  tag_position?: unknown;
  tag_flags?: unknown;
}): StoredInstallFacts {
  const verdict = validateCspVerdict(f.csp_verdict);
  const flags = validateTagFlags(f.tag_flags);
  return {
    csp_verdict: verdict ? JSON.stringify(verdict) : null,
    platform: validatePlatform(f.platform),
    tag_position: validateTagPosition(f.tag_position),
    tag_flags: flags ? JSON.stringify(flags) : null,
  };
}

/** Reads a stored csp_verdict back; null when absent or not valid. */
export function parseStoredVerdict(text: string | null | undefined): CspVerdict | null {
  if (!text) return null;
  try {
    return validateCspVerdict(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The enforced verdict stops the tag (script or connect). */
export function verdictBlocks(v: CspVerdict | null): boolean {
  const e = v?.enforced;
  return Boolean(e && (e.script !== "ok" || e.connect !== "ok"));
}
