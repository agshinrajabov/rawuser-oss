/**
 * The boot and the shared core at the edge (docs/specs/faster-tag.md step 4):
 * every `/s/{id}.js` is the boot (the normal policy since step 4, every other
 * policy since step 6's E1), and `/s/_core/{hash}.js` serves the core
 * by build, precompressed, keeping the builds a browser's boot may still name.
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { hideRulesKey, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { BOOT_CORE, BOOT_ETAG, BOOT_JS } from "../src/boot-asset.ts";
import { CORE_BUILDS, type CoreBuild } from "../src/core-assets.ts";
import { CURRENT_CORE, accepted, coreHash, handleCore } from "../src/core-script.ts";
import worker from "../src/index.ts";
import { SNIPPET_ETAG, SNIPPET_JS } from "../src/snippet-asset.ts";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

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
const env = (kv: KVNamespace) => ({
  VARIANTS: kv,
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  PREVIEW_TOKEN: "",
});
const get = (path: string, headers: Record<string, string> = {}, kv = kvJson({})) =>
  worker.fetch(new Request(`https://edge.test${path}`, { headers }), env(kv), ctx);

const CHROME = "gzip, deflate, br, zstd";
const IMMUTABLE = "public, max-age=31536000, immutable";
const LIVE = { v: 1, pages: { "/": { "hero.headline": { css: ["h1"] } } }, conv: [] };
const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("/s/_core/{hash}.js", () => {
  it("the current build, brotli for Chrome: the core's exact text, a year, immutable, open to any page", async () => {
    const res = await get(`/s/_core/${CURRENT_CORE}.js`, { "accept-encoding": CHROME });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("etag")).toBe(SNIPPET_ETAG);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    // No cookie, nothing about the visitor.
    expect(res.headers.get("set-cookie")).toBeNull();
    const raw = await body(res);
    expect(brotliDecompressSync(raw).toString("utf8")).toBe(SNIPPET_JS);
    // Smaller than what Chrome got before (zstd 15,796 B for the whole tag)
    // and than the core's gzip ceiling; the size itself is held by the
    // snippet's bundle-size test (was a round 14,000, which the core passed
    // at 13,986 B and the two-part tag's hook, faster-tag.md step 6, crossed
    // at 14,017).
    expect(raw.length).toBeLessThan(15_360);
  });

  it("gzip where brotli is not taken, the text itself where neither is", async () => {
    const gz = await get(`/s/_core/${CURRENT_CORE}.js`, { "accept-encoding": "gzip, deflate" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await body(gz)).toString("utf8")).toBe(SNIPPET_JS);
    const refused = await get(`/s/_core/${CURRENT_CORE}.js`, { "accept-encoding": "br;q=0, gzip" });
    expect(refused.headers.get("content-encoding")).toBe("gzip");
    const plain = await get(`/s/_core/${CURRENT_CORE}.js`);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(await plain.text()).toBe(SNIPPET_JS);
  });

  it("answers 304 to its etag, in either form", async () => {
    for (const sent of [SNIPPET_ETAG, `W/${SNIPPET_ETAG}`]) {
      const res = await get(`/s/_core/${CURRENT_CORE}.js`, {
        "accept-encoding": CHROME,
        "if-none-match": sent,
      });
      expect(res.status, sent).toBe(304);
      expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    }
  });

  it("a hash the edge does not keep gets the current core, cached five minutes", async () => {
    const res = await get("/s/_core/0123456789abcdef.js", { "accept-encoding": CHROME });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe(SNIPPET_ETAG);
    expect(brotliDecompressSync(await body(res)).toString("utf8")).toBe(SNIPPET_JS);
  });

  it("only a 16-hex build is a core address; nothing else under /s/_core is served", async () => {
    for (const path of [
      "/s/_core/ABCDEF0123456789.js",
      "/s/_core/0123.js",
      "/s/_core/0123456789abcdef.js.map",
      "/s/_core/../acme.js",
      "/s/_core.js",
    ]) {
      expect(coreHash(new URL(`https://e.test${path}`).pathname), path).toBeNull();
    }
    expect((await get("/s/_core/0123.js")).status).toBe(404);
    expect((await get("/s/_core.js")).status).toBe(404);
  });

  it("the boot names the current core, and the edge keeps it as current", () => {
    expect(BOOT_CORE).toBe(CURRENT_CORE);
    expect(BOOT_JS).toContain(`"${BOOT_CORE}"`);
    const current = CORE_BUILDS.filter((b) => !b.retired);
    expect(current.map((b) => b.h)).toEqual([CURRENT_CORE]);
    // Kept builds are distinct and precompressed from the same text.
    expect(new Set(CORE_BUILDS.map((b) => b.h)).size).toBe(CORE_BUILDS.length);
    const now = CORE_BUILDS.find((b) => b.h === CURRENT_CORE) as CoreBuild;
    expect(brotliDecompressSync(Buffer.from(now.br, "base64")).toString("utf8")).toBe(SNIPPET_JS);
    expect(gunzipSync(Buffer.from(now.gz, "base64")).toString("utf8")).toBe(SNIPPET_JS);
  });
});

describe("a stale boot finds its own core", () => {
  // Yesterday's build, kept beside today's (core-assets.ts).
  const OLD = "aaaaaaaaaaaaaaaa";
  const NEW = "bbbbbbbbbbbbbbbb";
  const oldJs = "/* yesterday's core */ (()=>{})();";
  const newJs = "/* today's core */ (()=>{})();";
  const build = (h: string, js: string, retired?: string): CoreBuild => ({
    h,
    ...(retired ? { retired } : {}),
    br: brotliCompressSync(js).toString("base64"),
    gz: gzipSync(js).toString("base64"),
  });
  const builds = [build(NEW, newJs), build(OLD, oldJs, "2026-10-25T00:00:00.000Z")];
  const req = (h: Record<string, string> = { "accept-encoding": CHROME }) =>
    new Request("https://edge.test/x", { headers: h });

  it("yesterday's boot asks for yesterday's core and gets exactly it, immutable", async () => {
    const res = handleCore(req(), OLD, builds, NEW, newJs);
    expect(res.headers.get("etag")).toBe(`"${OLD}"`);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(brotliDecompressSync(await body(res)).toString("utf8")).toBe(oldJs);
    const gz = handleCore(req({ "accept-encoding": "gzip" }), OLD, builds, NEW, newJs);
    expect(gunzipSync(await body(gz)).toString("utf8")).toBe(oldJs);
  });

  it("today's boot gets today's core", async () => {
    const res = handleCore(req(), NEW, builds, NEW, newJs);
    expect(res.headers.get("etag")).toBe(`"${NEW}"`);
    expect(brotliDecompressSync(await body(res)).toString("utf8")).toBe(newJs);
  });

  it("a build no longer kept, or a client that takes no compression for an old build: today's core, briefly", async () => {
    const gone = handleCore(req(), "cccccccccccccccc", builds, NEW, newJs);
    expect(gone.headers.get("cache-control")).toBe("public, max-age=300");
    expect(brotliDecompressSync(await body(gone)).toString("utf8")).toBe(newJs);
    const plain = handleCore(req({}), OLD, builds, NEW, newJs);
    expect(plain.headers.get("cache-control")).toBe("public, max-age=300");
    expect(plain.headers.get("etag")).toBe(`"${NEW}"`);
    expect(await plain.text()).toBe(newJs);
  });
});

