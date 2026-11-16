/**
 * Dashboard v2 (design/mock/dashboard-v2, approved 2026-11-02): the shell,
 * the old routes, Overview, Versions, Test and Settings. Pure reads tested
 * directly, views rendered to static markup and read as text.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { bottomNav, isItemActive, siteHost, visibleNav } from "../../src/components/shell/Sidebar";
import { type OverviewData, OverviewView } from "../../src/components/v2/Overview";
import { linkSees } from "../../src/components/v2/Settings";
import { ResultCard } from "../../src/components/v2/Test";
import { DirectDetail, KindList, VersionDetail } from "../../src/components/v2/Versions";
import { ApiError } from "../../src/lib/api";
import { isWaiting, rewrittenAgo, waitingSince, waitingVersions } from "../../src/lib/approval";
import { COUNTRY_FALLBACK_PATH, countryPath, setCountryOff } from "../../src/lib/country";
import { KINDS, kindOf, reasonLabel } from "../../src/lib/kinds";
import {
  attentionRows,
  bestSource,
  overviewSentence,
  testTile,
  visitsChange,
} from "../../src/lib/overview";
import type { ReadinessResponse } from "../../src/lib/readiness";
import { parseSettingsTab, redirectFor, withCustomer } from "../../src/lib/routes";
import { footLine, offLine, testPill } from "../../src/lib/test-screen";
import { firstReason, kindCounts, kindState, versionState } from "../../src/lib/versions-screen";
import type { AnalyticsOverview, VariantListItem } from "../../src/types/api";
import { REPORTS } from "../analytics/proof-fixtures";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const NO_DASH = /[–—]/;

function item(over: Partial<VariantListItem> & Record<string, unknown> = {}): VariantListItem {
  return {
    intent_dim: "evaluation",
    source_dim: "social",
    page_path: "/",
    model: "m",
    generated_at: 1,
    cost_usd: 0,
    status: "ready",
    kv_key: "k",
    ...over,
  } as VariantListItem;
}

describe("the sidebar and the old routes", () => {
  it("Help is an email page, never a repository", () => {
    expect(bottomNav().map((i) => i.href)).toEqual(["/settings", "/help"]);
    const src = readFileSync(
      new URL("../../src/components/shell/Sidebar.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("github.com");
  });

  it("an audit customer gets the Audit item, no admin block", () => {
    const nav = visibleNav({ isCustomer: true, isAudit: true });
    expect(nav.flatMap((s) => s.items.map((i) => i.href))).toEqual([
      "/",
      "/visitors",
      "/versions",
      "/test",
      "/audit",
    ]);
  });

  it("Overview lights only on /, the rest on their own path with the export's slash", () => {
    expect(isItemActive("/", "/")).toBe(true);
    expect(isItemActive("/visitors/", "/")).toBe(false);
    expect(isItemActive("/visitors/", "/visitors")).toBe(true);
    expect(siteHost("https://acme.test/path")).toBe("acme.test");
  });

  it("a customer goes from each old route to its new home, the query kept", () => {
    expect(redirectFor("/analytics/", "customer_id=a&window=7d", false)).toBe(
      "/visitors?customer_id=a&window=7d",
    );
    expect(redirectFor("/variants", "", false)).toBe("/versions");
    expect(redirectFor("/conversions", "", false)).toBe("/test");
    expect(redirectFor("/intents", "", false)).toBe("/versions");
    expect(redirectFor("/links", "customer_id=a", false)).toBe("/settings?tab=links&customer_id=a");
    expect(redirectFor("/account", "codes=new", false)).toBe("/settings?tab=account&codes=new");
  });

  it("a superadmin keeps the old screens as tools; Account moves for everyone", () => {
    expect(redirectFor("/analytics", "", true)).toBeNull();
    expect(redirectFor("/variants", "", true)).toBeNull();
    expect(redirectFor("/account", "", true)).toBe("/settings?tab=account");
  });

  it("the first run, apply, onboard and the brief stay where they are", () => {
    for (const p of ["/start", "/apply", "/onboard", "/dna", "/", "/visitors"]) {
      expect(redirectFor(p, "", false)).toBeNull();
    }
  });

  it("Settings tabs and links that keep the picked customer", () => {
    expect(parseSettingsTab("links")).toBe("links");
    expect(parseSettingsTab("nope")).toBe("install");
    expect(withCustomer("/settings?tab=links", "acme")).toBe(
      "/settings?tab=links&customer_id=acme",
    );
    expect(withCustomer("/test", null)).toBe("/test");
  });
});

describe("approval: the list's fields", () => {
  it("nothing waits on a row without them", () => {
    expect(waitingVersions([item(), item({ status: "stale" })])).toEqual([]);
  });

  it("a version marked waiting is read, oldest first, with its age", () => {
    const a = item({ approval: "waiting", waiting_since: 2_000 });
    const b = item({ approval: "waiting", waiting_since: 1_000, source_dim: "ai" });
    expect(waitingVersions([a, item(), b])).toEqual([b, a]);
    expect(isWaiting(a)).toBe(true);
    expect(rewrittenAgo(waitingSince(a), 2_000 + 2 * 3_600_000)).toBe("Rewritten 2 hours ago.");
    expect(rewrittenAgo(waitingSince(item()), 0)).toBeNull();
  });
});

describe("Overview", () => {
  const ov = { delta: { vs_previous_period_visits_pct: 0.12 } } as AnalyticsOverview;

  it("one sentence, the best source only past 30 visits", () => {
    expect(bestSource([{ source_dim: "ai", visits: 29, conversions: 9 }])).toBeNull();
    const best = bestSource([
      { source_dim: "organic", visits: 400, conversions: 8 },
      { source_dim: "social", visits: 300, conversions: 12 },
    ]);
    expect(best?.source).toBe("social");
    expect(overviewSentence(2140, 61, best)).toEqual({
      lead: "2,140 visits in the last 30 days, and 61 clicked a button that counts.",
      tail: "Visitors from Social clicked most often.",
    });
    expect(overviewSentence(0, 0, null).lead).toBe("No visits in the last 30 days yet.");
  });

  it("no change where the API gives none; green only going up", () => {
    expect(visitsChange(ov)).toEqual({ value: "+12%", up: true, rest: "on the 30 days before" });
    expect(
      visitsChange({ delta: { vs_previous_period_visits_pct: null } } as AnalyticsOverview),
    ).toBeNull();
  });

  it("the test tile reads the report's state", () => {
    expect(testTile(null).value).toBe("Off");
    expect(testTile(REPORTS.off).line).toContain("Test");
    expect(testTile(REPORTS.interim).small).toBe("so far");
    expect(testTile(REPORTS.positive).line).toBe("Answer ready.");
  });

  it("attention: waiting versions first, then visits with nothing to go on, then the API's lines", () => {
    const readiness = {
      ok: true,
      blocks_go_live: false,
      special_category: false,
      tag_withheld: false,
      checks: [
        {
          id: "tag",
          state: "amber",
          line: "The tag is missing on /insights.",
          action: null,
          known: "now",
          blocks: false,
          superadmin_only: false,
        },
        {
          id: "terms",
          state: "red",
          line: "No pilot terms.",
          action: null,
          known: "now",
          blocks: false,
          superadmin_only: true,
        },
      ],
    } as ReadinessResponse;
    const none = attentionRows({ items: [item()], noSignalVisits: 812, readiness });
    expect(none.map((r) => r.id)).toEqual(["no-signal", "check-tag"]);
    expect(none[0]?.title).toBe("812 visits came with nothing to go on.");
    expect(none[1]?.action.href).toBe("/settings?tab=install");
    const waiting = attentionRows({
      items: [item({ approval: "waiting", waiting_since: 1 })],
      noSignalVisits: 812,
      readiness,
    });
    expect(waiting[0]?.title).toBe("A new version for Social visitors is waiting for your OK.");
    expect(waiting).toHaveLength(3);
  });

  it("renders the mock's words, every tile a link, no dash", () => {
    const data: OverviewData = {
      visits: 2140,
      clicked: 61,
      change: visitsChange(ov),
      spark: [1, 2, 3],
      best: { source: "ai", rate: 0.04 },
      buttons: ["Book a call"],
      report: REPORTS.interim,
      attention: attentionRows({ items: [], noSignalVisits: 3, readiness: null }),
      updated: "updated 9 min ago",
    };
    const html = renderToStaticMarkup(h(OverviewView, { data, link: (x: string) => x }));
    const t = text(html);
    expect(t).toContain("Last 30 days · updated 9 min ago");
    expect(t).toContain("Visitors from AI chats clicked most often.");
    expect(t).toContain("Clicked a button that counts");
    expect(t).toContain("2.9% of visits");
    expect(t).toContain("On Book a call");
    expect(t).toContain("Test: versions against your page");
    expect(t).toContain("Needs your attention");
    expect(t).toContain("Make a link");
    expect(html).toContain('href="/visitors"');
    expect(html).toContain('href="/test"');
    expect(html).toContain('href="/settings?tab=links"');
    expect(t).not.toMatch(NO_DASH);
  });
});

describe("Versions", () => {
  const items = [
    item({ source_dim: "ai", intent_dim: "evaluation" }),
    item({ source_dim: "social", intent_dim: "evaluation", approval: "waiting", waiting_since: 1 }),
    item({ source_dim: "organic", intent_dim: "evaluation", status: "stale" }),
  ];
  const reasons = ["evaluation", "pricing"];

  it("a kind's state on a page", () => {
    expect(kindState(items, "/", "ai", reasons)).toBe("live");
    expect(kindState(items, "/", "social", reasons)).toBe("waiting");
    expect(kindState(items, "/", "organic", reasons)).toBe("rewriting");
    expect(kindState(items, "/", "paid", reasons)).toBe("none");
    expect(kindState(items, "/pricing", "ai", reasons)).toBe("none");
    expect(versionState(items, "/", "social", "evaluation")).toBe("waiting");
  });

  it("numbers from the breakdown, the busiest reason first", () => {
    const t = [
      { intent_dim: "evaluation", source_dim: "ai", visits: 10, conversions: 1 },
      { intent_dim: "pricing", source_dim: "ai", visits: 30, conversions: 2 },
    ];
    expect(kindCounts(t, "ai")).toEqual({ visits: 40, conversions: 3 });
    expect(firstReason(t, "ai", reasons)).toBe("pricing");
    expect(firstReason([], "ai", reasons)).toBe("evaluation");
  });

  it("kinds named by where they came from; Visitors and Versions share the words", () => {
    expect(KINDS.map((k) => k.short)).toEqual([
      "AI chat",
      "Social",
      "Search",
      "Ads",
      "Communities",
      "General",
    ]);
    expect(kindOf("direct")?.short).toBe("General");
    expect(reasonLabel("competitor")).toBe("Comparing");
  });

  const detail = (state: "live" | "waiting") =>
    renderToStaticMarkup(
      h(VersionDetail, {
        kind: KINDS[1] as (typeof KINDS)[number],
        reasons: [
          { intent: "evaluation", visits: 132 },
          { intent: "competitor", visits: 31 },
        ],
        reason: "evaluation",
        onReason: () => undefined,
        state,
        waitingLine: "Rewritten 2 hours ago.",
        parts: [
          {
            path: "hero.headline",
            name: "Headline",
            original: "Finance leadership.",
            version: "No full-time hire.",
          },
          { path: "hero.cta.label", name: "Main button", original: "Book a call", version: null },
        ],
        counts: { visits: 214, conversions: 8 },
        visitorsHref: "/visitors?version=*:social",
        onRewrite: () => undefined,
        onApprove: () => undefined,
        busy: null,
        said: null,
        canRewrite: true,
      }),
    );

  it("a waiting version offers Approve and Rewrite again; a live one only Rewrite", () => {
    const w = text(detail("waiting"));
    expect(w).toContain("Waiting for your OK");
    expect(w).toContain("Rewritten 2 hours ago. Visitors see the old one until you approve.");
    expect(w).toContain("Approve");
    expect(w).toContain("Rewrite again");
    const l = text(detail("live"));
    expect(l).not.toContain("Approve");
    expect(l).toContain("Rewrite");
    expect(l).toContain("Visitors from social");
    expect(l).toContain("Why they came Choosing 132 Comparing 31");
    expect(l).toContain("Your page");
    expect(l).toContain("This version");
    expect(l).toContain("Stays as on your page");
    expect(l).toContain("Seen by 214 visits in 30 days, all pages");
    expect(l).toContain("3.7% click rate");
    expect(detail("live")).toContain('href="/visitors?version=*:social"');
  });

  it("no cost, model, rule, key or dash; Came straight to the page says why and how", () => {
    const all = text(detail("live")).toLowerCase();
    for (const w of ["cost", "$", "model", "lint", "prompt", "kv_key", "intent", "variant"]) {
      expect(all).not.toContain(w);
    }
    const list = text(
      renderToStaticMarkup(
        h(KindList, {
          rows: KINDS.slice(0, 2).map((k, i) => ({
            kind: k,
            state: i === 0 ? ("live" as const) : ("waiting" as const),
            visits: 96,
            conversions: 5,
          })),
          picked: "ai",
          onPick: () => undefined,
        }),
      ),
    );
    expect(list).toContain("From AI chats");
    expect(list).toContain("Live · 96 visits");
    expect(list).toContain("New, waiting for your OK");
    expect(list).toContain("Came straight to the page");
    expect(list).toContain("Sees your original page");
    const direct = text(
      renderToStaticMarkup(h(DirectDetail, { linksHref: "/settings?tab=links" })),
    );
    expect(direct).toContain(
      "A tagged link in your posts, ads and newsletters gives them a version.",
    );
    expect(all + list + direct).not.toMatch(NO_DASH);
  });

  it("the screen never sends the loop's automatic flag", () => {
    const src = readFileSync(
      new URL("../../src/components/v2/Versions.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("auto: true");
  });
});

describe("Test", () => {
  it("the pill: running, answer ready, ended", () => {
    expect(testPill(REPORTS.off)).toBeNull();
    expect(testPill(REPORTS.interim)?.text).toMatch(/^Running since \d+ \w+ · day \d+$/);
    expect(testPill(REPORTS.interim)?.live).toBe(true);
    expect(testPill(REPORTS.positive)?.text).toMatch(/^Answer ready · ran /);
    expect(testPill(REPORTS.no_difference)?.text).toMatch(/^Ended · /);
  });

  it("not started reads the estimate; the foot names the split", () => {
    expect(offLine(REPORTS.off, Date.now()).lead).toBe(
      "Find out if your versions bring more clicks.",
    );
    expect(footLine(REPORTS.interim)).toBe(
      "1 in 5 visits we can shape see your original page, to compare.",
    );
    expect(footLine(REPORTS.positive)).toBe("Versions now show to every visit we can shape.");
  });

  it("the card: two bars, Stop test while it runs, Run a new test after", () => {
    const running = text(
      renderToStaticMarkup(
        h(ResultCard, {
          report: REPORTS.interim,
          onStop: () => undefined,
          onStartAgain: null,
          busy: false,
        }),
      ),
    );
    expect(running).toContain("Saw a version");
    expect(running).toContain("Your original page");
    expect(running).toContain("Stop test");
    expect(running).toContain("How sure is this?");
    const ended = text(
      renderToStaticMarkup(
        h(ResultCard, {
          report: REPORTS.ended,
          onStop: () => undefined,
          onStartAgain: () => undefined,
          busy: false,
        }),
      ),
    );
    expect(ended).toContain("Run a new test");
    expect(ended).not.toContain("Stop test");
    expect(running + ended).not.toMatch(NO_DASH);
  });
});

describe("Settings", () => {
  it("a campaign link says which version its visitors see", () => {
    expect(linkSees("social", "problem")).toBe("Visitors from this link see the Social version.");
    expect(linkSees("direct", "problem")).toBe("Visitors from this link see the General version.");
    expect(linkSees("paid", "pricing")).toBe("Visitors from this link see the Ads version.");
  });

  it("the country switch posts to the contract's endpoints", async () => {
    const calls: [string, string][] = [];
    const api = (async (path: string, init?: RequestInit) => {
      calls.push([path, String(init?.body)]);
      return { ok: true, customer_id: "acme", country_recording: "off", cleared: 12, done: true };
    }) as never;
    const out = await setCountryOff("acme", true, api);
    expect(calls).toEqual([[countryPath(true), '{"customer_id":"acme"}']]);
    expect(countryPath(false)).toBe("/admin/country/on");
    expect(out).toEqual({ kind: "ok", answer: { off: true, cleared: 12, done: true } });
  });

  it("an older worker (404) is asked once more on its own endpoint; a 500 says press again", async () => {
    const calls: string[] = [];
    const api = (async (path: string) => {
      calls.push(path);
      if (path !== COUNTRY_FALLBACK_PATH) throw new ApiError(404, "API error 404");
      return { ok: true, off: false, cleared: 0, done: true };
    }) as never;
    const out = await setCountryOff("acme", false, api);
    expect(calls).toEqual(["/admin/country/on", COUNTRY_FALLBACK_PATH]);
    expect(out.kind === "ok" && out.answer.off).toBe(false);
    const failing = (async () => {
      throw new ApiError(500, "API error 500");
    }) as never;
    const bad = await setCountryOff("acme", true, failing);
    expect(bad).toEqual({
      kind: "failed",
      message: "Saved, but not everywhere yet. Press it again.",
    });
  });
});

describe("no em or en dash in any v2 source", () => {
  it("every file of the new screens", () => {
    const dir = new URL("../../src/components/v2/", import.meta.url);
    const files = readdirSync(dir).map((f) => new URL(f, dir));
    for (const lib of [
      "approval",
      "country",
      "kinds",
      "overview",
      "routes",
      "test-screen",
      "versions-screen",
      "visitors",
    ]) {
      files.push(new URL(`../../src/lib/${lib}.ts`, import.meta.url));
    }
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(NO_DASH);
  });
});
