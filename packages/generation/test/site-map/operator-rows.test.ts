/**
 * The Change dialog's rows (docs/specs/site-shaped-intents.md §18.2,
 * privacy review condition 5): "Not a page to use" keeps the path and the kind
 * only, and Remove takes any single row away for good.
 */
import { describe, expect, it, vi } from "vitest";
import { handleSiteMapSet } from "../../src/admin/site-map.ts";
import type { SiteModelCall } from "../../src/site-map/model.ts";
import { type SiteEnv, runSiteRead } from "../../src/site-map/run.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { MODEL_ENV } from "../model-env.ts";

const NOW = Date.UTC(2026, 9, 5, 12);
const USER = { id: "u", email: "a@b.c", role: "customer", customer_id: "novbe" };
const PAGE = `<html lang="az"><body><nav>
  <a href="/tarifler">Qiymətlər</a><a href="/imkanlar">İmkanlar</a>
</nav></body></html>`;

function setup() {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, live_at) VALUES ('novbe', 'novbe', 'queue.test', 'active', 1, 1)",
  ).run();
  const kv = makeKv();
  const env = { DB: d1, VARIANTS: kv, ...MODEL_ENV } as unknown as SiteEnv;
  const adminEnv = { ...env, ENVIRONMENT: "test", ALLOWED_ORIGINS: "https://app.test" } as never;
  const ins = db.prepare(
    "INSERT INTO site_paths (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at, missing_since) VALUES ('novbe', ?, 'az', ?, ?, ?, ?, 1, 1, ?)",
  );
  return { env, adminEnv, db, kv, ins };
}

const post = (body: unknown) =>
  new Request("https://gen.test/admin/site-map", { method: "POST", body: JSON.stringify(body) });

function row(db: ReturnType<typeof makeSqliteD1>["db"], path: string) {
  return db
    .prepare(
      "SELECT kind, confidence, label FROM site_paths WHERE customer_id = 'novbe' AND path = ?",
    )
    .get(path) as Record<string, unknown> | undefined;
}

const noModel: SiteModelCall = vi.fn(async () => ({ ok: false as const, error: "unused" }));

describe('"Not a page to use" (kind none)', () => {
  it("keeps the path and the kind only; the stored link text is dropped", async () => {
    const { adminEnv, db, ins } = setup();
    ins.run("/tarifler", "price", "high", "Qiymətlər", "/", null);
    const res = await handleSiteMapSet(
      post({ customer_id: "novbe", paths: [{ path: "/tarifler", kind: "none" }] }),
      adminEnv,
      USER,
    );
    expect(res.status).toBe(200);
    expect(row(db, "/tarifler")).toEqual({ kind: "none", confidence: "operator", label: null });
    // Changing it back to a kind does not bring the text back.
    await handleSiteMapSet(
      post({ customer_id: "novbe", paths: [{ path: "/tarifler", kind: "price" }] }),
      adminEnv,
      USER,
    );
    expect(row(db, "/tarifler")).toEqual({ kind: "price", confidence: "operator", label: null });
  });

  it("another kind keeps the text that named it", async () => {
    const { adminEnv, db, ins } = setup();
    ins.run("/imkanlar", "features", "high", "İmkanlar", "/", null);
    await handleSiteMapSet(
      post({ customer_id: "novbe", paths: [{ path: "/imkanlar", kind: "proof" }] }),
      adminEnv,
      USER,
    );
    expect(row(db, "/imkanlar")).toEqual({
      kind: "proof",
      confidence: "operator",
      label: "İmkanlar",
    });
  });
});

