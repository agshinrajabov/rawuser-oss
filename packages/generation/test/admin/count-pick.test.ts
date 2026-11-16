/**
 * Count-only pick (docs/specs/visual-picker.md §9): the dashboard mints a
 * count link, the picker posts one button through the edge's receive
 * (shared receivePick, run here on the same KV), and pick-status makes it
 * the one counted button for the customer, on the page it was picked on,
 * the visitor bundle rewritten, the manifests untouched. Refused with the
 * test lock's 409 while a test runs. Real SQL on node:sqlite.
 */
import {
  COUNT_REFUSALS,
  type PickStore,
  conversionTargetsForPage,
  pickCountKey,
  pickKey,
  pickTokenKey,
  readPickSeed,
  receivePick,
  validateCountPick,
} from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness } from "../proof-harness.ts";

type User = { id: string; email: string; role: string; customer_id: string | null };
const ACME: User = { id: "u2", email: "c@acme.test", role: "customer", customer_id: "acme" };
let sessionUser: User = ACME;

vi.mock("../../src/admin/auth.ts", () => ({
  getSessionUser: vi.fn(async () => sessionUser),
}));

const { default: worker } = await import("../../src/index.ts");
const { sitePlacementAdmits } = await import("../../src/admin/count-pick.ts");

const LOCK =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

let h: Harness;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  sessionUser = ACME;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://api.example.com${path}`, {
      method,
      headers: { "x-rawuser-admin": "session", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    h.env as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const MANIFEST = JSON.stringify({
  "hero.cta.label": {
    css: ["#start"],
    text: ["Start free"],
    structural: "hero button",
    conversion_candidate: true,
  },
});

function confirmedManifest() {
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES ('acme', '/', ?, 'https://acme.test/', 1, 5)",
    )
    .run(MANIFEST);
}

function slotTarget(id: string, enabled: 0 | 1) {
  h.db
    .prepare(
      `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled,
         css_selectors, text_selectors, structural_selector, created_at, updated_at)
       VALUES (?, 'acme', 'hero.cta.label', 'Start free', 'trial_start', ?, '["#start"]', '["Start free"]', 'hero button', 1, 1)`,
    )
    .run(id, enabled);
}

function testRuns() {
  h.db
    .prepare(
      "INSERT INTO holdout_tests (id, customer_id, percent, started_at, created_at) VALUES ('ht_1', 'acme', 20, 1, 1)",
    )
    .run();
}

function targets() {
  return h.db
    .prepare(
      "SELECT section_path, label, conversion_label, enabled, css_selectors, text_selectors, structural_selector FROM conversion_targets WHERE customer_id = 'acme' ORDER BY created_at, section_path",
    )
    .all() as Array<Record<string, unknown>>;
}

const store = () => h.env.VARIANTS as unknown as PickStore;
const NAV = { css: ["nav a.signup"], text: ["Sign up"], structural: "first a in nav" };

/** Mint a count link, then post the button as the picker does through the edge. */
async function pick(page: string, button = NAV, pickedOn = page): Promise<string> {
  const mint = await call("POST", "/admin/conversions/pick-token", {
    customer_id: "acme",
    page_path: page,
  });
  expect(mint.status).toBe(200);
  const token = mint.json.token as string;
  const posted = await receivePick({ token, button, page_path: pickedOn }, store());
  expect(posted.status).toBe(200);
  return token;
}

