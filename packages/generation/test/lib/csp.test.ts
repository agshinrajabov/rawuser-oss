/**
 * The probe's CSP check (docs/specs/install-friction.md B, C; Tests,
 * "CSP parser and verdict" and "Lines").
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIDE_STYLE_HASH,
  HIDE_STYLE_TEXT,
  metaCspFromHtml,
  parseHeaderPolicies,
  readCsp,
  sourceMatchesUrl,
} from "../../src/lib/csp.ts";

/** A prospect's site, read live 2026-10-03 and again 2026-10-04 (https://www.brisk.test/). */
const BRISK =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com; worker-src 'self' blob:; frame-src 'none'; manifest-src 'self'; upgrade-insecure-requests";

const PAGE = new URL("https://www.example.com/");
const EDGE = "https://edge.example.com";

function read(
  headers: Record<string, string>,
  html = "",
  extra: Partial<Parameters<typeof readCsp>[0]> = {},
) {
  return readCsp({
    headers: new Headers(headers),
    html,
    pageUrl: PAGE,
    customerId: "brisk",
    edgeOrigin: EDGE,
    ...extra,
  });
}

describe("the style hash", () => {
  it("is the sha256 of the snippet's one style text, which boot.ts still writes", () => {
    const digest = createHash("sha256").update(HIDE_STYLE_TEXT).digest("base64");
    expect(HIDE_STYLE_HASH).toBe(`'sha256-${digest}'`);
    const boot = readFileSync(resolve(__dirname, "../../../snippet/src/boot.ts"), "utf8");
    expect(boot).toContain(`style.textContent = "${HIDE_STYLE_TEXT}";`);
    expect(HIDE_STYLE_HASH).toBe("'sha256-uUswyaXbEHXp14LMbwYoLUMHybPzmIVetSQk2E7czKY='");
  });
});

describe("brisk.test", () => {
  it("script and connect missing_host, style ok, frames blocked, and exactly the two lines", () => {
    const r = read({ "content-security-policy": BRISK, "x-frame-options": "DENY" });
    expect(r.verdict).toEqual({
      source: "header",
      enforced: { script: "missing_host", connect: "missing_host", style: "ok", frames: "blocked" },
      report_only: null,
      trusted_types: false,
    });
    expect(r.blocks).toBe(true);
    expect(r.lines).toEqual([
      "script-src 'self' 'unsafe-inline' https://edge.example.com",
      "connect-src 'self' https://*.posthog.com https://vitals.vercel-insights.com https://edge.example.com",
    ]);
    expect(r.notes).toContain("frames_blocked");
  });
});

type Row = {
  name: string;
  policy: string;
  script: string;
  connect: string;
  style: string;
  lines: string[];
};