describe("Remove (delete: [path]) takes any single row away", () => {
  it("an operator-added row is deleted, and no read brings it back", async () => {
    const { env, adminEnv, db, ins } = setup();
    ins.run("/yay-endirimi", "price", "operator", null, "", null);
    await handleSiteMapSet(
      post({ customer_id: "novbe", delete: ["/yay-endirimi"] }),
      adminEnv,
      USER,
    );
    expect(row(db, "/yay-endirimi")).toBeUndefined();
    await runSiteRead(
      env,
      "novbe",
      [
        {
          pagePath: "/",
          pageUrl: "https://queue.test/",
          html: PAGE,
          manifest: null,
          lang: "az",
          source: "fetch",
        },
      ],
      { product: "", now: NOW, call: noModel },
    );
    expect(row(db, "/yay-endirimi")).toBeUndefined();
  });

  it("a found row whose link is already gone is deleted", async () => {
    const { adminEnv, db, ins } = setup();
    ins.run("/kohne", "learn", "model", null, "/", 5);
    await handleSiteMapSet(post({ customer_id: "novbe", delete: ["/kohne"] }), adminEnv, USER);
    expect(row(db, "/kohne")).toBeUndefined();
  });

  it("a found row still in the menus stays set aside: the operator's none, no text, and a read never restores it", async () => {
    const { env, adminEnv, db, ins, kv } = setup();
    ins.run("/tarifler", "price", "high", "Qiymətlər", "/", null);
    ins.run("/imkanlar", "features", "operator", "İmkanlar", "/", null);
    const res = await handleSiteMapSet(
      post({ customer_id: "novbe", delete: ["/tarifler", "/imkanlar"] }),
      adminEnv,
      USER,
    );
    const view = (await res.json()) as { paths: Array<Record<string, unknown>> };
    expect(view.paths.map((p) => [p.path, p.kind, p.label])).toEqual([
      ["/imkanlar", "none", null],
      ["/tarifler", "none", null],
    ]);
    await runSiteRead(
      env,
      "novbe",
      [
        {
          pagePath: "/",
          pageUrl: "https://queue.test/",
          html: PAGE,
          manifest: null,
          lang: "az",
          source: "fetch",
        },
      ],
      { product: "", now: NOW, call: noModel },
    );
    expect(row(db, "/tarifler")).toEqual({ kind: "none", confidence: "operator", label: null });
    expect(row(db, "/imkanlar")).toEqual({ kind: "none", confidence: "operator", label: null });
    const b = JSON.parse(kv.store.get("v1:vm:novbe") ?? "{}");
    expect(b.pm["/tarifler"]).toEqual(["none", 1]);
  });

  it("a path with no row is ignored", async () => {
    const { adminEnv } = setup();
    const res = await handleSiteMapSet(
      post({ customer_id: "novbe", delete: ["/nope"] }),
      adminEnv,
      USER,
    );
    expect(res.status).toBe(200);
  });
});

describe("a Remove kept as the operator's none still ends (privacy review §13.3)", () => {
  const read = (env: SiteEnv, html: string, now: number) =>
    runSiteRead(
      env,
      "novbe",
      [
        {
          pagePath: "/",
          pageUrl: "https://queue.test/",
          html,
          manifest: null,
          lang: "az",
          source: "fetch",
        },
      ],
      { product: "", now, call: noModel },
    );
  const GONE = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
  const DAY = 24 * 60 * 60_000;

  function missing(db: ReturnType<typeof makeSqliteD1>["db"], path: string) {
    return (
      db
        .prepare("SELECT missing_since FROM site_paths WHERE customer_id = 'novbe' AND path = ?")
        .get(path) as { missing_since: number | null } | undefined
    )?.missing_since;
  }

  it("goes missing in a complete read with kind and label untouched, then a Remove deletes it", async () => {
    const { env, adminEnv, db, ins } = setup();
    ins.run("/tarifler", "price", "high", "Qiymətlər", "/", null);
    await handleSiteMapSet(post({ customer_id: "novbe", delete: ["/tarifler"] }), adminEnv, USER);
    expect(row(db, "/tarifler")).toEqual({ kind: "none", confidence: "operator", label: null });
    await read(env, GONE, NOW);
    expect(missing(db, "/tarifler")).toBe(NOW);
    expect(row(db, "/tarifler")).toEqual({ kind: "none", confidence: "operator", label: null });
    await handleSiteMapSet(post({ customer_id: "novbe", delete: ["/tarifler"] }), adminEnv, USER);
    expect(row(db, "/tarifler")).toBeUndefined();
  });

  it("is purged 30 days after its link went missing; seen again, it stays", async () => {
    const { env, adminEnv, db, ins } = setup();
    ins.run("/tarifler", "price", "high", "Qiymətlər", "/", null);
    ins.run("/imkanlar", "features", "high", "İmkanlar", "/", null);
    await handleSiteMapSet(
      post({ customer_id: "novbe", delete: ["/tarifler", "/imkanlar"] }),
      adminEnv,
      USER,
    );
    const both = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "").replace(
      '<a href="/imkanlar">İmkanlar</a>',
      "",
    );
    await read(env, both, NOW);
    expect(missing(db, "/imkanlar")).toBe(NOW);
    // /imkanlar comes back; /tarifler stays gone.
    await read(env, GONE, NOW + DAY);
    expect(missing(db, "/imkanlar")).toBeNull();
    expect(row(db, "/imkanlar")).toEqual({ kind: "none", confidence: "operator", label: null });
    await read(env, GONE, NOW + 31 * DAY);
    expect(row(db, "/tarifler")).toBeUndefined();
    expect(row(db, "/imkanlar")).toEqual({ kind: "none", confidence: "operator", label: null });
  });

  it("a row the operator added never goes missing", async () => {
    const { env, db, ins } = setup();
    ins.run("/yay-endirimi", "price", "operator", null, "", null);
    await read(env, PAGE, NOW);
    await read(env, PAGE, NOW + 40 * DAY);
    expect(row(db, "/yay-endirimi")).toEqual({
      kind: "price",
      confidence: "operator",
      label: null,
    });
    expect(missing(db, "/yay-endirimi")).toBeNull();
  });
});
