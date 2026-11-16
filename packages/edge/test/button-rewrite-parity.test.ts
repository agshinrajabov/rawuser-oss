/**
 * One rule in two places (docs/specs/button-rewrite.md): generation wrote
 * the button switch's predicate first (lint/cta-action.ts and
 * lib/button-rewrite.ts); the shared copy is what the visitor bundle and the
 * edge stand on. Until generation imports the shared one, this holds the two
 * to the same answers, on the functions and on the bundle each side writes.
 */
import {
  type ElementTargets,
  type Manifest,
  isButtonLabelPath,
  isOffButton,
  rewriteOn,
  writtenManifest,
} from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { writeVisitorBundle } from "../../generation/src/admin/onboard.ts";
import * as gen from "../../generation/src/lib/button-rewrite.ts";
import { isButtonLabelPath as genIsButtonLabelPath } from "../../generation/src/lint/cta-action.ts";
import { makeKv, makeSqliteD1 } from "../../generation/test/admin/sqlite-d1.ts";
import { bundleFromD1 } from "../src/bundle-writeback.ts";

const part = (css: string, extra: Record<string, unknown> = {}): ElementTargets =>
  ({ css: [css], text: [], structural: css, ...extra }) as ElementTargets;

const PATHS = [
  "hero.headline",
  "hero.body",
  "hero.cta.label",
  "hero.cta.href",
  "cta.cta.label",
  "cta.cta.href",
  "cta.headline",
  "pricing.cta.label",
  "pricing.cta.href",
  "forms.submit_label",
  "forms.headline",
  "features.body",
  "label",
  ".label",
  "hero.cta.label.href",
  "hero.labels",
  "nav.submit_label",
  "HERO.CTA.LABEL",
  "",
];

const SWITCHES: unknown[] = [undefined, true, false, "true", 1, 0, null, {}, []];

const MANIFESTS: Manifest[] = [
  {},
  { "hero.headline": part("h1") },
  { "hero.cta.label": part("a"), "hero.cta.href": part("a") },
  { "hero.cta.label": part("a", { rewrite: true }), "hero.cta.href": part("a") },
  {
    "hero.headline": part("h1"),
    "hero.cta.label": part("a.hero"),
    "hero.cta.href": part("a.hero"),
    "cta.cta.label": part("a.closing", { rewrite: true }),
    "cta.cta.href": part("a.closing"),
    "pricing.cta.label": part("a.buy", { rewrite: "true" }),
    "pricing.cta.href": part("a.buy"),
    "forms.submit_label": part("form button", { rewrite: false }),
  },
  // An href with no label beside it, and a label with a switch of the wrong type.
  { "hero.cta.href": part("a"), "cta.cta.label": part("a", { rewrite: 1 }) },
  { "forms.submit_label": part("button", { rewrite: true, skip: true }) },
];

describe("the button switch: shared and generation give the same answers", () => {
  it("isButtonLabelPath", () => {
    for (const path of PATHS) {
      expect(isButtonLabelPath(path), path).toBe(genIsButtonLabelPath(path));
    }
  });

  it("rewriteOn and isOffButton", () => {
    for (const v of SWITCHES) {
      const entry = part("a", v === undefined ? {} : { rewrite: v });
      expect(rewriteOn(entry), String(v)).toBe(gen.rewriteOn(entry));
      for (const path of PATHS) {
        expect(isOffButton(path, entry), `${path} ${String(v)}`).toBe(gen.isOffButton(path, entry));
      }
    }
    expect(rewriteOn(undefined)).toBe(gen.rewriteOn(undefined));
    expect(rewriteOn(null)).toBe(gen.rewriteOn(null));
  });

  it("writtenManifest, part for part and in the same order", () => {
    for (const m of MANIFESTS) {
      const ours = writtenManifest(m);
      const theirs = gen.writtenManifest(m);
      expect(ours).toEqual(theirs);
      expect(Object.keys(ours)).toEqual(Object.keys(theirs));
    }
  });
});

describe("the bundle each worker writes from one database, buttons on and off", () => {
  function seed() {
    const { d1, db } = makeSqliteD1();
    db.prepare(
      "INSERT INTO customers (id, slug, domain, status, created_at, holdout_percent) VALUES ('acme', 'acme', 'acme.test', 'active', 1, 20)",
    ).run();
    const manifest = db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('acme', ?, ?, 1, 'https://acme.test/', 1)",
    );
    manifest.run("/", JSON.stringify(MANIFESTS[4]));
    manifest.run("/contact", JSON.stringify({ "forms.submit_label": part("form button") }));
    // The hero button is off and counted.
    db.prepare(
      `INSERT INTO conversion_targets (customer_id, section_path, label, conversion_label, css_selectors, text_selectors, structural_selector, enabled, created_at, updated_at)
       VALUES ('acme', 'hero.cta', 'Start free', 'trial_start', ?, '[]', 'a.hero', 1, 1, 1)`,
    ).run(JSON.stringify(["a.hero"]));
    return { d1, db };
  }

  it("the edge's write-back equals generation's bundle: no off button, the counted one in conv", async () => {
    const { d1, db } = seed();
    const kv = makeKv();
    await writeVisitorBundle({ DB: d1, VARIANTS: kv }, "acme");
    const fromGeneration = JSON.parse(kv.store.get("v1:vm:acme") ?? "null");
    const fromEdge = await bundleFromD1({ DB: d1, VARIANTS: kv }, "acme");
    expect(fromEdge).toEqual(fromGeneration);

    expect(Object.keys(fromEdge.pages["/"] ?? {})).toEqual([
      "hero.headline",
      "cta.cta.label",
      "cta.cta.href",
    ]);
    expect(fromEdge.pages["/contact"]).toEqual({});
    expect(fromEdge.conv).toEqual([
      {
        section_path: "hero.cta",
        conversion_label: "trial_start",
        css: ["a.hero"],
        text: [],
        structural: "a.hero",
      },
    ]);
    // The switch is an operator setting: not in what a browser may be sent.
    expect(JSON.stringify(fromEdge)).not.toContain("rewrite");
    // The stored manifest still holds every part and the switch.
    const stored = JSON.parse(
      (
        db
          .prepare(
            "SELECT manifest FROM element_manifests WHERE customer_id = 'acme' AND page_path = '/'",
          )
          .get() as { manifest: string }
      ).manifest,
    );
    expect(Object.keys(stored)).toEqual(Object.keys(MANIFESTS[4] ?? {}));
    expect(stored["cta.cta.label"].rewrite).toBe(true);
  });
});
