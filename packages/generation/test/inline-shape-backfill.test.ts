/**
 * A manifest without shapes gets them from the live page once and is stored.
 */
import type { Manifest } from "@rawuser/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ensureInlineShapes,
  htmlLang,
  lacksShapes,
  resetReads,
} from "../src/inline-shape-backfill.ts";
import { pageLinksOf, resetPageLinks } from "../src/page-links.ts";

const HTML =
  '<main><h1 class="h">We build <em>hand-made</em> products.</h1><a class="b"><svg></svg> Go</a></main>';

function fakeDb(domain: string | null) {
  const runs: unknown[][] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes("FROM customers") ? (domain ? { domain } : null) : null),
        run: async () => {
          runs.push([sql, ...args]);
          return { success: true };
        },
      }),
    })),
  } as unknown as D1Database;
  return { db, runs };
}

const bare: Manifest = {
  "hero.headline": {
    css: [".h"],
    text: ["We build hand-made products."],
    structural: "first h1 in main",
  },
  "hero.cta.label": { css: [".b"], text: ["Go"], structural: "first a in main" },
};

describe("ensureInlineShapes", () => {
  it("remembers where each button goes for the action check, in this isolate only", async () => {
    resetReads();
    resetPageLinks();
    const { db } = fakeDb("tallybook.test");
    const html =
      '<main><h1 class="h">Invoices.</h1><a class="b" href="/signup/">Start free</a></main>';
    await ensureInlineShapes(
      "ml",
      "/",
      bare,
      db,
      vi.fn(async () => html),
    );
    expect(pageLinksOf("ml", "/").get("hero.cta.label")).toBe("/signup/");
    expect(pageLinksOf("ml", "/other").size).toBe(0);
  });

  it("reads the page, attaches shapes and stores the manifest once", async () => {
    const { db, runs } = fakeDb("lumera.test");
    const fetchHtml = vi.fn(async () => HTML);
    const out = await ensureInlineShapes("lumera", "/", bare, db, fetchHtml);
    // Only the recorded host (the /bot page).
    expect(fetchHtml).toHaveBeenCalledWith("https://lumera.test/", { sameHostAs: "lumera.test" });
    expect(out["hero.headline"]?.inline?.emphasis_phrase).toBe("hand-made");
    expect(out["hero.cta.label"]?.inline?.icons).toBe("leading");
    const updates = runs.filter((r) => String(r[0]).includes("UPDATE element_manifests"));
    expect(updates.length).toBe(1);
    expect(runs.some((r) => String(r[0]).includes("manifest_health"))).toBe(true);
    expect(lacksShapes(out)).toBe(false);
    // Second call: nothing to do, no fetch.
    const again = await ensureInlineShapes("lumera", "/", out, db, fetchHtml);
    expect(again).toBe(out);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("refreshes stale lengths and the text signature from the live page, once per ten minutes", async () => {
    resetReads();
    const shaped: Manifest = {
      "hero.headline": {
        css: [".h"],
        text: ["Old headline nobody sees any more"],
        structural: "first h1 in main",
        original_char_length: 305,
        original_word_count: 40,
        inline: {
          icons: "none",
          emphasis: 1,
          emphasis_phrase: "hand-made",
          split: false,
          animated_text: false,
        },
      },
    };
    const { db, runs } = fakeDb("lumera.test");
    const fetchHtml = vi.fn(async () => HTML);
    const out = await ensureInlineShapes("refresh", "/", shaped, db, fetchHtml);
    expect(out["hero.headline"]?.original_char_length).toBe("We build hand-made products.".length);
    expect(out["hero.headline"]?.original_word_count).toBe(4);
    expect(out["hero.headline"]?.text[0]).toBe("We build hand-made products.");
    expect(out["hero.headline"]?.inline?.emphasis_phrase).toBe("hand-made");
    const updates = () => runs.filter((r) => String(r[0]).includes("UPDATE element_manifests"));
    expect(updates().length).toBe(1);
    // Within ten minutes the page is not read again.
    await ensureInlineShapes("refresh", "/", out, db, fetchHtml);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    // A fresh isolate reads again; nothing changed, nothing stored.
    resetReads();
    const same = await ensureInlineShapes("refresh", "/", out, db, fetchHtml);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(same).toBe(out);
    expect(updates().length).toBe(1);
  });

  it("records the parts the live page no longer has", async () => {
    resetReads();
    // Three parts the page lost: a headline, a button the operator turned
    // on, and a button that stays as built (lib/button-rewrite.ts). The last
    // is not a part Rawuser writes, so its loss is not reported.
    const stale = {
      "hero.headline": { css: [".h"], text: ["x"], structural: "h1", original_char_length: 28 },
      "features.headline": { css: [".gone-h2"], text: ["y"], structural: "h2" },
      "cta.cta.label": {
        css: [".gone"],
        text: ["Go"],
        structural: "a",
        original_char_length: 2,
        rewrite: true,
      },
      "pricing.cta.label": { css: [".gone-too"], text: ["Plans"], structural: "a" },
    } as Manifest;
    const { db, runs } = fakeDb("lumera.test");
    await ensureInlineShapes("health", "/", stale, db, async () => HTML);
    const health = runs.find((r) => String(r[0]).includes("manifest_health"));
    expect(health).toBeDefined();
    expect(health?.[4]).toBe('["features.headline","cta.cta.label"]');
  });

  it("leaves the manifest alone without a domain or when the page cannot be read", async () => {
    const noDomain = fakeDb(null);
    expect(await ensureInlineShapes("x", "/", bare, noDomain.db, async () => HTML)).toBe(bare);
    const failing = fakeDb("lumera.test");
    expect(
      await ensureInlineShapes("lumera", "/", bare, failing.db, async () => {
        throw new Error("timeout");
      }),
    ).toBe(bare);
    expect(failing.runs.length).toBe(0);
  });
});

describe("ensureInlineShapes and a country redirect", () => {
  it("keeps the shape but drops the phrase when the fetched page is in another language", async () => {
    const { db } = fakeDb("lumera.test");
    const az =
      '<html lang="az"><main><h1 class="h">AI-əsaslı <em>məhsullar</em> yaradırıq.</h1><a class="b"><svg></svg> Get</a></main></html>';
    const out = await ensureInlineShapes("lumera", "/", bare, db, async () => az, "en");
    expect(out["hero.headline"]?.inline?.emphasis).toBe(1);
    expect(out["hero.headline"]?.inline?.emphasis_phrase).toBeUndefined();
    const same = await ensureInlineShapes("lumera", "/az", bare, db, async () => az, "az");
    expect(same["hero.headline"]?.inline?.emphasis_phrase).toBe("məhsullar");
    expect(htmlLang(az)).toBe("az");
    expect(htmlLang("<html><body></body></html>")).toBeNull();
  });
});

describe("lacksShapes reads a split again until it has its template", () => {
  it("is true for a split without a template, false once it has one or the operator chose plain", () => {
    const base = { css: ["h1"], text: [], structural: "" };
    const split = { icons: "none" as const, emphasis: 0, split: true, animated_text: false };
    expect(lacksShapes({ "hero.headline": { ...base, inline: split } } as never)).toBe(true);
    expect(
      lacksShapes({
        "hero.headline": { ...base, inline: { ...split, template: "a b c d e" } },
      } as never),
    ).toBe(false);
    expect(lacksShapes({ "hero.headline": { ...base, plain: true, inline: split } } as never)).toBe(
      false,
    );
  });
});