describe("Accept-Encoding", () => {
  it("reads codings, refuses q=0, takes *", () => {
    expect([...accepted("gzip, deflate, br, zstd")]).toEqual(["gzip", "deflate", "br", "zstd"]);
    expect(accepted("br;q=0, gzip;q=0.5").has("br")).toBe(false);
    expect(accepted("br;q=0, gzip;q=0.5").has("gzip")).toBe(true);
    expect(accepted("*").has("*")).toBe(true);
    expect(accepted(null).size).toBe(0);
  });
});

describe("/s/{id}.js: the boot for every policy (faster-tag.md step 6, E1)", () => {
  const live = () =>
    kvJson({ [visitorBundleKey("acme")]: LIVE, [hideRulesKey("acme")]: '{"/":["h1"]}' });
  /** The etag the edge gives a config line: the boot's build and six bytes of the line's SHA-256. */
  const etagOf = (prefix: string) =>
    `"${BOOT_ETAG.replace(/"/g, "")}-${createHash("sha256").update(prefix).digest("hex").slice(0, 12)}"`;

  it("a live customer's script is the config line and the boot, byte for byte as before E1", async () => {
    const res = await get("/s/acme.js", {}, live());
    const text = await res.text();
    const prefix =
      'window.__rw={"c":"acme","e":"https://edge.test","h":{"/":["h1"]},"p":["/"],"nt":1};';
    expect(text).toBe(`${prefix}\n${BOOT_JS}`);
    expect(res.headers.get("etag")).toBe(etagOf(prefix));
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
  });

  // Each policy keeps its config line and its cache policy exactly; only the
  // code after the line moved from the single file to the boot, which runs
  // the same checks and, unlike the single file, takes over and disables a
  // pasted `<style data-rawuser-pre>` (packages/snippet/test/policies.test.ts).
  const day = 24 * 3600 * 1000;
  const end = Date.now() + day;
  const cases: Array<[string, KVNamespace, string, string]> = [
    [
      "off",
      kvJson({ "v1:closed:acme": "1", [visitorBundleKey("acme")]: LIVE }),
      'window.__rw={"c":"acme","e":"https://edge.test","off":1};',
      "public, max-age=300",
    ],
    [
      "audit past its end",
      kvJson({ [visitorBundleKey("acme")]: { ...LIVE, a: 1, ad: "example.com", ae: 1 } }),
      'window.__rw={"c":"acme","e":"https://edge.test","off":1};',
      "public, max-age=300",
    ],
    [
      "audit",
      kvJson({
        [visitorBundleKey("acme")]: { ...LIVE, a: 1, ad: "example.com", ae: end },
        [hideRulesKey("acme")]: '{"/":["h1"]}',
      }),
      `window.__rw={"c":"acme","e":"https://edge.test","h":{"/":["h1"]},"p":["/"],"nt":1,"ad":"example.com","ae":${end}};`,
      "public, max-age=300",
    ],
    [
      "before go live",
      kvJson({ [visitorBundleKey("acme")]: { v: 1, pages: {}, conv: [] } }),
      'window.__rw={"c":"acme","e":"https://edge.test","h":{},"nt":1};',
      "public, max-age=60",
    ],
    [
      "no bundle",
      kvJson({ [hideRulesKey("acme")]: '{"/":["h1"]}' }),
      'window.__rw={"c":"acme","e":"https://edge.test","h":{"/":["h1"]},"nt":1};',
      "public, max-age=60",
    ],
  ];
  for (const [name, kv, prefix, cache] of cases) {
    it(`${name}: its own config line and cache policy, then the boot`, async () => {
      const res = await get("/s/acme.js", {}, kv);
      expect(await res.text()).toBe(`${prefix}\n${BOOT_JS}`);
      expect(res.headers.get("etag")).toBe(etagOf(prefix));
      expect(res.headers.get("cache-control")).toBe(cache);
      // A browser that kept the single file revalidates and gets the boot.
      const old = `"${SNIPPET_ETAG.replace(/"/g, "")}-${etagOf(prefix).split("-")[1]}`;
      expect((await get("/s/acme.js", { "if-none-match": old }, kv)).status).toBe(200);
    });
  }

  it("no per-customer script is the single file; /snippet.js still is, unchanged", async () => {
    for (const [name, kv] of cases) {
      expect(await (await get("/s/acme.js", {}, kv)).text(), name).not.toContain(SNIPPET_JS);
    }
    const generic = await get("/snippet.js");
    expect(await generic.text()).toBe(SNIPPET_JS);
    expect(generic.headers.get("etag")).toBe(SNIPPET_ETAG);
  });
});
