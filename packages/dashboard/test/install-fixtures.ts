/**
 * Probe answers for every install state (docs/specs/install-friction.md,
 * "Build notes", API fields), shaped as the generation worker sends them.
 * A prospect's site is the policy read live on 3 Oct; the rest are examples.
 */
import type { InstallCsp, InstallFacts, ProbeResponse } from "../src/types/api";

export const CLEAN: InstallCsp = {
  verdict: { source: "none", enforced: null, report_only: null, trusted_types: false },
  blocks: false,
  degrades: false,
  report_only_blocks: false,
  lines: [],
  report_only_lines: [],
  notes: [],
  where: null,
};

export function install(
  over: Partial<InstallFacts> = {},
  csp: Partial<InstallCsp> = {},
): InstallFacts {
  return {
    platform: "other",
    hosting: null,
    tag_position: "head_first",
    tag_flags: [],
    csp: { ...CLEAN, ...csp },
    ...over,
  };
}

export function probe(over: Partial<ProbeResponse> = {}): ProbeResponse {
  return {
    customer_id: "brisk",
    status: "active",
    reason: "Last event 3m ago",
    tag_form: "script",
    probed_at: 0,
    page_path: "/",
    read: "ok",
    tag_runs: true,
    install: install(),
    ...over,
  };
}

/** A prospect's site as read live on 3 Oct (spec B). */
export const BRISK_CSP: Partial<InstallCsp> = {
  verdict: {
    source: "header",
    enforced: { script: "missing_host", connect: "missing_host", style: "ok", frames: "blocked" },
    report_only: null,
    trusted_types: false,
  },
  blocks: true,
  lines: [
    "script-src 'self' 'unsafe-inline' https://edge.example.com",
    "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
  ],
  notes: ["frames_blocked"],
  where: "next_config",
};

export const BRISK = install({ platform: "nextjs", hosting: "vercel" }, BRISK_CSP);

export const HASH = "'sha256-uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY='";

/** A Netlify site whose report-only policy would stop the tag. */
export const REPORT_ONLY = install(
  { hosting: "netlify" },
  {
    verdict: {
      source: "header",
      enforced: null,
      report_only: {
        script: "missing_host",
        connect: "missing_host",
        style: "blocked",
        frames: "ok",
      },
      trusted_types: false,
    },
    report_only_blocks: true,
    report_only_lines: [
      "script-src 'self' https://edge.example.com",
      "connect-src 'self' https://api.yourproduct.com https://edge.example.com",
      `style-src 'self' ${HASH}`,
    ],
    where: "netlify_headers",
  },
);

export const HASH_ONLY = install(
  {},
  {
    blocks: true,
    verdict: {
      source: "header",
      enforced: { script: "hash_only", connect: "ok", style: "ok", frames: "ok" },
      report_only: null,
      trusted_types: false,
    },
    notes: ["hash_only"],
    where: "header",
  },
);

/** Next.js with 'strict-dynamic' and a nonce: the line is the tag itself. */
export const NEEDS_NONCE_NEXT = install(
  { platform: "nextjs", hosting: "vercel" },
  {
    blocks: true,
    verdict: {
      source: "header",
      enforced: { script: "needs_nonce", connect: "ok", style: "ok", frames: "ok" },
      report_only: null,
      trusted_types: false,
    },
    lines: [
      '<script data-cfasync="false" src="https://edge.example.com/s/brisk.js" nonce={nonce} />',
    ],
    where: "next_layout",
  },
);

/** A plain site with a nonce policy, and connect missing too. */
export const NEEDS_NONCE_PLAIN = install(
  {},
  {
    blocks: true,
    verdict: {
      source: "meta",
      enforced: { script: "needs_nonce", connect: "missing_host", style: "ok", frames: "ok" },
      report_only: null,
      trusted_types: false,
    },
    lines: [
      '<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="https://edge.example.com/s/brisk.js"></script>',
      "connect-src 'self' https://edge.example.com",
    ],
    where: "meta_tag",
  },
);

/** The tag runs, the hide style is blocked, a hash line fixes it. */
export const DEGRADES = install(
  { hosting: "cloudflare_pages" },
  {
    verdict: {
      source: "header",
      enforced: { script: "ok", connect: "ok", style: "blocked", frames: "ok" },
      report_only: null,
      trusted_types: false,
    },
    degrades: true,
    lines: [`style-src 'self' ${HASH}`],
    where: "cloudflare_headers",
  },
);

/** The tag runs, the hide style is blocked on a nonce policy: the line is the tag with a nonce slot. */
export const DEGRADES_NONCE = install(
  {},
  {
    verdict: {
      source: "header",
      enforced: { script: "ok", connect: "ok", style: "blocked", frames: "ok" },
      report_only: null,
      trusted_types: true,
    },
    degrades: true,
    lines: [
      '<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="https://edge.example.com/s/brisk.js"></script>',
    ],
    notes: ["style_nonce", "style_attr_blocked", "trusted_types"],
    where: "header",
  },
);

/** The same from a worker before 2026-10-06: no line, the screen builds the tag itself. */
export const DEGRADES_NONCE_NO_LINE = install({}, { ...DEGRADES_NONCE.csp, lines: [] });

/** The same on Next.js: the JSX tag for app/layout.tsx. */
export const DEGRADES_NONCE_NEXT = install(
  { platform: "nextjs", hosting: "vercel" },
  {
    ...DEGRADES_NONCE.csp,
    lines: [
      '<script data-cfasync="false" src="https://edge.example.com/s/brisk.js" nonce={nonce} />',
    ],
    notes: ["style_nonce"],
    where: "next_layout",
  },
);

export const CUSTOMER = {
  id: "brisk",
  slug: "brisk",
  domain: "brisk.test",
  plan: "pilot",
  status: "active",
} as never;