const TABLE: Row[] = [
  {
    name: "no policy at all",
    policy: "",
    script: "ok",
    connect: "ok",
    style: "ok",
    lines: [],
  },
  {
    name: "default-src only: new explicit directives, default-src never widened",
    policy: "default-src 'self' https://cdn.example.com",
    script: "missing_host",
    connect: "missing_host",
    style: "blocked",
    lines: [
      `script-src 'self' https://cdn.example.com ${EDGE}`,
      `connect-src 'self' https://cdn.example.com ${EDGE}`,
      `style-src 'self' https://cdn.example.com ${HIDE_STYLE_HASH}`,
    ],
  },
  {
    name: "script-src-elem beats script-src",
    policy: `script-src 'self'; script-src-elem 'self' https://cdn.example.com; connect-src *`,
    script: "missing_host",
    connect: "ok",
    style: "ok",
    lines: [`script-src-elem 'self' https://cdn.example.com ${EDGE}`],
  },
  {
    name: "our host already in, with and without the scheme, and with a trailing slash path",
    policy: `script-src 'self' edge.example.com; connect-src https://edge.example.com/`,
    script: "ok",
    connect: "ok",
    style: "ok",
    lines: [],
  },
  {
    name: "a wildcard host and the https: scheme",
    policy: "script-src *.example.com; connect-src https:",
    script: "ok",
    connect: "ok",
    style: "ok",
    lines: [],
  },
  {
    name: "a path that does not cover /rich.js is missing_host",
    policy: `script-src 'self' https://edge.example.com/s/; connect-src 'self' https://edge.example.com/select`,
    script: "missing_host",
    connect: "missing_host",
    style: "ok",
    lines: [
      `script-src 'self' https://edge.example.com/s/ ${EDGE}`,
      `connect-src 'self' https://edge.example.com/select ${EDGE}`,
    ],
  },
  {
    name: "'self' never matches our origin",
    policy: `default-src 'self'; style-src 'self' 'unsafe-inline'`,
    script: "missing_host",
    connect: "missing_host",
    style: "ok",
    lines: [`script-src 'self' ${EDGE}`, `connect-src 'self' ${EDGE}`],
  },
  {
    name: "'strict-dynamic' with a nonce ignores hosts: needs_nonce, the line is the tag",
    policy: `script-src 'nonce-abc' 'strict-dynamic' https://edge.example.com; connect-src *; style-src 'self' 'nonce-abc'`,
    script: "needs_nonce",
    connect: "ok",
    style: "blocked",
    lines: [
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ],
  },
  {
    name: "'strict-dynamic' with hashes only: hash_only, no line can fix it",
    policy: `script-src 'sha256-AAAA' 'strict-dynamic'; connect-src *`,
    script: "hash_only",
    connect: "ok",
    style: "ok",
    lines: [],
  },
  {
    name: "a nonce without 'strict-dynamic': the host is enough; 'unsafe-inline' ignored for styles",
    policy: `script-src 'self' 'nonce-abc'; connect-src 'self'; style-src 'self' 'unsafe-inline' 'sha256-BBBB'`,
    script: "missing_host",
    connect: "missing_host",
    style: "blocked",
    lines: [
      `script-src 'self' 'nonce-abc' ${EDGE}`,
      `connect-src 'self' ${EDGE}`,
      `style-src 'self' 'unsafe-inline' 'sha256-BBBB' ${HIDE_STYLE_HASH}`,
    ],
  },
  {
    name: "style-src-elem first, the hash already in",
    policy: `script-src *; connect-src *; style-src-elem 'self' ${HIDE_STYLE_HASH}`,
    script: "ok",
    connect: "ok",
    style: "ok",
    lines: [],
  },
  {
    name: "'none' is dropped when ours is added",
    policy: `script-src 'none'; connect-src 'none'; style-src 'none'`,
    script: "missing_host",
    connect: "missing_host",
    style: "blocked",
    lines: [`script-src ${EDGE}`, `connect-src ${EDGE}`, `style-src ${HIDE_STYLE_HASH}`],
  },
];

describe("verdicts and lines, one policy shape per row", () => {
  it.each(TABLE)("$name", (row) => {
    const r = read(row.policy ? { "content-security-policy": row.policy } : {});
    const e = r.verdict.enforced;
    if (!row.policy) {
      expect(e).toBeNull();
      expect(r.verdict.source).toBe("none");
    } else {
      expect(e?.script).toBe(row.script);
      expect(e?.connect).toBe(row.connect);
      expect(e?.style).toBe(row.style);
    }
    expect(r.lines).toEqual(row.lines);
    // Our origin appears at most once per line.
    for (const line of r.lines) {
      expect(line.split(" ").filter((t) => t === EDGE)).toHaveLength(
        line.includes(` ${EDGE}`) ? 1 : 0,
      );
      expect(line.startsWith("default-src")).toBe(false);
    }
  });
});

