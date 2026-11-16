/**
 * Versions for every customer (docs/specs/versions-for-every-customer.md):
 * the screen's reads and words, every state rendered, its place in the
 * sidebar, and the daily cap's refusal read like the audit's.
 */
import { readFileSync } from "node:fs";
import type { VariantBody } from "@rawuser/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { visibleNav } from "../../src/components/shell/Sidebar";
import { auditRefusal } from "../../src/lib/audit";
import { looksLikeOutage } from "../../src/lib/outage";
import {
  LINES,
  VISITOR_KINDS,
  countLine,
  leftLine,
  livePages,
  originalText,
  partRows,
  reasonsFor,
  rewriteLine,
  rowHeadline,
  versionText,
} from "../../src/lib/your-versions";
import type { ManifestResponse, VariantListItem } from "../../src/types/api";

const MANIFEST: ManifestResponse = {
  customer_id: "acme",
  page_path: "/",
  source_url: "https://acme.test/",
  generated_at: 1,
  confirmed_at: 2,
  cost_usd: 0.01,
  status: "confirmed",
  manifest: {
    "hero.headline": {
      css: ["h1"],
      text: ["Ship your site"],
      structural: "h1",
      original_char_length: 14,
    },
    "hero.body": {
      css: ["p"],
      text: ["A long paragraph that the picker cut at"],
      structural: "p",
      original_char_length: 180,
    },
    "hero.cta.label": { css: ["a"], text: ["Start free"], structural: "a" },
  },
};

const BODY: VariantBody = {
  customer_id: "acme",
  profile_key: "intent:problem",
  generated_at: 5,
  prompt_hash: "x",
  sections: {
    hero: { kind: "hero", headline: "Your *AI* visitors, answered", body: "New paragraph." },
  },
} as VariantBody;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("the reads", () => {
  it("the page's own words, an ellipsis where the picker kept only the opening", () => {
    expect(originalText(MANIFEST, "hero.headline")).toBe("Ship your site");
    expect(originalText(MANIFEST, "hero.body")).toBe("A long paragraph that the picker cut at…");
    expect(originalText(MANIFEST, "features.body")).toBeNull();
  });

  it("a version's part by its path, a button inside its section", () => {
    const b = {
      ...BODY,
      sections: { hero: { kind: "hero", cta: { label: "Try it" } } },
    } as unknown as VariantBody;
    expect(versionText(b, "hero.cta.label")).toBe("Try it");
    expect(versionText(b, "hero.headline")).toBeNull();
    expect(versionText(null, "hero.headline")).toBeNull();
  });

  it("parts in the picker's order; a part the version leaves stays as built", () => {
    const rows = partRows(MANIFEST, BODY);
    expect(rows.map((r) => [r.name, r.version])).toEqual([
      ["Headline", "Your *AI* visitors, answered"],
      ["Opening paragraph", "New paragraph."],
      ["Main button", null],
    ]);
    expect(rowHeadline(BODY, rows)).toBe("Your *AI* visitors, answered");
  });

  it("the served intents only, confirmed pages with the homepage first", () => {
    expect(reasonsFor(["pricing", "problem"])).toEqual(["problem", "pricing"]);
    expect(reasonsFor(null)).toHaveLength(6);
    expect(
      livePages([
        { ...MANIFEST, page_path: "/pricing" },
        { ...MANIFEST, page_path: "/draft", status: "unconfirmed" },
        MANIFEST,
      ]),
    ).toEqual(["/", "/pricing"]);
  });

  it("the count and what is left, in short lines", () => {
    const item = (intent: string, status: VariantListItem["status"]) =>
      ({ intent_dim: intent, source_dim: "ai", page_path: "/", status }) as VariantListItem;
    expect(countLine([item("problem", "ready"), item("brand", "stale")], ["/"], null)).toBe(
      "2 versions on 1 page",
    );
    expect(countLine([item("brand", "ready")], ["/"], ["problem"])).toBeNull();
    expect(leftLine(9, 10)).toBe("9 of 10 rewrites left today.");
    expect(leftLine(0, 10)).toBe("No rewrites left today.");
    expect(leftLine(null, null)).toBeNull();
  });

  it("a rewrite's answer in the customer's words, from the closed word only", () => {
    expect(rewriteLine({ ok: true })).toBe(LINES.rewritten);
    expect(rewriteLine({ ok: false, error: "service_down" })).toBe(LINES.down);
    expect(rewriteLine({ ok: false, error: "not_written" })).toBe(LINES.refused);
    expect(rewriteLine(null)).toBe(LINES.failed);
  });
});

describe("its place in the sidebar (dashboard v2)", () => {
  const hrefs = (o: Parameters<typeof visibleNav>[0]) =>
    visibleNav(o).flatMap((s) => s.items.map((i) => i.href));

  it("a customer sees the four screens, Versions third, and no admin tool", () => {
    const nav = visibleNav({ isCustomer: true, isAudit: false, isLive: true });
    expect(nav).toHaveLength(1);
    expect(nav[0]?.items.map((i) => i.label)).toEqual(["Overview", "Visitors", "Versions", "Test"]);
    expect(hrefs({ isCustomer: true, isAudit: false })).not.toContain("/variants");
    expect(hrefs({ isCustomer: true, isAudit: false })).not.toContain("/customers");
  });

  it("a superadmin keeps the old screens as admin tools", () => {
    const admin = hrefs({ isCustomer: false, isAudit: false });
    for (const h of [
      "/versions",
      "/variants",
      "/customers",
      "/pilots",
      "/applications",
      "/analytics",
    ]) {
      expect(admin).toContain(h);
    }
  });
});

describe("the cap's refusal and a service word", () => {
  it("reads a rewrite cap like an audit cap, with the API's sentence", () => {
    const e = new Error(
      'API error 409: {"error":"rewrite_cap","message":"You have had 10 versions rewritten today. More tomorrow."}',
    );
    expect(auditRefusal(e)).toEqual({
      code: "rewrite_cap",
      message: "You have had 10 versions rewritten today. More tomorrow.",
    });
  });

  it("service_down stops the Live loop like an outage; not_written does not", () => {
    expect(looksLikeOutage("service_down")).toBe(true);
    expect(looksLikeOutage("not_written")).toBe(false);
  });
});
