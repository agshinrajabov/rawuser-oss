/**
 * The sensitive-site control (mock design/mock/sales-readiness/site-wide-
 * and-sensitive.html, sections 05 to 08, approved 2026-10-22; contract
 * docs/specs/sensitive-customers.md, "The endpoint (as built)"): the row in
 * Results' Admin block off (A14) and on (A17 to A20), the dialog (A15,
 * A16), "Mark it" on the readiness list opening it in place, the claims
 * line (claims-lock.md), and the two calls. Rendered to markup, no network.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import type { ProofData } from "../../src/components/analytics/ProofSection";
import { ResultsAdmin } from "../../src/components/analytics/ResultsAdmin";
import {
  SensitiveBody,
  type SensitiveData,
  SensitiveRowLines,
  SensitiveRowValue,
  hasSensitiveLines,
} from "../../src/components/analytics/SensitiveControl";
import { ReadinessList, actionFor } from "../../src/components/readiness/ReadinessList";
import { Dialog } from "../../src/components/ui/Dialog";
import { ApiError } from "../../src/lib/api";
import type { ReadinessCheck } from "../../src/lib/readiness";
import {
  type Api,
  CLAIMS_LINE,
  DIALOG_LEAD,
  KEPT_HELP,
  MARK_THIS_SITE,
  NOT_READ,
  REWRITE_LINE,
  REWRITE_STEPS,
  SAVE_FAILED,
  SENSITIVE_PATH,
  SWITCH_LABEL,
  SWITCH_SUB,
  type SensitiveView,
  addSection,
  isMarkIt,
  keptWord,
  readSensitive,
  readView,
  removeSection,
  rewritingLine,
  saveSensitive,
  sectionOf,
  showsClaimsLine,
  staleCount,
} from "../../src/lib/sensitive";
import { REPORTS } from "./proof-fixtures";

const noop = () => undefined;
const DISABLED = /\sdisabled=""/;

const KEPT = ["/about", "/blog", "/contact", "/products", "/verify"];
const LIMITS = { sections: 50, length: 200, depth: 4 };

function view(over: Partial<SensitiveView> = {}): SensitiveView {
  return {
    customer_id: "medora",
    sensitive: false,
    kept_sections: [],
    outside: { pages: [], counted: [] },
    limits: LIMITS,
    ...over,
  };
}

function data(over: Partial<SensitiveData> = {}): SensitiveData {
  return {
    state: "ok",
    view: view(),
    rewriting: 0,
    rowsToRewrite: false,
    reload: noop,
    apply: noop,
    ...over,
  };
}

const ON_VIEW = view({ sensitive: true, kept_sections: KEPT });

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function recorder(answer: (path: string) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const api: Api = async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const a = answer(path);
    if (a instanceof Error) throw a;
    return a as T;
  };
  return { api, calls };
}

function refusal(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError(status, `API error ${status}: ${JSON.stringify(body)}`);
}

const PROOF: ProofData = {
  report: REPORTS.off,
  control: null,
  state: "ready",
  reload: noop,
  apply: noop,
};

function admin(sensitive: SensitiveData | null, over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(ResultsAdmin, {
      customerId: "medora",
      domain: "medora.test",
      proof: PROOF,
      afterAdvanced: true,
      defaultOpen: true,
      sensitive: sensitive ? { data: sensitive, onOpen: noop } : null,
      ...over,
    }),
  );
}

// ---------------------------------------------------------------------------
// The row in Admin
// ---------------------------------------------------------------------------

describe("the row in Admin", () => {
  it("A14: off: the switch Off and Mark this site, under Test size", () => {
    const t = text(admin(data()));
    expect(t).toContain(`Sensitive site Off ${MARK_THIS_SITE}`);
    expect(t.indexOf("Sensitive site")).toBeGreaterThan(t.indexOf("Test size"));
    expect(t.indexOf("Sensitive site")).toBeLessThan(t.indexOf("Checks"));
  });

  it("A20: on and settled: On, the count of kept sections, Change; no line", () => {
    const html = admin(data({ view: ON_VIEW }));
    expect(text(html)).toContain("Sensitive site On 5 kept sections Change");
    expect(text(html)).not.toContain(REWRITE_LINE);
    expect(html).not.toContain('data-line="sensitive-rewriting"');
  });

  it("A17 and A18: older rows to rewrite: the amber line, the three steps behind How", () => {
    const d = data({ view: ON_VIEW, rowsToRewrite: true });
    const t = text(admin(d, { sensitive: { data: d, onOpen: noop, howOpen: true } }));
    expect(t).toContain(`${REWRITE_LINE} How Hide`);
    for (const step of REWRITE_STEPS) expect(t).toContain(step);
    // Words only: nothing in the line writes to production.
    const lines = renderToStaticMarkup(h(SensitiveRowLines, { data: d, howOpen: true }));
    expect(lines).not.toContain("<button");
  });

  it("A19: versions sent back: one quiet line, no action", () => {
    const lines = renderToStaticMarkup(
      h(SensitiveRowLines, { data: data({ view: ON_VIEW, rewriting: 20 }) }),
    );
    expect(text(lines)).toBe("20 versions are being rewritten under the claims rules.");
    expect(lines).not.toContain("<button");
  });

  it("no line while off, whatever the counts say", () => {
    expect(hasSensitiveLines(data({ rewriting: 20, rowsToRewrite: true }))).toBe(false);
    expect(hasSensitiveLines(data({ view: ON_VIEW }))).toBe(false);
    expect(hasSensitiveLines(data({ view: ON_VIEW, rewriting: 1 }))).toBe(true);
  });

  it("an older worker (missing): no row; a failed read says so", () => {
    expect(text(admin(data({ state: "missing", view: null })))).not.toContain("Sensitive site");
    expect(text(admin(null))).not.toContain("Sensitive site");
    const failed = text(
      renderToStaticMarkup(
        h(SensitiveRowValue, { data: data({ state: "failed", view: null }), onOpen: noop }),
      ),
    );
    expect(failed).toBe(NOT_READ);
  });

  it("the row's switch opens the dialog, it never writes", () => {
    const html = renderToStaticMarkup(h(SensitiveRowValue, { data: data(), onOpen: noop }));
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Sensitive site"/);
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function body(over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(
      Dialog,
      { open: true },
      h(SensitiveBody, {
        wasOn: true,
        on: true,
        kept: KEPT,
        typed: "",
        busy: false,
        said: null,
        onToggle: noop,
        onTyped: noop,
        onAdd: noop,
        onRemove: noop,
        onCancel: noop,
        onSave: noop,
        ...over,
      }),
    ),
  );
}

describe("the dialog", () => {
  it("A15: the switch, the kept sections as chips, one input, the line, Cancel and Save", () => {
    const html = body();
    const t = text(html);
    expect(t).toContain(`Sensitive site ${DIALOG_LEAD} ${SWITCH_LABEL} ${SWITCH_SUB} On`);
    expect(t).toContain("Kept sections /about /blog /contact /products /verify Add");
    expect(t).toContain(KEPT_HELP);
    expect(t.endsWith("Cancel Save")).toBe(true);
    for (const k of KEPT) expect(html).toContain(`aria-label="Remove ${k}"`);
    expect(html).toContain('placeholder="/section"');
    // Add waits for something typed.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add<\/button>/);
  });

  it("A16: a refusal is the API's sentence, as written, above the buttons", () => {
    const line = "Remove these pages or add their sections to the list first: /pricing.";
    const t = text(body({ said: line }));
    expect(t).toContain(`${KEPT_HELP} ${line} Cancel Save`);
  });

  it("the claims lock is said before Save, only when the flag goes on", () => {
    expect(text(body({ wasOn: false, on: true }))).toContain(CLAIMS_LINE);
    expect(text(body({ wasOn: true, on: true }))).not.toContain(CLAIMS_LINE);
    expect(text(body({ wasOn: false, on: false }))).not.toContain(CLAIMS_LINE);
    expect(showsClaimsLine(false, true)).toBe(true);
    expect(showsClaimsLine(true, false)).toBe(false);
  });

  it("no chips with an empty list; the switch Off reads Off", () => {
    const html = body({ kept: [], on: false, wasOn: false });
    expect(html).not.toContain('data-list="kept"');
    expect(html).toMatch(/aria-checked="false"[^>]*>.*Off/);
  });

  it("while saving, nothing can move", () => {
    const html = body({ busy: true, typed: "/x" });
    expect(html).toMatch(/role="switch"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(DISABLED.test(html)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// "Mark it" on the readiness list
// ---------------------------------------------------------------------------

const YES: ReadinessCheck = {
  id: "category",
  state: "red",
  line: "Your site is in a special category. We finish its setup by hand before go live.",
  action: { label: "Mark it", href: "/analytics" },
  known: "now",
  blocks: true,
  superadmin_only: false,
};

describe("Mark it", () => {
  it("is the red category line with an action; not for a customer, who gets none", () => {
    expect(isMarkIt(YES)).toBe(true);
    expect(isMarkIt({ ...YES, action: null })).toBe(false);
    expect(isMarkIt({ ...YES, state: "amber" })).toBe(false);
    expect(isMarkIt({ ...YES, id: "tag" })).toBe(false);
  });

  it("opens the dialog in place: a button with the API's label, no link", () => {
    const action = actionFor(YES, (c) => (isMarkIt(c) ? noop : null));
    expect(action).toMatchObject({ kind: "click", label: "Mark it" });
    const html = renderToStaticMarkup(
      h(ReadinessList, { checks: [YES], inPlace: (c) => (isMarkIt(c) ? noop : null) }),
    );
    expect(html).toMatch(/<button[^>]*>Mark it<\/button>/);
    expect(html).not.toContain('href="/analytics"');
  });
});

// ---------------------------------------------------------------------------
// The chips
// ---------------------------------------------------------------------------

describe("the kept sections", () => {
  it("a typed section takes the shared rule's form; / and nothing add nothing", () => {
    expect(sectionOf("products/")).toBe("/products");
    expect(sectionOf(" /blog?x=1 ")).toBe("/blog");
    expect(sectionOf("/")).toBeNull();
    expect(sectionOf("   ")).toBeNull();
    // Refused by the rule: kept as typed, so Save shows the server's line.
    expect(sectionOf("/a/b/c/d/e")).toBe("/a/b/c/d/e");
  });

  it("adds once, removes one", () => {
    expect(addSection(["/blog"], "blog")).toEqual(["/blog"]);
    expect(addSection(["/blog"], "/about")).toEqual(["/blog", "/about"]);
    expect(addSection(["/blog"], "")).toEqual(["/blog"]);
    expect(removeSection(["/blog", "/about"], "/blog")).toEqual(["/about"]);
  });

  it("the row's words", () => {
    expect(keptWord(5)).toBe("5 kept sections");
    expect(keptWord(1)).toBe("1 kept section");
    expect(keptWord(0)).toBe("No kept sections");
    expect(rewritingLine(1)).toBe("1 version is being rewritten under the claims rules.");
    expect(rewritingLine(0)).toBeNull();
  });

  it("counts the versions waiting from the list, either shape", () => {
    const rows = [
      { status: "stale" },
      { status: "ready" },
      { status: "stale" },
      { status: "error" },
    ];
    expect(staleCount(rows)).toBe(2);
    expect(staleCount({ items: rows, summary: null })).toBe(2);
    expect(staleCount(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const ANSWER = {
  customer_id: "medora",
  sensitive: true,
  kept_sections: KEPT,
  outside: { pages: [], counted: [] },
  limits: LIMITS,
};

describe("the calls", () => {
  it("reads the flag and the list; an older worker (404) is missing", async () => {
    const { api, calls } = recorder(() => ANSWER);
    expect(await readSensitive("medora", api)).toEqual({ kind: "ok", view: ANSWER });
    expect(calls[0]?.path).toBe(`${SENSITIVE_PATH}?customer_id=medora`);
    const old = recorder(() => refusal(404, { error: "Not found" }));
    expect(await readSensitive("medora", old.api)).toEqual({ kind: "missing" });
    const down = recorder(() => new TypeError("Failed to fetch"));
    expect(await readSensitive("medora", down.api)).toEqual({ kind: "failed" });
    expect(readView({ nope: 1 })).toBeNull();
  });

  it("Save sends the flag and the list together", async () => {
    const saved = {
      ...ANSWER,
      changed: true,
      versions_marked_stale: 20,
      rows_to_rewrite: { why: "marked", removed: [] },
      warning: "This customer already has visits ...",
    };
    const { api, calls } = recorder(() => saved);
    const out = await saveSensitive("medora", true, KEPT, api);
    expect(calls[0]).toEqual({
      path: SENSITIVE_PATH,
      body: { customer_id: "medora", sensitive: true, kept_sections: KEPT },
    });
    expect(out).toMatchObject({
      kind: "ok",
      saved: { sensitive: true, versions_marked_stale: 20, rows_to_rewrite: { why: "marked" } },
    });
  });

  it("the 409, the 400 and the 500 come back as written", async () => {
    const lines = [
      [409, "Remove these pages or add their sections to the list first: /pricing."],
      [
        400,
        "kept_sections must be a list of at most 50 paths like /products: plain words, at most 4 deep and 200 characters, no query and nothing that names one account.",
      ],
      [500, "Saved, but the edge copy was not written. Send the same request again."],
    ] as const;
    for (const [status, line] of lines) {
      const { api } = recorder(() => refusal(status, { error: line, code: "pages_outside" }));
      expect(await saveSensitive("medora", true, KEPT, api)).toEqual({
        kind: "refused",
        sentence: line,
      });
    }
    const down = recorder(() => new TypeError("Failed to fetch"));
    expect(await saveSensitive("medora", true, KEPT, down.api)).toEqual({
      kind: "failed",
      message: SAVE_FAILED,
    });
  });
});