describe("where the policy comes from", () => {
  it("meta: read from the HTML, decoded, and frame-ancestors ignored there", () => {
    const html = `<head><meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; frame-ancestors &#39;none&#39;"></head>`;
    expect(metaCspFromHtml(html)).toEqual(["default-src 'self'; frame-ancestors 'none'"]);
    const r = read({}, html);
    expect(r.verdict.source).toBe("meta");
    expect(r.verdict.enforced?.script).toBe("missing_host");
    // frame-src falls back to default-src 'self', which allows the page itself.
    expect(r.verdict.enforced?.frames).toBe("ok");
  });

  it("both: header and meta are two policies, each enforced on its own", () => {
    const html = `<meta content="connect-src 'self'" http-equiv="content-security-policy">`;
    const r = read({ "content-security-policy": "script-src * ; connect-src *" }, html);
    expect(r.verdict.source).toBe("both");
    expect(r.verdict.enforced?.script).toBe("ok");
    expect(r.verdict.enforced?.connect).toBe("missing_host");
    expect(r.lines).toEqual([`connect-src 'self' ${EDGE}`]);
  });

  it("several policies in one header value: every one must allow the tag", () => {
    expect(parseHeaderPolicies("script-src *, script-src 'self'")).toHaveLength(2);
    const r = read({ "content-security-policy": "script-src *, script-src 'self'" });
    expect(r.verdict.enforced?.script).toBe("missing_host");
    expect(r.lines).toEqual([`script-src 'self' ${EDGE}`]);
  });

  it("a rendered DOM's meta counts too", () => {
    const r = read({}, "", { extraMeta: ["script-src 'self'"] });
    expect(r.verdict.source).toBe("meta");
    expect(r.blocks).toBe(true);
  });

  it("report-only: blocks nothing today, reported apart with its own lines", () => {
    const r = read({
      "content-security-policy-report-only": "default-src 'self'; style-src 'self' 'unsafe-inline'",
    });
    expect(r.verdict.enforced).toBeNull();
    expect(r.blocks).toBe(false);
    expect(r.verdict.report_only).toEqual({
      script: "missing_host",
      connect: "missing_host",
      style: "ok",
      frames: "ok",
    });
    expect(r.report_only_blocks).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.report_only_lines).toEqual([
      `script-src 'self' ${EDGE}`,
      `connect-src 'self' ${EDGE}`,
    ]);
  });

  it("the lines use the host the customer's tag loads from", () => {
    const r = read({ "content-security-policy": "script-src 'self'" }, "", {
      edgeOrigin: "https://edge-old.example.com",
    });
    expect(r.lines).toEqual(["script-src 'self' https://edge-old.example.com"]);
  });

  it("Next.js writes the nonce tag as JSX for app/layout.tsx", () => {
    const r = read({ "content-security-policy": "script-src 'nonce-xyz' 'strict-dynamic'" }, "", {
      jsx: true,
    });
    expect(r.lines).toEqual([
      `<script data-cfasync="false" src="${EDGE}/s/brisk.js" nonce={nonce} />`,
    ]);
  });
});