describe("POST /admin/conversions/pick-token", () => {
  it("mints a 15-minute count link for the page, one slot, no manifest seed", async () => {
    confirmedManifest();
    const r = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: "/Pricing/",
    });
    expect(r.status).toBe(200);
    expect(r.json.page_path).toBe("/pricing");
    expect(r.json.expires_in_s).toBe(900);
    const token = r.json.token as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.json.link).toBe(`https://acme.test/pricing#rawuser_pick=${token}`);
    const meta = JSON.parse(h.kv.get(pickTokenKey(token)) ?? "{}");
    expect(meta).toEqual({
      customer_id: "acme",
      page_path: "/pricing",
      manifest: {},
      mode: "count",
    });
    const seed = await readPickSeed(token, store());
    if (seed.status !== 200) throw new Error("seed");
    expect(seed.body.slots.map((s) => s.label)).toEqual(["The button to count"]);
  });

  it("seeds the page's current picked button so the picker outlines it", async () => {
    await pick("/");
    expect((await call("GET", "/admin/conversions/pick-status?customer_id=acme")).status).toBe(200);
    const r = await call("POST", "/admin/conversions/pick-token", { customer_id: "acme" });
    const meta = JSON.parse(h.kv.get(pickTokenKey(r.json.token as string)) ?? "{}");
    expect(meta.manifest).toEqual({ "count.button": NAV });
  });

  it("drops a pick left from an earlier link of the same page", async () => {
    await pick("/");
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(true);
    await call("POST", "/admin/conversions/pick-token", { customer_id: "acme" });
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
  });

  it("refuses another customer (403), an unknown one (404) and a running test (409)", async () => {
    expect(
      (await call("POST", "/admin/conversions/pick-token", { customer_id: "other" })).status,
    ).toBe(403);
    sessionUser = { ...ACME, role: "superadmin", customer_id: null };
    expect(
      (await call("POST", "/admin/conversions/pick-token", { customer_id: "nobody" })).status,
    ).toBe(404);
    sessionUser = ACME;
    expect((await call("POST", "/admin/conversions/pick-token", {})).status).toBe(400);
    testRuns();
    const r = await call("POST", "/admin/conversions/pick-token", { customer_id: "acme" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: LOCK });
    expect([...h.kv.keys()].some((k) => k.startsWith("pick-token:"))).toBe(false);
  });
});

