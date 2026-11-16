/**
 * E2 of docs/specs/pilot-gaps.md, pinned as it is today (nothing here
 * is a change): is a visit that never opened a page with versions of its own
 * in the arms of the lift report?
 *
 * Yes, when it had a signal. The edge's cascade reads the page's own
 * versions and then the root's (`[pagePath, "/"]`), and decides the arm once
 * it found a body, the root's included. So a ChatGPT visit to a product page
 * with no versions gets an arm: in treat the snippet is handed the
 * homepage's words and manifest, finds no part and reports a skip; in
 * holdout it reports the holdout exposure. Both rows carry the arm, the
 * product page and the root body's id. The rollup counts them and the
 * report's arms hold them. A visit with no signal gets no arm anywhere and
 * is in neither arm, not "eligible" and not "uncounted".
 *
 * The proposal that follows from this is in docs/specs/proof-engine.md,
 * "Visits that never met a version". Real SQL on node:sqlite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armTotals } from "../../src/cron/analytics-aggregator.ts";
import { computeDay, dayStart, rebuildDay } from "../../src/cron/exposure-rollup.ts";
import { loadLiftReport, loadReportInput } from "../../src/lib/proof-report.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

let h: Harness;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const D1 = "2026-10-13";
const T = dayStart(D1) + 10 * HOUR;
/** The homepage's body, the only page with versions. */
const ROOT_BODY = "aaaaaaaaaaaaaaaa";
const PRODUCT = "/products/chair";

beforeEach(() => {
  h = harness();
  h.customer("acme");
  // The homepage is the only confirmed page; a test runs at 20%.
  h.db
    .prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at) VALUES ('acme', '/', '{}', 'https://acme.test', 1, 1)",
    )
    .run();
  h.db
    .prepare(
      "INSERT INTO holdout_tests (id, customer_id, percent, started_at, ended_at, created_at) VALUES ('ht', 'acme', 20, ?, NULL, ?)",
    )
    .run(NOW - 3 * DAY, NOW - 3 * DAY);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Yesterday on a site like the pilot's. With versions (the homepage): 4 treat
 * visits written, 2 of them clicking the counted button; 1 holdout visit.
 * Without versions of their own (product pages, a signal, the root's body):
 * 8 treat visits skipped and 2 holdout visits, none clicking (the counted
 * button is on the homepage). And 5 visits with no signal at all.
 */
function medoraLikeDay(): void {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const visit = vid(++v);
    h.ev({
      ts: T + v,
      type: "variant_shown",
      visit,
      arm: "treat",
      cohort: "personalized",
      page: "/",
      body: ROOT_BODY,
    });
    if (i < 2) h.ev({ ts: T + v + 5_000, type: "conversion", visit, page: "/" });
  }
  h.ev({
    ts: T + ++v,
    type: "variant_shown",
    visit: vid(v),
    arm: "holdout",
    cohort: "holdout",
    page: "/",
    body: ROOT_BODY,
  });
  for (let i = 0; i < 8; i++)
    h.ev({
      ts: T + ++v,
      type: "personalization_skipped",
      visit: vid(v),
      arm: "treat",
      cohort: "skipped",
      page: PRODUCT,
      body: ROOT_BODY,
      props: { kind: "gap" },
    });
  for (let i = 0; i < 2; i++)
    h.ev({
      ts: T + ++v,
      type: "variant_shown",
      visit: vid(v),
      arm: "holdout",
      cohort: "holdout",
      page: PRODUCT,
      body: ROOT_BODY,
    });
  for (let i = 0; i < 5; i++)
    h.ev({
      ts: T + ++v,
      type: "no_signal_passthrough",
      visit: vid(v),
      cohort: "no_signal",
      page: PRODUCT,
    });
}

describe("today: a signal visit on pages without versions of their own is in the arms", () => {
  it("the rollup puts it in its arm, on its own page, under the root's body", async () => {
    medoraLikeDay();
    const { rows } = await computeDay(h.d1, "acme", D1);
    const at = (arm: string, page: string) =>
      rows.filter((r) => r.arm === arm && r.page_path === page);
    expect(at("treat", PRODUCT)).toHaveLength(1);
    expect(at("treat", PRODUCT)[0]).toMatchObject({
      visits: 8,
      converting_visits: 0,
      applied_visits: 0,
      skipped_visits: 8,
      // The id of the homepage's body on a row of a product page: the one
      // fact that tells such a visit apart, and it is already stored.
      body_id: ROOT_BODY,
    });
    expect(at("holdout", PRODUCT)[0]).toMatchObject({ visits: 2, body_id: ROOT_BODY });
    expect(at("treat", "/")[0]).toMatchObject({ visits: 4, converting_visits: 2 });
  });

  it("the lift report's arms count it: 12 treat visits, of which 4 could see a version", async () => {
    medoraLikeDay();
    await rebuildDay(h.d1, "acme", D1, NOW);
    const r = await loadLiftReport(h.d1, "acme", NOW, true);
    // 4 + 8 and 1 + 2: two thirds of each arm never met a version.
    expect(r.arms?.treat).toMatchObject({ visits: 12, converting_visits: 2 });
    expect(r.arms?.holdout).toMatchObject({ visits: 3, converting_visits: 0 });
    // Where the version was written: the as-treated count, not the headline.
    expect(
      (await loadReportInput(h.d1, "acme", NOW, true)).outcomes
        .filter((o) => o.arm === "treat")
        .reduce((s, o) => s + o.applied_visits, 0),
    ).toBe(4);
  });

  it("the aggregator's arms (analytics_aggregates.holdout_visits, treat_arm) count it too", async () => {
    medoraLikeDay();
    expect(await armTotals(h.d1, "acme", T - HOUR, T + HOUR)).toEqual({
      treat: { visits: 12, conversions: 2 },
      holdout: { visits: 3, conversions: 0 },
    });
  });

  it("a visit with no signal is in no arm, and is neither eligible nor uncounted", async () => {
    medoraLikeDay();
    await rebuildDay(h.d1, "acme", D1, NOW);
    const none = (await loadReportInput(h.d1, "acme", NOW, true)).outcomes.filter(
      (o) => o.arm === "none",
    );
    expect(none.reduce((s, o) => s + o.visits, 0)).toBe(5);
    // signal 0: outside the test's population, so not held against it.
    expect(none.every((o) => o.signal === 0)).toBe(true);
    const r = await loadLiftReport(h.d1, "acme", NOW, true);
    expect(r.checks?.uncounted_share).toBe(0);
  });

  it("a visit that landed without versions and then opened the homepage is counted once, on the page that gave it its arm", async () => {
    // The product page first (the root's body, so an arm already), then the
    // homepage, written. One treat visit, in the row of the product page.
    h.ev({
      ts: T,
      type: "personalization_skipped",
      visit: vid(1),
      arm: "treat",
      cohort: "skipped",
      page: PRODUCT,
      body: ROOT_BODY,
    });
    h.ev({
      ts: T + 60_000,
      type: "variant_shown",
      visit: vid(1),
      arm: "treat",
      cohort: "personalized",
      page: "/",
      body: ROOT_BODY,
    });
    const { rows } = await computeDay(h.d1, "acme", D1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      arm: "treat",
      page_path: PRODUCT,
      visits: 1,
      applied_visits: 1,
    });
  });
});
