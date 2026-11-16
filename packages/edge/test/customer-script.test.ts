import { hideRulesKey, richKey, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { RICH_ETAG } from "../src/rich-asset.ts";

function kvWith(data: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    kv: {
      async get(key: string) {
        reads.push(key);
        return data[key] ?? null;
      },
      async put() {},
      async delete() {},
    } as unknown as KVNamespace,
  };
}
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const env = (kv: KVNamespace) => ({
  VARIANTS: kv,
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  PREVIEW_TOKEN: "",
});

describe("/s/{customer}.js", () => {
  it("serves the snippet prefixed with the customer's config and hide rules", async () => {
    const { kv } = kvWith({
      [hideRulesKey("lumera")]: JSON.stringify({ "/": ["h1.hero-title", "a.btn-primary"] }),
    });
    const res = await worker.fetch(new Request("https://edge.test/s/lumera.js"), env(kv), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(
      body.startsWith(
        'window.__rw={"c":"lumera","e":"https://edge.test","h":{"/":["h1.hero-title","a.btn-primary"]},"nt":1};',
      ),
    ).toBe(true);
    expect(body).toContain("rawuser_capture");
    const etag = res.headers.get("etag") ?? "";
    const again = await worker.fetch(
      new Request("https://edge.test/s/lumera.js", { headers: { "if-none-match": etag } }),
      env(kv),
      ctx,
    );
    expect(again.status).toBe(304);
  });

  it("works with no rules yet, and the etag changes when rules change", async () => {
    const a = await (
      await worker.fetch(new Request("https://edge.test/s/new-co.js"), env(kvWith({}).kv), ctx)
    ).headers.get("etag");
    const b = await (
      await worker.fetch(
        new Request("https://edge.test/s/new-co.js"),
        env(kvWith({ [hideRulesKey("new-co")]: '{"/":["h1"]}' }).kv),
        ctx,
      )
    ).headers.get("etag");
    expect(a).not.toBe(b);
  });

  it("lists the pages that need the rich writers as x, read in the same pass", async () => {
    const { kv, reads } = kvWith({
      [hideRulesKey("lab")]: JSON.stringify({ "/": ["h1"], "/lines": ["h1"] }),
      [richKey("lab")]: JSON.stringify(["/", "/lines"]),
    });
    const res = await worker.fetch(new Request("https://edge.test/s/lab.js"), env(kv), ctx);
    const body = await res.text();
    expect(
      body.startsWith(
        'window.__rw={"c":"lab","e":"https://edge.test","h":{"/":["h1"],"/lines":["h1"]},"nt":1,"x":["/","/lines"]};',
      ),
    ).toBe(true);
    expect(reads).toContain(richKey("lab"));
  });

  it("carries no x on a plain site, an empty list, or a key that is not a list of paths", async () => {
    for (const raw of [undefined, "[]", "not json", '{"/":true}']) {
      const data: Record<string, string> = { [hideRulesKey("plain")]: '{"/":["h1"]}' };
      if (raw !== undefined) data[richKey("plain")] = raw;
      const res = await worker.fetch(
        new Request("https://edge.test/s/plain.js"),
        env(kvWith(data).kv),
        ctx,
      );
      const body = await res.text();
      expect(
        body.startsWith(
          'window.__rw={"c":"plain","e":"https://edge.test","h":{"/":["h1"]},"nt":1};',
        ),
      ).toBe(true);
    }
  });

  it("changes its etag when the rich list changes", async () => {
    const etag = async (data: Record<string, string>) =>
      (
        await worker.fetch(new Request("https://edge.test/s/lab.js"), env(kvWith(data).kv), ctx)
      ).headers.get("etag");
    const a = await etag({ [hideRulesKey("lab")]: '{"/":["h1"]}' });
    const b = await etag({ [hideRulesKey("lab")]: '{"/":["h1"]}', [richKey("lab")]: '["/"]' });
    expect(a).not.toBe(b);
  });

  it("rejects ids that are not customer slugs", async () => {
    const res = await worker.fetch(
      new Request("https://edge.test/s/..%2Fetc.js"),
      env(kvWith({}).kv),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("the script's cache policy (docs/specs/late-tag.md, The file from the browser's cache)", () => {
  const FRESH = "public, max-age=300";
  const STALE_OK = "public, max-age=300, stale-while-revalidate=86400";
  const BEFORE_LIVE = "public, max-age=60";
  /** A live customer's bundle: one confirmed page. */
  const LIVE = { v: 1, pages: { "/": { "hero.headline": { css: ["h1"] } } }, conv: [] };

  /** A KV that hands a JSON read its object, as the bundle read asks for it. */
  function kvJson(data: Record<string, unknown>): KVNamespace {
    return {
      async get(key: string, opts?: string | { type?: string }) {
        const v = data[key];
        if (v === undefined) return null;
        const type = typeof opts === "string" ? opts : opts?.type;
        return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
      },
      async put() {},
      async delete() {},
    } as unknown as KVNamespace;
  }
  const get = (path: string, kv: KVNamespace, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://edge.test${path}`, { headers }), env(kv), ctx);

  it("/s/{id}.js: fresh five minutes, then stale for a day while the browser refreshes it", async () => {
    const kv = kvJson({
      [hideRulesKey("lumera")]: '{"/":["h1"]}',
      [visitorBundleKey("lumera")]: LIVE,
    });
    const res = await get("/s/lumera.js", kv);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(STALE_OK);
    // No bundle read (the tag before go live, or a failed read): we cannot
    // know it is not an audit, so no stale serving (privacy review,
    // 2026-10-12), and one minute only.
    const MINUTE = "public, max-age=60";
    expect((await get("/s/new-co.js", kvJson({}))).headers.get("cache-control")).toBe(MINUTE);
    const rulesOnly = kvJson({ [hideRulesKey("lumera")]: '{"/":["h1"]}' });
    expect((await get("/s/lumera.js", rulesOnly)).headers.get("cache-control")).toBe(MINUTE);
  });

  it("/s/{id}.js: the etag behaves as before, and the 304 renews the same policy", async () => {
    const bundle = { [visitorBundleKey("lumera")]: LIVE };
    const kv = kvJson({ [hideRulesKey("lumera")]: '{"/":["h1"]}', ...bundle });
    const first = await get("/s/lumera.js", kv);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]{12}"$/);
    // The background refresh of a stale file: nothing changed, a 304 with no body.
    const same = await get("/s/lumera.js", kv, { "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(etag);
    expect(same.headers.get("cache-control")).toBe(STALE_OK);
    expect(await same.text()).toBe("");
    // The rules changed since: the old etag gets the new file, not a 304.
    const changed = await get(
      "/s/lumera.js",
      kvJson({ [hideRulesKey("lumera")]: '{"/":["h1","a.cta"]}', ...bundle }),
      { "if-none-match": etag },
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(changed.headers.get("cache-control")).toBe(STALE_OK);
    expect(await changed.text()).toContain('"a.cta"');
  });

  it("the off script is never served stale: five minutes, as before", async () => {
    const kv = kvJson({ "v1:closed:gone-co": "1", [hideRulesKey("gone-co")]: '{"/":["h1"]}' });
    const res = await get("/s/gone-co.js", kv);
    expect(
      (await res.text()).startsWith('window.__rw={"c":"gone-co","e":"https://edge.test","off":1};'),
    ).toBe(true);
    expect(res.headers.get("cache-control")).toBe(FRESH);
    const again = await get("/s/gone-co.js", kv, {
      "if-none-match": res.headers.get("etag") ?? "",
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe(FRESH);
  });

  it("an audit customer's script is never served stale: it carries the audit's end", async () => {
    const day = 24 * 3600 * 1000;
    for (const [name, audit, off] of [
      ["running", { a: 1, ad: "example.com", ae: Date.now() + 7 * day }, false],
      ["no end yet", { a: 1, ad: "example.com" }, false],
      ["past its end", { a: 1, ad: "example.com", ae: Date.now() - day }, true],
    ] as const) {
      const kv = kvJson({
        [visitorBundleKey("audit-co")]: { ...LIVE, ...audit },
        [hideRulesKey("audit-co")]: '{"/":["h1"]}',
      });
      const res = await get("/s/audit-co.js", kv);
      expect(res.headers.get("cache-control"), name).toBe(FRESH);
      expect((await res.text()).includes('"off":1'), name).toBe(off);
    }
    // A pilot's bundle (no `a`) keeps the stale policy.
    const pilot = kvJson({ [visitorBundleKey("acme")]: { ...LIVE, h: 20 } });
    expect((await get("/s/acme.js", pilot)).headers.get("cache-control")).toBe(STALE_OK);
  });

  describe("before go live (task B11): one minute, never stale", () => {
    const NO_PAGES = { v: 1, pages: {}, conv: [] };

    it("the bundle was read and lists no confirmed page: max-age=60, no stale serving", async () => {
      const kv = kvJson({ [visitorBundleKey("new-co")]: NO_PAGES });
      const res = await get("/s/new-co.js", kv);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(BEFORE_LIVE);
      expect(res.headers.get("cache-control")).not.toContain("stale-while-revalidate");
      // Nothing to hide yet, and the script says so.
      expect(
        (await res.text()).startsWith(
          'window.__rw={"c":"new-co","e":"https://edge.test","h":{},"nt":1};',
        ),
      ).toBe(true);
      // A bundle whose pages are not a list of pages lists none.
      for (const pages of [undefined, null, [], ["/"], "/", 7]) {
        const odd = kvJson({ [visitorBundleKey("new-co")]: { v: 1, conv: [], pages } });
        expect(
          (await get("/s/new-co.js", odd)).headers.get("cache-control"),
          JSON.stringify(pages),
        ).toBe(BEFORE_LIVE);
      }
    });

    it("the 304 of such a script renews one minute, in either form of the etag", async () => {
      const kv = kvJson({ [visitorBundleKey("new-co")]: NO_PAGES });
      const etag = (await get("/s/new-co.js", kv)).headers.get("etag") ?? "";
      for (const sent of [etag, `W/${etag}`]) {
        const same = await get("/s/new-co.js", kv, { "if-none-match": sent });
        expect(same.status, sent).toBe(304);
        expect(same.headers.get("cache-control"), sent).toBe(BEFORE_LIVE);
      }
    });

    it("go live: the script a minute later has the rules, a new etag and the normal policy", async () => {
      const before = kvJson({ [visitorBundleKey("new-co")]: NO_PAGES });
      const first = await get("/s/new-co.js", before);
      const etag = first.headers.get("etag") ?? "";
      expect(first.headers.get("cache-control")).toBe(BEFORE_LIVE);

      const after = kvJson({
        [visitorBundleKey("new-co")]: LIVE,
        [hideRulesKey("new-co")]: '{"/":["h1"]}',
      });
      // The browser asks again with the old file's etag and gets the new file.
      const next = await get("/s/new-co.js", after, { "if-none-match": `W/${etag}` });
      expect(next.status).toBe(200);
      expect(next.headers.get("etag")).not.toBe(etag);
      expect(next.headers.get("cache-control")).toBe(STALE_OK);
      expect(await next.text()).toContain('"h":{"/":["h1"]}');
    });

    it("`p` names every confirmed page, also one with nothing to hide; never without a read bundle", async () => {
      const cfgOf = async (id: string, kv: KVNamespace) => {
        const body = await (await get(`/s/${id}.js`, kv)).text();
        return JSON.parse(body.slice("window.__rw=".length, body.indexOf(";\n"))) as {
          h: Record<string, string[]>;
          p?: string[];
        };
      };
      // `/pricing` is confirmed and has no rule (its parts are buttons left off).
      const live = kvJson({
        [hideRulesKey("acme")]: '{"/":["h1"]}',
        [visitorBundleKey("acme")]: {
          v: 1,
          pages: { "/": { "hero.headline": { css: ["h1"] } }, "/pricing": {} },
          conv: [],
        },
      });
      const cfg = await cfgOf("acme", live);
      expect(cfg.p).toEqual(["/", "/pricing"]);
      expect(Object.keys(cfg.h)).toEqual(["/"]);
      // No bundle, not a bundle, or no confirmed page yet: no `p`, and the
      // snippet treats every page as it did before.
      expect((await cfgOf("new-co", kvJson({}))).p).toBeUndefined();
      const rulesOnly = kvJson({ [hideRulesKey("acme")]: '{"/":["h1"]}' });
      expect((await cfgOf("acme", rulesOnly)).p).toBeUndefined();
      const before = kvJson({ [visitorBundleKey("acme")]: { v: 1, pages: {}, conv: [] } });
      expect((await cfgOf("acme", before)).p).toBeUndefined();
      const notOne = kvJson({ [visitorBundleKey("acme")]: { v: 2, pages: { "/": {} } } });
      expect((await cfgOf("acme", notOne)).p).toBeUndefined();
    });

    it("a sensitive customer's script is byte identical: `s`, `sk`, a `pm` path outside `pages` and `g` add nothing (privacy review, condition 5; page-groups.md condition 7)", async () => {
      // `p` is built from `bundle.pages` alone. The kept sections and the
      // site map are the edge's own and name pages `p` must not.
      const pages = { "/": { "hero.headline": { css: ["h1"] } }, "/pricing": {} };
      const store = (extra: Record<string, unknown>) =>
        kvJson({
          [hideRulesKey("acme")]: '{"/":["h1"]}',
          [visitorBundleKey("acme")]: { v: 1, pages, conv: [], ...extra },
        });
      const plain = await get("/s/acme.js", store({}));
      const marked = await get(
        "/s/acme.js",
        store({
          s: 1,
          sk: ["/kept-section-only", "/products"],
          pm: { "/mapped-page-only": ["proof", 1] },
          g: ["/products/*", "/group-only/*"],
        }),
      );
      const [plainBody, markedBody] = [await plain.text(), await marked.text()];
      expect(markedBody).toBe(plainBody);
      expect(marked.headers.get("etag")).toBe(plain.headers.get("etag"));
      expect(marked.headers.get("cache-control")).toBe(plain.headers.get("cache-control"));
      // None of those paths is in the body: neither a kept section nor the
      // mapped page. (`/products` is tested by name too: no confirmed page
      // or rule here holds it.)
      // A page group pattern never either (page-groups.md, privacy review condition 7).
      for (const path of ["/kept-section-only", "/products", "/mapped-page-only", "/group-only"]) {
        expect(markedBody, path).not.toContain(path);
      }
      const cfg = JSON.parse(
        markedBody.slice("window.__rw=".length, markedBody.indexOf(";\n")),
      ) as Record<string, unknown>;
      expect(cfg.p).toEqual(["/", "/pricing"]);
      expect(Object.keys(cfg).sort()).toEqual(["c", "e", "h", "nt", "p"]);
      // Each of the three alone changes nothing either.
      for (const extra of [
        { s: 1 },
        { sk: ["/kept-section-only"] },
        { pm: { "/mapped-page-only": ["proof", 1] } },
        { g: ["/products/*"] },
      ]) {
        const one = await get("/s/acme.js", store(extra));
        expect(one.headers.get("etag"), JSON.stringify(extra)).toBe(plain.headers.get("etag"));
        expect(await one.text(), JSON.stringify(extra)).toBe(plainBody);
      }
    });

    it("a page in the bundle is the normal policy, also when it has no part to hide", async () => {
      // Every part of the page is a button that is off: confirmed, live, no rule.
      const kv = kvJson({ [visitorBundleKey("acme")]: { v: 1, pages: { "/": {} }, conv: [] } });
      expect((await get("/s/acme.js", kv)).headers.get("cache-control")).toBe(STALE_OK);
    });

    it("a missing bundle or a failed read lives one minute, never stale (the privacy review's conditions)", async () => {
      // Missing: the very first load of a new tag.
      expect((await get("/s/new-co.js", kvJson({}))).headers.get("cache-control")).toBe(
        "public, max-age=60",
      );
      // Not a bundle.
      for (const value of [{ pages: {} }, { v: 2, pages: {} }, "x", 7]) {
        const kv = kvJson({ [visitorBundleKey("new-co")]: value });
        expect(
          (await get("/s/new-co.js", kv)).headers.get("cache-control"),
          JSON.stringify(value),
        ).toBe("public, max-age=60");
      }
      // The read failed.
      const failing = {
        async get(key: string) {
          if (key === visitorBundleKey("new-co")) throw new Error("kv down");
          return null;
        },
        async put() {},
        async delete() {},
      } as unknown as KVNamespace;
      const res = await get("/s/new-co.js", failing);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("an audit customer before its first page keeps its five minutes, and the off script too", async () => {
      const day = 24 * 3600 * 1000;
      const audit = kvJson({
        [visitorBundleKey("audit-co")]: { ...NO_PAGES, a: 1, ad: "example.com" },
      });
      expect((await get("/s/audit-co.js", audit)).headers.get("cache-control")).toBe(FRESH);
      const ended = kvJson({
        [visitorBundleKey("audit-co")]: {
          ...NO_PAGES,
          a: 1,
          ad: "example.com",
          ae: Date.now() - day,
        },
      });
      const off = await get("/s/audit-co.js", ended);
      expect(off.headers.get("cache-control")).toBe(FRESH);
      expect(await off.text()).toContain('"off":1');
      // A deleted customer whose bundle lists no page: the off script, five minutes.
      const closed = kvJson({ "v1:closed:gone-co": "1", [visitorBundleKey("gone-co")]: NO_PAGES });
      const gone = await get("/s/gone-co.js", closed);
      expect(gone.headers.get("cache-control")).toBe(FRESH);
      expect(await gone.text()).toContain('"off":1');
    });
  });

  it("the three other scripts keep their policy: none is served stale", async () => {
    const kv = kvJson({});
    const v = RICH_ETAG.replace(/"/g, "");
    for (const [path, want] of [
      // The older generic tag: an hour, as before.
      ["/snippet.js", "public, max-age=3600"],
      // The operator's picker: a pick runs the picker the edge has now.
      ["/picker.js", "public, max-age=3600"],
      // This build's rich writers are immutable under their own URL.
      [`/rich.js?v=${v}`, "public, max-age=31536000, immutable"],
      // Another build asking: this build's file, five minutes.
      ["/rich.js?v=0000000000000000", FRESH],
    ] as const) {
      const res = await get(path, kv);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(want);
      const again = await get(path, kv, { "if-none-match": res.headers.get("etag") ?? "" });
      expect(again.status, path).toBe(304);
      expect(again.headers.get("cache-control"), path).toBe(want);
      expect(again.headers.get("cache-control"), path).not.toContain("stale-while-revalidate");
    }
  });
});

describe("/rich.js", () => {
  const v = RICH_ETAG.replace(/"/g, "");

  it("serves the rich writers with open CORS, cached for a year at this build's version", async () => {
    const res = await worker.fetch(
      new Request(`https://edge.test/rich.js?v=${v}`),
      env(kvWith({}).kv),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(RICH_ETAG);
    expect(await res.text()).toContain("__rwx");
  });

  it("serves the current build for any other version, cached briefly", async () => {
    for (const url of [
      "https://edge.test/rich.js",
      "https://edge.test/rich.js?v=0000000000000000",
    ]) {
      const res = await worker.fetch(new Request(url), env(kvWith({}).kv), ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    }
  });

  it("answers 304 to its own etag", async () => {
    const res = await worker.fetch(
      new Request(`https://edge.test/rich.js?v=${v}`, { headers: { "if-none-match": RICH_ETAG } }),
      env(kvWith({}).kv),
      ctx,
    );
    expect(res.status).toBe(304);
  });

  it("is the version the snippet asks for", async () => {
    const { SNIPPET_JS } = await import("../src/snippet-asset.ts");
    expect(SNIPPET_JS).toContain(v);
  });
});