describe("GET /admin/conversions/pick-status", () => {
  it("reports not landed when nothing was picked", async () => {
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&page_path=/pricing",
    );
    expect(r).toEqual({ status: 200, json: { landed: false, page_path: "/pricing" } });
  });

  it("makes the picked button the one counted, rewrites the bundle, leaves manifests alone", async () => {
    confirmedManifest();
    slotTarget("t1", 1);
    const manifestsBefore = h.db.prepare("SELECT * FROM element_manifests").all();
    await pick("/pricing");
    const r = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&page_path=/pricing",
    );
    expect(r.status).toBe(200);
    expect(r.json.landed).toBe(true);
    expect(r.json.page_path).toBe("/pricing");
    expect(r.json.target).toMatchObject({
      section_path: "count:/pricing",
      label: "Sign up",
      conversion_label: "signup",
      enabled: true,
      css_selectors: NAV.css,
      text_selectors: NAV.text,
      structural_selector: NAV.structural,
    });
    expect((r.json.items as Array<{ enabled: boolean }>).filter((t) => t.enabled)).toHaveLength(1);
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([
      ["hero.cta.label", 0],
      ["count:/pricing", 1],
    ]);
    const bundle = JSON.parse(h.kv.get("v1:vm:acme") ?? "{}");
    expect(bundle.conv).toEqual([
      {
        section_path: "count:/pricing",
        conversion_label: "signup",
        css: NAV.css,
        text: NAV.text,
        structural: NAV.structural,
      },
    ]);
    expect(Object.keys(bundle.pages)).toEqual(["/"]);
    // The manifests and their confirmation are exactly as before.
    expect(h.db.prepare("SELECT * FROM element_manifests").all()).toEqual(manifestsBefore);
    expect(h.kv.has(pickCountKey("acme", "/pricing"))).toBe(false);
    expect(h.kv.has(pickKey("acme", "/pricing"))).toBe(false);
    // Polling again: nothing more.
    const again = await call(
      "GET",
      "/admin/conversions/pick-status?customer_id=acme&page_path=/pricing",
    );
    expect(again.json.landed).toBe(false);
  });

  it("a second pick on the same page updates the same target; another page gets its own", async () => {
    await pick("/");
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    await pick("/", { css: ["#cta"], text: ["Get started"], structural: "first a in main" });
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(targets().map((t) => [t.section_path, t.label, t.enabled])).toEqual([
      ["count:/", "Get started", 1],
    ]);
    await pick("/pricing");
    await call("GET", "/admin/conversions/pick-status?customer_id=acme&page_path=/pricing");
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([
      ["count:/", 0],
      ["count:/pricing", 1],
    ]);
  });

  it("a form's Send button lands as contact; a re-pick sets the kind again (E1.1)", async () => {
    await pick("/", { css: ["form button"], text: ["Göndər"], structural: "first button in form" });
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(targets().map((t) => [t.label, t.conversion_label, t.enabled])).toEqual([
      ["Göndər", "contact", 1],
    ]);
    const bundle = JSON.parse(h.kv.get("v1:vm:acme") ?? "{}");
    expect(bundle.conv).toEqual([
      expect.objectContaining({ section_path: "count:/", conversion_label: "contact" }),
    ]);
    // Another button on the same page: the kind follows its words.
    await pick("/", NAV);
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(targets().map((t) => [t.label, t.conversion_label])).toEqual([["Sign up", "signup"]]);
    // Words that name no kind stay other.
    await pick("/", { css: ["#go"], text: ["Go"], structural: "first button in main" });
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(targets()[0]?.conversion_label).toBe("other");
  });

  it("files the button under the page it was picked on (a redirect to /en)", async () => {
    await pick("/", NAV, "/en");
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(r.json.page_path).toBe("/en");
    expect(targets().map((t) => t.section_path)).toEqual(["count:/en"]);
  });

  it("a button without words is named by its page", async () => {
    await pick("/", { css: ["#go"], text: [], structural: "first button in form" });
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(targets()[0]?.label).toBe("Button on /");
  });

  it("while a test runs: 409 for a change, nothing written; the counted button again passes", async () => {
    slotTarget("t1", 1);
    await pick("/");
    testRuns();
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: LOCK });
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([["hero.cta.label", 1]]);
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
  });

  it("while a test runs, re-picking the button already counted is not a change", async () => {
    await pick("/");
    await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    // The picker's token is minted before the test starts.
    const mint = await call("POST", "/admin/conversions/pick-token", { customer_id: "acme" });
    testRuns();
    await receivePick({ token: mint.json.token, button: NAV, page_path: "/" }, store());
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(r.status).toBe(200);
    expect(r.json.landed).toBe(true);
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([["count:/", 1]]);
  });

  it("scoped: another customer's status is 403 and reads nothing", async () => {
    h.kv.set(pickCountKey("other", "/"), JSON.stringify({ page_path: "/", ...NAV }));
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=other");
    expect(r.status).toBe(403);
    expect(h.kv.has(pickCountKey("other", "/"))).toBe(true);
  });

  it("a stored pick about one account (address or path) is dropped, never written", async () => {
    for (const stored of [
      { page_path: "/", ...NAV, text: ["jane@acme.example"] },
      { page_path: "/account/48213377", ...NAV },
    ]) {
      h.kv.set(pickCountKey("acme", "/"), JSON.stringify(stored));
      const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
      expect(r.status).toBe(500);
      expect(targets()).toEqual([]);
      expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
    }
  });

  it("a stored pick that fails validation is dropped, never written", async () => {
    h.kv.set(
      pickCountKey("acme", "/"),
      JSON.stringify({ page_path: "/", css: [], text: ["x"], structural: "y" }),
    );
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(r.status).toBe(500);
    expect(targets()).toEqual([]);
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A button on every page (visual-picker.md §9, "A button on every page",
// 2026-10-13): scope "site" on the same link and picker; the pick becomes a
// `site:{slug}` target offered on every page, added to the counted buttons.
// ---------------------------------------------------------------------------

describe("a button on every page (scope site)", () => {
  const ELAQE = { css: ["nav a.contact"], text: ["Əlaqə"], structural: "first a in nav" };
  const TEL = { css: ["a[href^=tel]"], text: ["Telefon nömrəsi"], structural: "2nd a in header" };

  function row(sectionPath: string, enabled: 0 | 1, button = NAV, label = "x") {
    h.db
      .prepare(
        `INSERT INTO conversion_targets (id, customer_id, section_path, label, conversion_label, enabled,
           css_selectors, text_selectors, structural_selector, created_at, updated_at)
         VALUES (?, 'acme', ?, ?, 'other', ?, ?, ?, ?, 1, 1)`,
      )
      .run(
        `r_${sectionPath}`,
        sectionPath,
        label,
        enabled,
        JSON.stringify(button.css),
        JSON.stringify(button.text),
        button.structural,
      );
  }

  async function sitePick(
    page: string | undefined,
    button = ELAQE,
    pickedOn = page ?? "/",
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      scope: "site",
      ...(page === undefined ? {} : { page_path: page }),
    });
    if (mint.status !== 200) return mint;
    const posted = await receivePick(
      { token: mint.json.token as string, button, page_path: pickedOn },
      store(),
    );
    return { status: posted.status, json: mint.json };
  }
  const status = (page?: string) =>
    call(
      "GET",
      `/admin/conversions/pick-status?customer_id=acme&scope=site${page ? `&page_path=${page}` : ""}`,
    );
  const bundle = () => JSON.parse(h.kv.get("v1:vm:acme") ?? "{}");

  it("mints the same link with scope site, page / by default, seeds nothing", async () => {
    row("site:other", 1, TEL);
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      scope: "site",
    });
    expect(mint.status).toBe(200);
    expect(mint.json).toMatchObject({ page_path: "/", scope: "site", expires_in_s: 900 });
    expect(mint.json.link).toBe(`https://acme.test/#rawuser_pick=${mint.json.token}`);
    const seed = await readPickSeed(mint.json.token, store());
    expect(seed).toMatchObject({
      status: 200,
      body: { page_path: "/", manifest: {}, mode: "count" },
    });
    expect(h.kv.get("pick-count-site:acme")).toBe("/");
    // A bad scope, and a group with a scope, are 400.
    expect(
      (await call("POST", "/admin/conversions/pick-token", { customer_id: "acme", scope: "page" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/admin/conversions/pick-token", {
          customer_id: "acme",
          scope: "site",
          group: "/products/*",
        })
      ).status,
    ).toBe(400);
  });

  it("at Done: one site: target from the words, enabled, added, offered on every page by the bundle", async () => {
    confirmedManifest();
    slotTarget("t1", 1);
    row("count:/", 1, { css: ["#send"], text: ["Göndər"], structural: "button in form" }, "Göndər");
    const manifestsBefore = JSON.stringify(h.db.prepare("SELECT * FROM element_manifests").all());
    expect((await sitePick("/products/a")).status).toBe(200);
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ landed: true, scope: "site", page_path: "/products/a" });
    expect(r.json.target).toMatchObject({
      section_path: "site:elaqe",
      label: "Əlaqə",
      conversion_label: "contact",
      enabled: true,
      site: true,
      css_selectors: ELAQE.css,
      text_selectors: ELAQE.text,
      structural_selector: ELAQE.structural,
    });
    // Nothing switched off.
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([
      ["count:/", 1],
      ["hero.cta.label", 1],
      ["site:elaqe", 1],
    ]);
    // Never the selector, never a path, in the section path.
    expect(
      targets()
        .map((t) => t.section_path)
        .join(" "),
    ).not.toMatch(/nav|\/products/);
    expect(JSON.stringify(h.db.prepare("SELECT * FROM element_manifests").all())).toBe(
      manifestsBefore,
    );
    // The bundle carries it, and the edge's rule offers it on any page.
    const conv = bundle().conv as Array<{ section_path: string }>;
    expect(conv.map((c) => c.section_path).sort()).toEqual([
      "count:/",
      "hero.cta.label",
      "site:elaqe",
    ]);
    for (const page of ["/", "/products/:id", "/about/team"]) {
      expect(conversionTargetsForPage(conv, page).map((c) => c.section_path)).toContain(
        "site:elaqe",
      );
    }
    expect(h.kv.has(pickCountKey("acme", "/products/a"))).toBe(false);
    expect(h.kv.has("pick-count-site:acme")).toBe(false);
    // The items mark it; the page's and the slot's rows keep their shape.
    const items = r.json.items as Array<Record<string, unknown>>;
    expect(items.find((t) => t.section_path === "count:/")).not.toHaveProperty("site");
    expect(items.find((t) => t.section_path === "hero.cta.label")).not.toHaveProperty("site");
    expect((await status()).json.landed).toBe(false);
  });

  it("the slug: a second button with the same words gets -2; the same button again updates its row; no words is button", async () => {
    await sitePick("/");
    await status();
    await sitePick("/", { ...ELAQE, css: ["footer a.contact"], structural: "last a in footer" });
    await status();
    await sitePick("/", { ...ELAQE, css: ["footer a.contact"], structural: "last a in footer" });
    await status();
    await sitePick("/", { css: ["a.icon"], text: [], structural: "3rd a in footer" });
    await status();
    expect(
      targets()
        .map((t) => [t.section_path, t.label, t.conversion_label])
        .sort(),
    ).toEqual([
      ["site:button", "Button on every page", "other"],
      ["site:elaqe", "Əlaqə", "contact"],
      ["site:elaqe-2", "Əlaqə", "contact"],
    ]);
  });

  it("at most five: the sixth is refused at mint and at Done", async () => {
    for (const s of ["a", "b", "c", "d"]) row(`site:${s}`, 1, { ...NAV, css: [`a.${s}`] });
    const fifth = await sitePick("/");
    expect(fifth.status).toBe(200);
    expect((await status()).status).toBe(200);
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      scope: "site",
    });
    expect(mint).toMatchObject({
      status: 409,
      json: { error: "You already count 5 buttons on every page. Remove one first." },
    });
    // A pick that landed before the fifth row existed is refused at Done too.
    h.db.prepare("DELETE FROM conversion_targets WHERE section_path = 'site:elaqe'").run();
    expect((await sitePick("/", TEL)).status).toBe(200);
    row("site:elaqe", 1, ELAQE);
    expect((await status()).status).toBe(409);
    expect(targets().some((t) => t.section_path === "site:telefon-nomresi")).toBe(false);
    // Under the cap, re-picking a button already stored adds no row.
    h.db.prepare("DELETE FROM conversion_targets WHERE section_path = 'site:elaqe'").run();
    expect((await sitePick("/", { ...NAV, css: ["a.a"] })).status).toBe(200);
    expect((await status()).json.target).toMatchObject({ section_path: "site:a" });
    expect(targets().filter((t) => String(t.section_path).startsWith("site:"))).toHaveLength(4);
  });

  it("the screens: links and buttons only and the account-style words (validateCountPick) unchanged", async () => {
    expect((await sitePick("/", { ...ELAQE, text: ["Hi a@b.c"] })).status).toBe(400);
    expect((await sitePick("/", { ...ELAQE, css: ["a.u-4821337712"] })).status).toBe(400);
    expect((await sitePick("/", { ...ELAQE, css: [] })).status).toBe(400);
    // Links and buttons only is the picker's screen; the edge's receive is the same function.
    expect(validateCountPick({ ...ELAQE, text: ["Hi a@b.c"] }, "/")).toBeNull();
    expect(targets()).toEqual([]);
  });

  it("the identifier screen on the opened page at mint and on the picked page at Done", async () => {
    const mint = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      scope: "site",
      page_path: "/account/48213377",
    });
    expect(mint.status).toBe(400);
    expect(mint.json.error).toBe(COUNT_REFUSALS.path);
    // Posted from an identifier page: the edge refuses it; nothing lands.
    expect((await sitePick("/", ELAQE, "/u/jane@acme.example")).status).toBe(400);
    expect((await status()).json.landed).toBe(false);
    // Stored past the edge: dropped at Done, never written.
    h.kv.set("pick-count-site:acme", "/");
    h.kv.set(
      pickCountKey("acme", "/"),
      JSON.stringify({ page_path: "/reset/9f8e7d6c5b4a3f2e1d0c", ...ELAQE }),
    );
    expect((await status()).status).toBe(500);
    expect(targets()).toEqual([]);
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
  });

  it("refuses a header or nav button named by aria-label alone", async () => {
    await sitePick("/", {
      css: ['a[aria-label="Open the contact form"]', "nav a.icon"],
      text: ["Open the contact form"],
      structural: "first a in nav",
    });
    expect(await status()).toMatchObject({
      status: 409,
      json: { error: "This button has no words of its own. Pick a button with visible words." },
    });
    expect(targets()).toEqual([]);
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
  });

  it("the test lock: 409 at mint and at Done while a test runs; a site button already counted passes", async () => {
    row("site:elaqe", 1, ELAQE, "Əlaqə");
    await sitePick("/", TEL);
    h.kv.set("pick-count-site:acme", "/");
    testRuns();
    expect((await status()).json.error).toBe(LOCK);
    expect(targets().map((t) => t.section_path)).toEqual(["site:elaqe"]);
    expect(
      (await call("POST", "/admin/conversions/pick-token", { customer_id: "acme", scope: "site" }))
        .status,
    ).toBe(409);
    // The button already counted, unchanged, lands as it is.
    h.kv.set("pick-count-site:acme", "/");
    h.kv.set(pickCountKey("acme", "/"), JSON.stringify({ page_path: "/", ...ELAQE }));
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.json.target).toMatchObject({ section_path: "site:elaqe", site: true });
  });

  it("a sensitive customer may count a button on every page, picked on a product page", async () => {
    h.db
      .prepare("UPDATE customers SET sensitive = 1, kept_sections = ? WHERE id = 'acme'")
      .run(JSON.stringify(["/products"]));
    // As a page it is refused (sensitive-customers.md condition 2); on every page it names none.
    const asPage = await call("POST", "/admin/conversions/pick-token", {
      customer_id: "acme",
      page_path: "/products/polimax",
    });
    expect(asPage.status).toBe(409);
    expect((await sitePick("/products/polimax")).status).toBe(200);
    const r = await status();
    expect(r.status).toBe(200);
    expect(targets().map((t) => [t.section_path, t.enabled])).toEqual([["site:elaqe", 1]]);
    expect(bundle()).toMatchObject({ s: 1, sk: ["/products"] });
  });

  it("the list marks site: rows and the hand-typed selectors from before as site: true", async () => {
    row("site:elaqe", 1, ELAQE, "Əlaqə");
    row("a[href^=tel]", 1, TEL, "Telefon nömrəsi");
    row("count:/", 1);
    row("count:/products/*", 1);
    slotTarget("t1", 1);
    const r = await call("GET", "/admin/conversions/list?customer_id=acme");
    expect(r.status).toBe(200);
    const items = r.json.items as Array<Record<string, unknown>>;
    const site = (p: string) => items.find((t) => t.section_path === p)?.site;
    expect(site("site:elaqe")).toBe(true);
    expect(site("a[href^=tel]")).toBe(true);
    expect(site("count:/")).toBeUndefined();
    expect(site("count:/products/*")).toBeUndefined();
    expect(site("hero.cta.label")).toBeUndefined();
    expect(items.find((t) => t.section_path === "count:/products/*")).toMatchObject({
      group: true,
    });
  });

  it("a phone or email link: the kind word in the path and the label, never the digits or the address", async () => {
    const PHONE = {
      css: ["footer a.phone"],
      text: ["+000 12 345 67 89"],
      structural: "first a in footer",
    };
    expect((await sitePick("/", PHONE)).status).toBe(200);
    expect((await status()).json.target).toMatchObject({
      section_path: "site:phone",
      label: "Phone number",
      conversion_label: "contact",
    });
    // A second number: -2. A hand-typed tel: selector with words: phone too.
    expect(
      (await sitePick("/", { ...PHONE, css: ["footer a.mobile"], text: ["+000 50 111 22 33"] }))
        .status,
    ).toBe(200);
    await status();
    expect(
      (
        await sitePick("/", {
          css: ['a[href^="tel:"]'],
          text: ["Zəng et"],
          structural: "first a in section",
        })
      ).status,
    ).toBe(200);
    await status();
    // mailto: by the selector (an address in the words is refused earlier by the account screen).
    expect(
      (
        await sitePick("/", {
          css: ["a[href^=mailto]"],
          text: ["Yazın"],
          structural: "2nd a in section",
        })
      ).status,
    ).toBe(200);
    await status();
    const rows = targets();
    expect(rows.map((t) => [t.section_path, t.label, t.conversion_label]).sort()).toEqual([
      ["site:email", "Email address", "contact"],
      ["site:phone", "Phone number", "contact"],
      ["site:phone-2", "Phone number", "contact"],
      ["site:phone-3", "Phone number", "contact"],
    ]);
    expect(JSON.stringify(rows.map((t) => [t.section_path, t.label]))).not.toMatch(/\d{3}/);
  });

  it("the placement screen: menu, footer or a phone or email link; a page-body button is 400", async () => {
    // The pilot's kind of pick: a navbar a.btn with words, a footer tel: link.
    expect(
      sitePlacementAdmits({
        css: ["a.btn.btn-primary"],
        text: ["Əlaqə"],
        structural: "3rd a in nav",
      }),
    ).toBe(true);
    expect(
      sitePlacementAdmits({
        css: ["a.tel"],
        text: ["+000 12 345 67 89"],
        structural: "first a in footer",
      }),
    ).toBe(true);
    expect(
      sitePlacementAdmits({ css: ["a.x"], text: ["Contact"], structural: "2nd a in header" }),
    ).toBe(true);
    // Told by a css candidate naming the landmark when the scope is a section.
    expect(
      sitePlacementAdmits({
        css: ["footer > section:nth-of-type(1) > a"],
        text: ["Contact"],
        structural: "first a in section",
      }),
    ).toBe(true);
    expect(
      sitePlacementAdmits({
        css: [".site-footer a.x"],
        text: ["Contact"],
        structural: "first a in section",
      }),
    ).toBe(false);
    // A phone link admitted wherever it sits.
    expect(
      sitePlacementAdmits({
        css: ["a.x"],
        text: ["+000 12 345 67 89"],
        structural: "first a in section",
      }),
    ).toBe(true);
    expect(
      sitePlacementAdmits({
        css: ['a[href^="mailto:"]'],
        text: ["Write"],
        structural: "first a in main",
      }),
    ).toBe(true);
    // A hero button and a form's submit are refused.
    expect(
      sitePlacementAdmits({ css: ["#start"], text: ["Start free"], structural: "first a in main" }),
    ).toBe(false);
    expect(
      sitePlacementAdmits({
        css: ["form button"],
        text: ["Göndər"],
        structural: "first button in form",
      }),
    ).toBe(false);
    expect(
      sitePlacementAdmits({ css: ["a.navigate"], text: ["Go"], structural: "first a in body" }),
    ).toBe(false);

    await sitePick("/", { css: ["#start"], text: ["Start free"], structural: "first a in main" });
    expect(await status()).toMatchObject({
      status: 400,
      json: {
        error: "Pick a button from the menu or the footer, or a phone or email link.",
        page_path: "/",
      },
    });
    expect(targets()).toEqual([]);
    expect(h.kv.has(pickCountKey("acme", "/"))).toBe(false);
    expect(h.kv.has("pick-count-site:acme")).toBe(false);
    expect((await status()).json.landed).toBe(false);
    await sitePick("/", {
      css: ["form button.send"],
      text: ["Göndər"],
      structural: "first button in form",
    });
    expect((await status()).status).toBe(400);
    expect(targets()).toEqual([]);
    // The same submit on a single-page pick is the road for it, as before.
    await pick("/", {
      css: ["form button.send"],
      text: ["Göndər"],
      structural: "first button in form",
    });
    const r = await call("GET", "/admin/conversions/pick-status?customer_id=acme");
    expect(r.json.target).toMatchObject({ section_path: "count:/", conversion_label: "contact" });
  });

  it("scoped: another customer's site status is 403", async () => {
    sessionUser = { ...ACME, customer_id: "other" };
    expect((await status()).status).toBe(403);
  });
});
