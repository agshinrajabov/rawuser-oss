/**
 * Rich writers on demand (2026-09-30): writeHideRules writes the hide rules
 * and the rich key from the same confirmed manifests, and the 6-hour cron
 * sweeps every customer with a confirmed manifest so customers confirmed
 * before the rich key existed get it without a manual production write.
 */

import { hideRulesKey, richKey } from "@rawuser/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/orchestrator.ts", () => ({
  orchestrate: vi.fn(),
  regenerateOne: vi.fn(),
}));

const { sweepHideRules, writeHideRules } = await import("../../src/admin/onboard.ts");
const { default: worker } = await import("../../src/index.ts");

interface ManifestRow {
  customer_id: string;
  page_path: string;
  manifest: string;
  confirmed_at: number | null;
}

const template = {
  css: ["h1.hero"],
  text: [],
  structural: "first h1",
  inline: {
    icons: "none",
    emphasis: 0,
    split: true,
    animated_text: false,
    template: "Ship {g0} faster{br}with less",
  },
};
const plain = { css: ["p.lead"], text: [], structural: "first p" };

function makeEnv(rows: ManifestRow[], failFor: string[] = []) {
  const kv = new Map<string, string>();
  const VARIANTS = {
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      if (failFor.some((id) => k.endsWith(`:${id}`))) throw new Error("kv down");
      kv.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      kv.delete(k);
    }),
  } as unknown as KVNamespace;
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          bound = p;
          return stmt;
        },
        async all() {
          if (sql.includes("SELECT DISTINCT customer_id FROM element_manifests")) {
            const ids = [
              ...new Set(rows.filter((r) => r.confirmed_at !== null).map((r) => r.customer_id)),
            ];
            return { results: ids.map((customer_id) => ({ customer_id })) };
          }
          if (sql.includes("SELECT page_path, manifest FROM element_manifests")) {
            return {
              results: rows.filter((r) => r.customer_id === bound[0] && r.confirmed_at !== null),
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { env: { DB, VARIANTS }, kv };
}

const rows: ManifestRow[] = [
  {
    customer_id: "lab",
    page_path: "/",
    manifest: JSON.stringify({ "hero.headline": template }),
    confirmed_at: 1,
  },
  {
    customer_id: "lab",
    page_path: "/plain",
    manifest: JSON.stringify({ "hero.body": plain }),
    confirmed_at: 1,
  },
  {
    customer_id: "lab",
    page_path: "/draft",
    manifest: JSON.stringify({ "hero.headline": template }),
    confirmed_at: null,
  },
  {
    customer_id: "lumera",
    page_path: "/",
    manifest: JSON.stringify({ "hero.body": plain }),
    confirmed_at: 1,
  },
  {
    customer_id: "unconfirmed-only",
    page_path: "/",
    manifest: JSON.stringify({ "hero.headline": template }),
    confirmed_at: null,
  },
];

describe("writeHideRules", () => {
  it("writes the hide rules and the rich key from the confirmed manifests", async () => {
    const { env, kv } = makeEnv(rows);
    await writeHideRules(env, "lab");
    expect(JSON.parse(kv.get(hideRulesKey("lab")) ?? "null")).toEqual({
      "/": ["h1.hero"],
      "/plain": ["p.lead"],
    });
    expect(JSON.parse(kv.get(richKey("lab")) ?? "null")).toEqual(["/"]);
  });

  it("writes an empty rich list for a customer with no rich parts", async () => {
    const { env, kv } = makeEnv(rows);
    await writeHideRules(env, "lumera");
    expect(kv.get(richKey("lumera"))).toBe("[]");
  });
});

describe("sweepHideRules", () => {
  it("writes both keys for every customer with a confirmed manifest, and only those", async () => {
    const { env, kv } = makeEnv(rows);
    const r = await sweepHideRules(env);
    expect(r).toEqual({ written: ["lab", "lumera"], failed: [] });
    expect(kv.get(richKey("lab"))).toBe(JSON.stringify(["/"]));
    expect(kv.get(richKey("lumera"))).toBe("[]");
    expect(kv.has(richKey("unconfirmed-only"))).toBe(false);
    expect(kv.has(hideRulesKey("unconfirmed-only"))).toBe(false);
  });

  it("goes on past a customer whose write fails", async () => {
    const { env, kv } = makeEnv(rows, ["lab"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sweepHideRules(env);
    errSpy.mockRestore();
    expect(r).toEqual({ written: ["lumera"], failed: ["lab"] });
    expect(kv.get(richKey("lumera"))).toBe("[]");
  });

  it("runs on the 6-hour cron", async () => {
    const { env, kv } = makeEnv(rows);
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExecutionContext;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(
      { cron: "0 */6 * * *" } as ScheduledController,
      env as unknown as Parameters<typeof worker.scheduled>[1],
      ctx,
    );
    await Promise.all(pending);
    logSpy.mockRestore();
    expect(kv.get(richKey("lab"))).toBe(JSON.stringify(["/"]));
    expect(kv.get(richKey("lumera"))).toBe("[]");
  });
});

describe("the visitor bundle (2026-10-01)", () => {
  it("writeHideRules also writes every confirmed page's manifest, without the wrap measurement, to v1:vm:{customer}", async () => {
    const measured = { ...template, metrics: { v: 1, kind: "template", chars: {}, widths: [] } };
    const { env, kv } = makeEnv([
      {
        customer_id: "lab",
        page_path: "/",
        manifest: JSON.stringify({ "hero.headline": measured }),
        confirmed_at: 1,
      },
      {
        customer_id: "lab",
        page_path: "/plain",
        manifest: JSON.stringify({ "hero.body": plain }),
        confirmed_at: 1,
      },
      {
        customer_id: "lab",
        page_path: "/draft",
        manifest: JSON.stringify({ "hero.body": plain }),
        confirmed_at: null,
      },
    ]);
    await writeHideRules(env as never, "lab");
    const bundle = JSON.parse(kv.get("v1:vm:lab") ?? "null");
    expect(bundle.v).toBe(1);
    expect(Object.keys(bundle.pages).sort()).toEqual(["/", "/plain"]);
    expect(bundle.pages["/"]["hero.headline"].metrics).toBeUndefined();
    expect(bundle.pages["/"]["hero.headline"].inline.template).toBe(
      "Ship {g0} faster{br}with less",
    );
    expect(bundle.conv).toEqual([]);
  });
});
