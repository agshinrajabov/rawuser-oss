/**
 * Count it (J4 of docs/specs/pilot-gaps.md; docs/specs/refused-versions.md,
 * "What is counted"): the daily `lint-daily` line gains, per customer, the
 * rows refused of the rows written and the parts left as built of the parts
 * written, with the rules. SQLite with every migration, real statements.
 */
import type { IntentDim, SourceDim, VariantBody } from "@rawuser/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpsHeartbeat } from "../../src/cron/ops-heartbeat.ts";
import {
  type CustomerShare,
  lintShareLine,
  lintShareLines,
  lintShares,
  loadServedByCustomer,
  rulesOfReason,
} from "../../src/lib/lint-shares.ts";
import { partAsBuiltFlag } from "../../src/lib/parts-as-built.ts";
import { publishVersion } from "../../src/lib/publish-version.ts";
import { writeErrorRow } from "../../src/lib/variant-rows.ts";
import { type Harness, harness } from "../proof-harness.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const INTENTS: IntentDim[] = ["evaluation", "feature", "problem", "brand"];
const SOURCES: Array<SourceDim | "default"> = ["default", "ai", "social", "community", "organic"];

/** A body of five parts, with the other lengths, a kind and a link that are not parts. */
const fiveParts = (): VariantBody["sections"] =>
  ({
    hero: {
      kind: "hero",
      headline: "Headline words",
      headline_alt: "Headline words, longer",
      headline_alt2: "Headline",
      body: "Body words of the hero.",
      body_alt: "Body words.",
      cta: { label: "See products", href: "#never-used" },
    },
    features: { kind: "features", headline: "Section heading" },
    forms: { kind: "forms", submit_label: "Send" },
  }) as unknown as VariantBody["sections"];

async function write(
  h: Harness,
  customerId: string,
  intentDim: IntentDim,
  sourceDim: SourceDim | "default",
  opts: { asBuilt?: Array<{ path: string; rule: string }>; soft?: string[] } = {},
) {
  const sections = fiveParts() as unknown as Record<string, Record<string, unknown>>;
  for (const part of opts.asBuilt ?? []) {
    const [section, key] = part.path.split(".") as [string, string];
    const node = sections[section] as Record<string, unknown>;
    for (const k of [key, `${key}_alt`, `${key}_alt2`]) Reflect.deleteProperty(node, k);
    if (Object.keys(node).every((k) => k === "kind")) Reflect.deleteProperty(sections, section);
  }
  await publishVersion(
    h.env,
    { customerId, pagePath: "/", intentDim, sourceDim, language: "az" },
    {
      customer_id: customerId,
      profile_key: `intent:${intentDim}`,
      sections: sections as unknown as VariantBody["sections"],
      generated_at: 1,
      prompt_hash: "ph",
    },
    {
      model: "model-a",
      promptHash: "ph",
      costUsd: 0.001,
      lintFlags: [...(opts.soft ?? []), ...(opts.asBuilt ?? []).map(partAsBuiltFlag)],
    },
  );
}

const refuse = (
  h: Harness,
  customerId: string,
  intentDim: IntentDim,
  sourceDim: string,
  reason: string,
) =>
  writeErrorRow(
    customerId,
    { intent_dim: intentDim, source_dim: sourceDim as SourceDim },
    `v1:variant:${customerId}:${intentDim}:${sourceDim}`,
    reason,
    h.env.DB,
    "/",
    "model-a",
  );

const REASON_BODY =
  "lint: 3 of 5 parts could not be written; hero.body length-drift (80 characters; the original has 64, write 61 to 67); hero.headline length-drift (x); features.headline length-drift (y)";
const REASON_TWIN =
  "lint: two parts still say the same thing; features.headline slot-duplicate:hero.headline (İstehsal etdiyimiz əlavələr)";

/** The pilot after a rewrite: 20 rows, 2 refused, 3 of the 18 written leave a part as built. */
async function medora(h: Harness) {
  h.customer("medora");
  let n = 0;
  for (const intent of INTENTS) {
    for (const source of SOURCES) {
      n++;
      if (n === 4) await refuse(h, "medora", intent, source, REASON_BODY);
      else if (n === 19) await refuse(h, "medora", intent, source, REASON_TWIN);
      else if (n === 7 || n === 12) {
        await write(h, "medora", intent, source, {
          soft: ["length-drift", "alt-copies"],
          asBuilt: [{ path: "hero.body", rule: "length-drift" }],
        });
      } else if (n === 15) {
        await write(h, "medora", intent, source, {
          asBuilt: [{ path: "features.headline", rule: "number-not-in-brief" }],
        });
      } else await write(h, "medora", intent, source, { soft: ["length-drift"] });
    }
  }
}

