/**
 * Visits with nothing to go on (ADR 0038; docs/specs/direct-visitors.md,
 * docs/specs/visitors-page.md `direct`): the Visitors panel, market version
 * labels, the Visitor choice card on Versions, the Settings switches and the
 * superadmin's kill. Pure reads tested directly, views rendered to markup.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { ChoiceKillValue } from "../../src/components/analytics/ChoiceKill";
import {
  DirectDetail,
  KindList,
  type KindRow,
  VersionDetail,
} from "../../src/components/v2/Versions";
import { ChoiceCard, versionOption } from "../../src/components/v2/VisitorChoice";
import { DirectPanels, deviceRows, landingRows, viewRows } from "../../src/components/v2/Visitors";
import { ApiError } from "../../src/lib/api";
import {
  SWITCH_LINES,
  answerRows,
  answerShare,
  checkEdit,
  choiceLead,
  choicePath,
  killChoice,
  marketsLine,
  previewLink,
  readChoice,
  readSwitches,
  returnedLine,
  saveChoice,
  sayError,
  setDirectInsights,
  setSwitch,
  skippedLine,
} from "../../src/lib/direct";
import { KINDS, kindOf, marketKind, versionShort } from "../../src/lib/kinds";
import {
  NO_FILTERS,
  activeFilters,
  directFilters,
  filtersFromQuery,
  readVisitors,
  versionLabel,
  visitorsPath,
} from "../../src/lib/visitors";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const NO_DASH = /[–—]/;
const MACHINE = /intent|cohort|variant|bandit|thompson|holdout|model|kv|bundle|endpoint|nd:/i;

const c = (visits: number, conversions: number) => ({
  visits,
  page_views: visits * 2,
  conversions,
  rate: visits ? conversions / visits : null,
});

const VISITORS = {
  window: "30d",
  period: { start: 0, end: 1 },
  computed_at: Date.now(),
  totals: c(500, 20),
  series: { bucket: "day", points: [] },
  by_source: [{ source: "none", ...c(200, 4) }],
  by_country: [],
  by_page: { pages: [], other: null },
  by_version: [],
  by_button: [],
  country_by_version: [],
  direct: {
    recording: "on",
    filters: { device: null, view: null, landing: null },
    totals: c(200, 4),
    by_landing: {
      pages: [
        { page_path: "/", group: false, has_versions: true, ...c(150, 3) },
        { page_path: "/login", group: false, has_versions: false, ...c(30, 0) },
      ],
      other: { pages: 3, visits: 20, page_views: 22, conversions: 1 },
    },
    by_country: [
      { country: "GB", ...c(120, 3) },
      { country: null, ...c(5, 0) },
    ],
    by_device: [
      { device: "mobile", ...c(110, 1) },
      { device: "desktop", ...c(80, 3) },
      { device: null, ...c(10, 0) },
    ],
    by_view: [
      { view: "browser", ...c(170, 4) },
      { view: "app", ...c(25, 0) },
      { view: null, ...c(5, 0) },
    ],
  },
};

const CHOICE = {
  customer_id: "northdeck",
  on: true,
  killed: false,
  allowed: true,
  live: {
    question: "What brings you here?",
    answers: [
      { slot: "a", label: "I'm a broker", intent_dim: "problem", source_dim: "default" },
      { slot: "b", label: "I run a PE fund", intent_dim: "evaluation", source_dim: "default" },
      { slot: "c", label: "I'm selling my company", intent_dim: "brand", source_dim: "default" },
    ],
  },
  draft: null,
  has_anchor: true,
  versions: [
    {
      intent_dim: "problem",
      source_dim: "default",
      headline: "Your next CIM, ready in five days.",
    },
    {
      intent_dim: "evaluation",
      source_dim: "default",
      headline: "Committee memos, written in days.",
    },
    { intent_dim: "brand", source_dim: "default", headline: "Selling your company? Start here." },
    { intent_dim: "pricing", source_dim: "ai", headline: "Fixed fees, per document." },
  ],
  counts: {
    days: 30,
    shown: 1096,
    skipped: { fit: 9, anchor: 0, covered: 5 },
    closed: 40,
    answered: { a: 164, b: 121, c: 87 },
    returned: { a: 30, c: 12 },
    clicked: 55,
    clicked_by_answer: { a: 19, b: 9, c: 10 },
  },
  reaches_visitors_within_s: 360,
};

const fake = (answer: unknown, calls: { path: string; body?: unknown }[]) =>
  (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as never;

// ---------------------------------------------------------------------------
// 1. Visitors: Came straight to the page
// ---------------------------------------------------------------------------

describe("the direct panel on Visitors", () => {
  const a = readVisitors(VISITORS);

  it("reads the contract's direct block, and an older worker has none", () => {
    expect(a?.direct?.totals.visits).toBe(200);
    expect(a?.direct?.byDevice.map((d) => d.device)).toEqual(["mobile", "desktop", null]);
    expect(readVisitors({ ...VISITORS, direct: undefined })?.direct).toBeNull();
  });

  it("names rows in buyer words, null as Not recorded, and folds the small pages", () => {
    if (!a) throw new Error("no answer");
    expect(deviceRows(a).map((r) => [r.key, r.label])).toEqual([
      ["mobile", "Phone"],
      ["desktop", "Computer"],
      ["none", "Not recorded"],
    ]);
    expect(viewRows(a).map((r) => r.label)).toEqual(["A browser", "Inside an app", "Not recorded"]);
    const land = landingRows(a);
    expect(land.map((r) => r.label)).toEqual(["Home", "/login", "3 other pages"]);
    expect(land[2]?.still).toBe(true);
  });

  it("sends the panel's own filters, which never become the page's chips", () => {
    const f = { ...NO_FILTERS, device: "mobile", view: "app", landing: "/", country: "GB" };
    const p = visitorsPath("x", "30d", f);
    expect(p).toContain("device=mobile");
    expect(p).toContain("view=app");
    expect(p).toContain("landing=%2F");
    expect(activeFilters(f)).toEqual(["country"]);
    expect(directFilters(f)).toEqual(["device", "view", "landing"]);
    expect(filtersFromQuery(new URLSearchParams("device=tablet")).filters.device).toBe("tablet");
  });

  it("renders four panels, the switch line when off, and says why a source filter empties it", () => {
    if (!a) throw new Error("no answer");
    const html = (f = NO_FILTERS, ans = a) =>
      text(
        renderToStaticMarkup(
          h(DirectPanels, { a: ans, filters: f, onSet: () => undefined, linksHref: "/l" }),
        ),
      );
    const t = html();
    for (const w of [
      "Came straight to the page",
      "Page they landed on",
      "Device",
      "App or browser",
    ]) {
      expect(t).toContain(w);
    }
    expect(t).toContain("200 visits with nothing to go on");
    expect(t).not.toMatch(NO_DASH);
    const off = readVisitors({ ...VISITORS, direct: { ...VISITORS.direct, recording: "off" } });
    if (!off) throw new Error("no answer");
    expect(html(NO_FILTERS, off)).toContain("Device and app are off for your site");
    expect(html({ ...NO_FILTERS, source: "ai" })).toContain("none came straight");
    expect(html({ ...NO_FILTERS, device: "mobile" })).toContain("In this part");
  });
});

// ---------------------------------------------------------------------------
// 2. Market versions and Visitor choice on Versions
// ---------------------------------------------------------------------------

describe("market versions", () => {
  it("reads mk-{cc} as Visitors in {country}, everywhere a version is named", () => {
    expect(marketKind("mk-gb")?.label).toBe("Visitors in United Kingdom");
    expect(marketKind("mk-gbr")).toBeNull();
    expect(marketKind("ai")).toBeNull();
    expect(kindOf("mk-de")?.label).toBe("Visitors in Germany");
    expect(versionLabel({ version: "brand:mk-gb", kind: "version" })).toBe(
      "Visitors in United Kingdom",
    );
    expect(versionLabel({ version: "*:mk-gb", kind: "version", source_dim: "mk-gb" })).toBe(
      "Visitors in United Kingdom",
    );
    expect(versionShort("version", "mk-us")).toBe("United States");
  });

  it("a market version's detail is titled by its country and points to Visitors by country", () => {
    const kind = marketKind("mk-gb");
    if (!kind) throw new Error("no kind");
    const t = text(
      renderToStaticMarkup(
        h(VersionDetail, {
          kind,
          reasons: [{ intent: "brand", visits: 0 }],
          reason: "brand",
          onReason: () => undefined,
          state: "waiting",
          waitingLine: null,
          parts: [],
          counts: null,
          visitorsHref: "/visitors?source=none&country=GB",
          onRewrite: () => undefined,
          onApprove: () => undefined,
          busy: null,
          said: null,
          canRewrite: true,
        }),
      ),
    );
    expect(t).toContain("Visitors in United Kingdom");
    expect(t).not.toContain("Visitors visitors");
    expect(t).toContain("Its visits count under Came straight to the page, by country.");
    expect(t).toContain("Waiting for your OK");
  });

  it("the kind list puts markets under the line and says when direct visitors are asked", () => {
    const row = (k: (typeof KINDS)[number]): KindRow => ({
      kind: k,
      state: "live",
      visits: 10,
      conversions: 1,
    });
    const mk = marketKind("mk-gb");
    if (!mk || !KINDS[0]) throw new Error("no kind");
    const t = text(
      renderToStaticMarkup(
        h(KindList, {
          rows: [row(KINDS[0])],
          markets: [{ kind: mk, state: "waiting", visits: 0, conversions: 0 }],
          picked: "direct",
          onPick: () => undefined,
          choice: readChoice(CHOICE),
        }),
      ),
    );
    expect(t.indexOf("Came straight to the page")).toBeLessThan(
      t.indexOf("Visitors in United Kingdom"),
    );
    expect(t).toContain("Asked what brings them");
    expect(t).toContain("34% answer");
  });
});

describe("the Visitor choice adapter", () => {
  const st = readChoice(CHOICE);

  it("reads the state and the counts; an answer without `on` is not one", () => {
    expect(st?.live?.answers).toHaveLength(3);
    expect(st?.counts.skipped).toEqual({ fit: 9, anchor: 0, covered: 5 });
    expect(st?.reachS).toBe(360);
    expect(readChoice({ error: "x" })).toBeNull();
  });

  it("answer rows: chose, clicked, the best rate marked, and Did not answer last", () => {
    if (!st?.live) throw new Error("no state");
    const rows = answerRows(st.live, st.counts);
    expect(rows.map((r) => r.chose)).toEqual([164, 121, 87, 1096 - 372]);
    expect(rows.map((r) => r.clicked)).toEqual([19, 9, 10, 17]);
    expect(rows.filter((r) => r.best).map((r) => r.slot)).toEqual(["a"]);
    expect(rows[3]?.label).toBe("Did not answer");
  });

  it("returning visits in plain words", () => {
    if (!st) throw new Error("no state");
    expect(returnedLine(st.counts)).toBe(
      "42 visits came back and saw their answer's version at once, without being asked again.",
    );
    expect(returnedLine({ ...st.counts, returned: {} })).toBeNull();
  });

  it("one question per language home: the state names its home and the site's homes", () => {
    const v = readChoice({
      ...CHOICE,
      path: "/az",
      homes: [
        { path: "/", lang: "en", has_question: true },
        { path: "/az", lang: "az", has_question: false },
      ],
    });
    expect(v?.path).toBe("/az");
    expect(v?.homes).toEqual([
      { path: "/", lang: "en", hasQuestion: true },
      { path: "/az", lang: "az", hasQuestion: false },
    ]);
    expect(readChoice({ ...CHOICE })?.path).toBe("/");
    expect(choicePath("acme")).toBe("/admin/choice?customer_id=acme");
    expect(choicePath("acme", "/az")).toBe("/admin/choice?customer_id=acme&path=%2Faz");
  });

  it("the lead, the share and the skipped line in plain words", () => {
    if (!st) throw new Error("no state");
    expect(choiceLead(st).lead).toBe("1,096 visits saw the question and 372 answered.");
    expect(choiceLead(st).tail).toBe('Most chose "I\'m a broker".');
    expect(choiceLead({ ...st, on: false }).tail).toContain("You can ask them why they came.");
    expect(answerShare(st)).toBe("34% answer");
    expect(answerShare({ ...st, killed: true })).toBeNull();
    expect(skippedLine(st.counts)).toBe(
      "Not shown on 14 loads: 9 had no room at the bottom, 5 had something over it. Those visitors saw your page as built. 40 visitors closed it without an answer.",
    );
    expect(skippedLine({ ...st.counts, skipped: { fit: 0, anchor: 0, covered: 0 } })).toBe(
      "40 visitors closed it without an answer.",
    );
  });

  it("checks an edit before the call: lengths, 2 to 4 answers, a version each, no long dash", () => {
    if (!st?.live) throw new Error("no state");
    expect(checkEdit(st.live)).toBeNull();
    expect(checkEdit({ ...st.live, question: "x".repeat(61) })).toMatch(/question/);
    expect(checkEdit({ ...st.live, answers: st.live.answers.slice(0, 1) })).toMatch(/2 to 4/);
    expect(
      checkEdit({
        ...st.live,
        answers: st.live.answers.map((a, i) => (i ? a : { ...a, label: "x".repeat(33) })),
      }),
    ).toMatch(/answer/);
    expect(checkEdit({ ...st.live, question: "Why — here?" })).toMatch(/dash/);
  });

  it("calls the contract's endpoints with its bodies", async () => {
    const calls: { path: string; body?: unknown }[] = [];
    await saveChoice("n", { on: true }, fake(CHOICE, calls));
    await killChoice("n", true, fake({ ...CHOICE, killed: true }, calls));
    const p = await previewLink(
      "n",
      fake({ token: "t", link: "https://n.test/#rawuser_pick=t", expires_in_s: 900 }, calls),
    );
    expect(calls.map((x) => x.path)).toEqual([
      "/admin/choice",
      "/admin/choice/kill",
      "/admin/choice/preview-link",
    ]);
    expect(calls[0]?.body).toEqual({ customer_id: "n", on: true });
    expect(calls[1]?.body).toEqual({ customer_id: "n", killed: true });
    expect(p.kind === "ok" && p.value.link).toBe("https://n.test/#rawuser_pick=t");
    const bad = await previewLink("n", fake({ link: "javascript:alert(1)" }, []));
    expect(bad.kind).toBe("failed");
  });

  it("shows the worker's sentence, never a machine one", () => {
    const e = (status: number, error: string) =>
      new ApiError(status, `API error ${status}: ${JSON.stringify({ error })}`);
    expect(sayError(e(409, "There is no question yet."))).toBe("There is no question yet.");
    expect(sayError(e(422, "The model's answer could not be read."))).not.toMatch(/model/);
    // A failed model call, in the words of this worker and of one a deploy
    // behind, which named its provider beside "request failed" or "API".
    for (const machine of [
      "Error: Model request failed: HTTP 503",
      "Error: Workers AI request failed: TypeError",
      "Model endpoint down (remembered)",
      "The spare route is not configured",
      "The model configuration is not visible to this isolate",
      "Acme request failed: HTTP 503",
      "Acme API down (remembered)",
      "ACME_API_KEY is not visible to this isolate",
      "Error: Timeout after 45000ms",
    ]) {
      expect(sayError(e(502, machine)), machine).toBe(
        "That did not go through. Try again in a minute.",
      );
    }
    expect(sayError(e(500, "x"))).toMatch(/Press it again/);
  });

  it("a version is offered by its visitors and reason, never by its machine name", () => {
    expect(
      versionOption({ intent_dim: "pricing", source_dim: "ai", headline: "Fixed fees." }),
    ).toBe("AI chat, asking about price: Fixed fees.");
  });
});

describe("the Visitor choice card", () => {
  const st = readChoice(CHOICE);
  const card = (over: Record<string, unknown> = {}, editing = false) => {
    const s = readChoice({ ...CHOICE, ...over });
    if (!s) throw new Error("no state");
    return text(
      renderToStaticMarkup(
        h(ChoiceCard, {
          customerId: "n",
          state: s,
          onState: () => undefined,
          testHref: "/test",
          startEditing: editing,
        }),
      ),
    );
  };

  it("on, with 30 days: the question, the answers with numbers, the preview, the notice", () => {
    const t = card();
    for (const w of [
      "Visitor choice",
      "What brings you here?",
      "Chose",
      "Click rate",
      "Did not answer",
      "Open your page with the question",
      "Text for your privacy notice",
      "What we never ask",
      "compare answers with each other",
      "Not shown on 14 loads",
    ]) {
      expect(t).toContain(w);
    }
    expect(t).not.toMatch(NO_DASH);
    expect(t).not.toMatch(MACHINE);
  });

  it("first time: off by default, the words to check and Turn on", () => {
    const t = card({
      on: false,
      counts: { ...CHOICE.counts, shown: 0, answered: {}, clicked: 0, clicked_by_answer: {} },
    });
    expect(t).toContain("Check the words, then turn it on.");
    expect(t).toContain("Turn on");
    expect(t).toContain("Shows: Your next CIM, ready in five days.");
    expect(t).not.toContain("Click rate");
  });

  it("no question, no main button, killed, not for this site", () => {
    expect(card({ live: null })).toContain("Write a question");
    expect(card({ live: null, has_anchor: false })).toContain("needs a main button first");
    expect(card({ killed: true })).toContain("Rawuser turned this off for your site.");
    expect(card({ allowed: false })).toContain("Not for this site.");
  });

  it("a waiting question asks for the OK; the editor offers every live version", () => {
    const t = card({
      draft: { question: "Why are you here?", answers: CHOICE.live.answers },
    });
    expect(t).toContain("A new question waits for your OK.");
    expect(t).toContain("Approve");
    const e = card({}, true);
    expect(e).toContain("Shows this version");
    expect(e).toContain("AI chat, asking about price: Fixed fees, per document.");
    expect(e).toContain("Save");
  });

  it("Came straight keeps the tagged-link box off the home page and without the endpoint", () => {
    if (!st) throw new Error("no state");
    const props = { customerId: "n", state: st, onState: () => undefined, testHref: "/t" };
    const home = text(
      renderToStaticMarkup(h(DirectDetail, { linksHref: "/l", choice: { ...props, page: "/" } })),
    );
    expect(home).toContain("Asking");
    expect(home).toContain("1,096 visits saw the question");
    const other = text(
      renderToStaticMarkup(
        h(DirectDetail, { linksHref: "/l", choice: { ...props, page: "/pricing" } }),
      ),
    );
    expect(other).toContain("The question for these visits runs on your home page.");
    expect(text(renderToStaticMarkup(h(DirectDetail, { linksHref: "/l" })))).toContain(
      "A tagged link in your posts, ads and newsletters gives them a version.",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Settings switches and 4. the kill
// ---------------------------------------------------------------------------

describe("the switches", () => {
  it("reads the answer; `allowed` absent is allowed, false is not", () => {
    const r = readSwitches({
      page_one: true,
      learned_default: false,
      market_versions: true,
      markets: ["GB", "bad"],
    });
    expect(r).toEqual({
      page_one: true,
      learned_default: false,
      market_versions: true,
      // A worker from before the memory: off, and not for this site.
      remember: false,
      remember_allowed: false,
      markets: ["GB"],
      allowed: true,
    });
    expect(readSwitches({ page_one: true, allowed: false })?.allowed).toBe(false);
    expect(readSwitches({ page_one: true, remember: true, remember_allowed: true })).toMatchObject({
      remember: true,
      remember_allowed: true,
    });
    expect(readSwitches({ error: "x" })).toBeNull();
  });

  it("posts one switch at a time, and the device switch on its own path", async () => {
    const calls: { path: string; body?: unknown }[] = [];
    await setSwitch(
      "n",
      "learned_default",
      false,
      fake({ page_one: true, learned_default: false, market_versions: true, markets: [] }, calls),
    );
    const off = await setDirectInsights(
      "n",
      false,
      fake({ ok: true, direct_insights: "off" }, calls),
    );
    expect(calls[0]).toEqual({
      path: "/admin/customers/direct-switches",
      body: { customer_id: "n", learned_default: false },
    });
    expect(calls[1]?.path).toBe("/admin/direct-insights/off");
    expect(off.kind === "ok" && off.value.on).toBe(false);
  });

  it("short buyer words, no long dash, no machine word on the switches", () => {
    const all = JSON.stringify(SWITCH_LINES);
    expect(all).not.toMatch(NO_DASH);
    expect(all).not.toMatch(/intent|bandit|thompson|cohort|kv|bundle/i);
    for (const k of [
      "insights",
      "page_one",
      "learned_default",
      "market_versions",
      "remember",
    ] as const) {
      expect(SWITCH_LINES[k].sub.length).toBeLessThan(90);
    }
    expect(marketsLine(["GB"], () => "United Kingdom")).toBe("Now: United Kingdom.");
  });
});

describe("the superadmin's kill", () => {
  it("names the state and the one action", () => {
    const st = readChoice(CHOICE);
    if (!st) throw new Error("no state");
    const on = text(
      renderToStaticMarkup(h(ChoiceKillValue, { state: st, busy: false, onAsk: () => undefined })),
    );
    expect(on).toContain("On, visitors are asked");
    expect(on).toContain("Turn off visitor choice now");
    const off = text(
      renderToStaticMarkup(
        h(ChoiceKillValue, { state: { ...st, killed: true }, busy: false, onAsk: () => undefined }),
      ),
    );
    expect(off).toContain("Turned off by Rawuser");
    expect(off).toContain("Allow it again");
  });

  it("the confirm says visitors stop within about 6 minutes", () => {
    const src = readFileSync(
      new URL("../../src/components/analytics/ChoiceKill.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("Visitors stop seeing the question within ${reach}");
    const st = readChoice(CHOICE);
    expect(st?.reachS).toBe(360);
  });
});