describe("notes", () => {
  it("frames: frame-src, frame-ancestors and X-Frame-Options", () => {
    expect(read({ "content-security-policy": "frame-src 'none'" }).verdict.enforced?.frames).toBe(
      "blocked",
    );
    expect(
      read({ "content-security-policy": "frame-ancestors 'none'" }).verdict.enforced?.frames,
    ).toBe("blocked");
    expect(read({ "x-frame-options": "DENY" }).verdict.enforced?.frames).toBe("blocked");
    expect(read({ "x-frame-options": "SAMEORIGIN" }).verdict.enforced).toBeNull();
    expect(
      read({ "content-security-policy": "frame-ancestors 'self'", "x-frame-options": "DENY" })
        .verdict.enforced?.frames,
    ).toBe("ok");
  });

  it("Trusted Types and blocked style attributes are noted", () => {
    const r = read({
      "content-security-policy": "require-trusted-types-for 'script'; style-src-attr 'none'",
    });
    expect(r.verdict.trusted_types).toBe(true);
    expect(r.notes).toEqual(expect.arrayContaining(["trusted_types", "style_attr_blocked"]));
  });

  it("a blocked style on a nonce policy: the line is the tag with a nonce slot", () => {
    // The snippet copies its own nonce onto the hide style (spec E1), so the
    // page's nonce has to be on our tag; a tag allowed by host has none.
    const r = read({ "content-security-policy": "style-src 'self' 'nonce-q'" });
    expect(r.verdict.enforced?.style).toBe("blocked");
    expect(r.degrades).toBe(true);
    expect(r.blocks).toBe(false);
    expect(r.lines).toEqual([
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ]);
    expect(r.notes).toContain("style_nonce");
    // Never the hash: on a nonce policy the hash would not be the fix the snippet relies on.
    expect(r.lines.some((l) => l.includes(HIDE_STYLE_HASH))).toBe(false);
  });

  it("a nonce on script and style without 'strict-dynamic', the host allowed: degrades, one tag line", () => {
    const r = read({
      "content-security-policy": `script-src 'self' 'nonce-q' ${EDGE}; connect-src 'self' ${EDGE}; style-src 'self' 'nonce-q'`,
    });
    expect(r.verdict.enforced).toEqual({
      script: "ok",
      connect: "ok",
      style: "blocked",
      frames: "ok",
    });
    expect(r.degrades).toBe(true);
    expect(r.lines).toEqual([
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ]);
  });

  it("the style tag line on Next.js is JSX, from the customer's own edge host", () => {
    const r = read({ "content-security-policy": "style-src 'self' 'nonce-q'" }, "", {
      jsx: true,
      edgeOrigin: "https://edge-old.example.com",
    });
    expect(r.lines).toEqual([
      `<script data-cfasync="false" src="https://edge-old.example.com/s/brisk.js" nonce={nonce} />`,
    ]);
  });

  it("needs_nonce and a blocked nonce style give the tag line once", () => {
    const r = read({
      "content-security-policy": "script-src 'nonce-q' 'strict-dynamic'; style-src 'nonce-q'",
    });
    expect(r.lines).toEqual([
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ]);
  });

  it("a host-blocked tag on a nonce style policy: the directives, then the tag line", () => {
    const r = read({
      "content-security-policy":
        "script-src 'self'; connect-src 'self'; style-src 'self' 'nonce-q'",
    });
    expect(r.blocks).toBe(true);
    expect(r.lines).toEqual([
      `script-src 'self' ${EDGE}`,
      `connect-src 'self' ${EDGE}`,
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ]);
  });

  it("report-only nonce style: the tag line in report_only_lines, nothing enforced", () => {
    const r = read({ "content-security-policy-report-only": "style-src 'self' 'nonce-q'" });
    expect(r.verdict.enforced).toBeNull();
    expect(r.report_only_blocks).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.report_only_lines).toEqual([
      `<script data-cfasync="false" nonce="YOUR-PAGE-NONCE" src="${EDGE}/s/brisk.js"></script>`,
    ]);
  });
});

describe("source matching", () => {
  const u = new URL("https://edge.example.com/s/x.js");
  it.each([
    ["*", true],
    ["https:", true],
    ["http:", true],
    ["wss:", false],
    ["edge.example.com", true],
    ["https://edge.example.com", true],
    ["https://edge.example.com:443", true],
    ["https://edge.example.com:8443", false],
    ["http://edge.example.com", true],
    ["*.example.com", true],
    ["*.edge.example.com", false],
    ["example.com", false],
    ["https://edge.example.com/s/", true],
    ["https://edge.example.com/s/x.js", true],
    ["https://edge.example.com/s", false],
    ["'self'", false],
    ["'unsafe-inline'", false],
    ["'nonce-abc'", false],
  ])("%s → %s", (source, expected) => {
    expect(sourceMatchesUrl(source, u)).toBe(expected);
  });
});
