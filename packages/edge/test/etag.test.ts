/**
 * The scripts' refresh costs a 304, whichever form of the etag the browser
 * sends back (pilot-gaps.md, the lab recheck of 2026-10-12, B9:
 * Chrome's background refresh of a stale /s/{id}.js sent `W/"..."` and got
 * the whole file, 14.5 KB, every time).
 */
import { hideRulesKey, visitorBundleKey } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { etagMatches } from "../src/etag.ts";
import worker from "../src/index.ts";
import { PICKER_ETAG } from "../src/picker-asset.ts";
import { RICH_ETAG } from "../src/rich-asset.ts";
import { SNIPPET_ETAG } from "../src/snippet-asset.ts";

describe("etagMatches: If-None-Match compared weakly (RFC 9110, 13.1.2)", () => {
  const ETAG = '"63cffd99bd948ba1-0a1b2c3d4e5f"';

  it("the strong form, as the edge sends it", () => {
    expect(etagMatches(ETAG, ETAG)).toBe(true);
  });

  it("the weak form, as a browser sends it back after Cloudflare compressed the file", () => {
    expect(etagMatches(`W/${ETAG}`, ETAG)).toBe(true);
    // Weak on our side too: the opaque parts decide.
    expect(etagMatches(ETAG, `W/${ETAG}`)).toBe(true);
    expect(etagMatches(`W/${ETAG}`, `W/${ETAG}`)).toBe(true);
  });

  it("a list: any member that names the file", () => {
    expect(etagMatches(`"aaaa", W/${ETAG}, "bbbb"`, ETAG)).toBe(true);
    expect(etagMatches(`"aaaa",${ETAG}`, ETAG)).toBe(true);
    expect(etagMatches(`  W/"aaaa" ,   ${ETAG}  `, ETAG)).toBe(true);
    expect(etagMatches('"aaaa", W/"bbbb"', ETAG)).toBe(false);
  });

  it("the star: any current file", () => {
    expect(etagMatches("*", ETAG)).toBe(true);
    expect(etagMatches(" * ", ETAG)).toBe(true);
  });

  it("a value that does not name the file", () => {
    for (const other of [
      '"63cffd99bd948ba1-ffffffffffff"',
      'W/"63cffd99bd948ba1"',
      // A part of the tag, or the tag inside a longer one, is another tag.
      '"63cffd99bd948ba1-0a1b2c3d4e5f-gzip"',
      '"x63cffd99bd948ba1-0a1b2c3d4e5f"',
      // Not a tag: no quotes, the wrong mark, a star among tags.
      "63cffd99bd948ba1-0a1b2c3d4e5f",
      "W/63cffd99bd948ba1-0a1b2c3d4e5f",
      '"aaaa", *',
      "",
      "   ",
    ]) {
      expect(etagMatches(other, ETAG), other).toBe(false);
    }
    expect(etagMatches(null, ETAG)).toBe(false);
    expect(etagMatches(undefined, ETAG)).toBe(false);
  });

  it("an etag of ours that is not a tag matches no tag", () => {
    expect(etagMatches('"abc"', "abc")).toBe(false);
  });
});

describe("every script the edge serves answers 304 to its etag in any form", () => {
  const kv = {
    async get(key: string, opts?: string | { type?: string }) {
      const data: Record<string, unknown> = {
        [hideRulesKey("lumera")]: '{"/":["h1"]}',
        [visitorBundleKey("lumera")]: { v: 1, pages: { "/": {} }, conv: [] },
      };
      const v = data[key];
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? v : typeof v === "string" ? v : JSON.stringify(v);
    },
    async put() {},
    async delete() {},
  } as unknown as KVNamespace;
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const env = { VARIANTS: kv, DB: {} as D1Database, ENVIRONMENT: "test", PREVIEW_TOKEN: "" };
  const get = (path: string, ifNoneMatch?: string) =>
    worker.fetch(
      new Request(`https://edge.test${path}`, {
        headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
      }),
      env,
      ctx,
    );

  const rich = `/rich.js?v=${RICH_ETAG.replace(/"/g, "")}`;
  const FIXED: Record<string, string> = {
    "/snippet.js": SNIPPET_ETAG,
    "/picker.js": PICKER_ETAG,
    [rich]: RICH_ETAG,
  };

  for (const path of ["/s/lumera.js", "/snippet.js", "/picker.js", rich]) {
    it(path, async () => {
      const first = await get(path);
      expect(first.status).toBe(200);
      const full = await first.text();
      expect(full.length).toBeGreaterThan(1000);
      const etag = first.headers.get("etag") ?? "";
      // The etag the edge sends is the strong one, as before.
      expect(etag).toMatch(/^"[0-9a-f-]+"$/);
      if (FIXED[path]) expect(etag).toBe(FIXED[path]);
      const policy = first.headers.get("cache-control");

      for (const sent of [etag, `W/${etag}`, `"0000", W/${etag}`, `W/"0000",${etag}`, "*"]) {
        const res = await get(path, sent);
        expect(res.status, sent).toBe(304);
        expect(await res.text(), sent).toBe("");
        // The 304 names the same file and renews the same policy as the 200.
        expect(res.headers.get("etag"), sent).toBe(etag);
        expect(res.headers.get("cache-control"), sent).toBe(policy);
      }

      for (const sent of ['"0000000000000000"', 'W/"0000000000000000"', etag.replace(/"/g, "")]) {
        const res = await get(path, sent);
        expect(res.status, sent).toBe(200);
        expect(await res.text(), sent).toBe(full);
        expect(res.headers.get("etag"), sent).toBe(etag);
      }
    });
  }
});