describe("lint-daily, per customer", () => {
  it("says the rows refused of the rows written and the parts as built of the parts written, with the rules", async () => {
    const h = harness();
    await medora(h);
    // A customer with nothing refused and nothing as built is not named.
    h.customer("quiet");
    await write(h, "quiet", "brand", "default");
    // A test customer never is.
    h.customer("lab", { plan: "test" });
    await refuse(h, "lab", "brand", "ai", REASON_BODY);
    await write(h, "lab", "brand", "default", {
      asBuilt: [{ path: "hero.body", rule: "length-drift" }],
    });

    const result = await runOpsHeartbeat(h.env);
    expect(result.alerted).toContain("lint-daily");
    const text = h.alerts.find((a) => a.includes("lint-daily")) ?? "";
    expect(text.split("\n")).toEqual([
      "[rawuser ops] lint-daily: 2 versions refused by the copy checks have no earlier text yet, so visitors get the nearest version until a retry passes (every 6 hours).",
      "Most: length-drift 3, slot-duplicate 1.",
      // 18 written rows of five parts each: 87 in the bodies and 3 as built.
      "medora: refused 2 of 20 (length-drift 3, slot-duplicate 1), as built 3 of 90 parts (length-drift 2, number-not-in-brief 1)",
    ]);
    // Its shape: a customer id, numbers and rule names. No path, no copy.
    expect(text).not.toMatch(/hero\.|features\.|forms\./);
    expect(text).not.toContain("80 characters");
    expect(text).not.toContain("İstehsal");
    expect(text).not.toMatch(/quiet|lab|[\u2014\u2013]/);
    expect(text.length).toBeLessThan(400);

    // Once a day.
    const again = await runOpsHeartbeat(h.env);
    expect(again.deduped).toContain("lint-daily");
    expect(h.alerts.filter((a) => a.includes("lint-daily"))).toHaveLength(1);
  });

  it("with nothing refused, the parts left as built are still said", async () => {
    const h = harness();
    h.customer("lumera");
    await write(h, "lumera", "problem", "ai", {
      asBuilt: [{ path: "hero.body", rule: "length-drift" }],
    });
    await write(h, "lumera", "problem", "default");
    await runOpsHeartbeat(h.env);
    const text = h.alerts.find((a) => a.includes("lint-daily")) ?? "";
    expect(text.split("\n")).toEqual([
      "[rawuser ops] lint-daily: No version is refused by the copy checks.",
      "lumera: refused 0 of 2, as built 1 of 10 parts (length-drift 1)",
    ]);
  });

  it("nothing refused and nothing as built: no line at all", async () => {
    const h = harness();
    h.customer("lumera");
    await write(h, "lumera", "problem", "default", { soft: ["length-drift"] });
    const result = await runOpsHeartbeat(h.env);
    expect(result.alerted).not.toContain("lint-daily");
    expect(h.alerts.filter((a) => a.includes("lint-daily"))).toEqual([]);
  });

  it("rows of an intent the site does not serve are in no count", async () => {
    const h = harness();
    await medora(h);
    // Pricing was written before the site map folded it; one of its rows is an old refusal.
    await write(h, "medora", "pricing", "default", {
      asBuilt: [{ path: "hero.body", rule: "length-drift" }],
    });
    await refuse(h, "medora", "pricing", "ai", REASON_BODY);
    h.db
      .prepare(
        `UPDATE customers SET served_intents = '["evaluation","feature","problem","brand"]' WHERE id = 'medora'`,
      )
      .run();
    await runOpsHeartbeat(h.env);
    const text = h.alerts.find((a) => a.includes("lint-daily")) ?? "";
    expect(text).toContain("lint-daily: 2 versions refused");
    expect(text).toContain("medora: refused 2 of 20 (");
    expect(text).toContain("as built 3 of 90 parts");
  });
});

describe("the shares themselves", () => {
  it("counts a body's parts without its kind, its link and its other lengths", async () => {
    const h = harness();
    h.customer("acme");
    await write(h, "acme", "brand", "default", {
      asBuilt: [{ path: "forms.submit_label", rule: "length-drift" }],
    });
    const shares = await lintShares(h.env.DB, [], await loadServedByCustomer(h.env.DB));
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      customer_id: "acme",
      refused: 0,
      rows: 1,
      asBuilt: 1,
      // Four in the body (headline, paragraph, label, section heading) and the one as built.
      parts: 5,
    });
  });

  it("a written row without a kept body gives no parts to count: the line says the number alone", () => {
    const share: CustomerShare = {
      customer_id: "old",
      refused: 1,
      rows: 30,
      refusedRules: new Map([["length-drift", 1]]),
      asBuilt: 0,
      parts: null,
      asBuiltRules: new Map(),
    };
    expect(lintShareLine(share)).toBe("old: refused 1 of 30 (length-drift 1), as built 0 parts");
  });

  it("reads the rules of a reason, also behind the cause a refusal starts with", () => {
    expect(rulesOfReason(REASON_BODY)).toEqual(["length-drift", "length-drift", "length-drift"]);
    expect(rulesOfReason(REASON_TWIN)).toEqual(["slot-duplicate"]);
    expect(
      rulesOfReason("lint: no part is left to write; hero.cta.label cta-action-changed (x)"),
    ).toEqual(["cta-action-changed"]);
  });

  it("names six customers at most, the most affected first, and counts the rest", () => {
    const shares: CustomerShare[] = Array.from({ length: 8 }, (_, i) => ({
      customer_id: `c${i}`,
      refused: 8 - i,
      rows: 30,
      refusedRules: new Map(),
      asBuilt: 0,
      parts: 150,
      asBuiltRules: new Map(),
    }));
    const lines = lintShareLines(shares).split("\n").filter(Boolean);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("c0: refused 8 of 30, as built 0 of 150 parts");
    expect(lines[6]).toBe("and 2 more");
    expect(lintShareLines([])).toBe("");
  });
});
