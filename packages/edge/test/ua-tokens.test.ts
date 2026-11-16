import { describe, expect, it } from "vitest";
import { countUaTokens, customerBucket, isoWeek, uaTokens } from "../src/ua-tokens.ts";

describe("uaTokens", () => {
  it("returns nothing for a stock desktop Chrome UA", () => {
    expect(
      uaTokens(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ),
    ).toEqual([]);
  });

  it("keeps the product tokens of an in-app UA and drops the rest", () => {
    const t = uaTokens(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.54 Mobile Safari/537.36 SomeNewApp/12.3 JsSdk/2.0",
    );
    expect(t).toContain("somenewapp");
    expect(t).toContain("jssdk");
    expect(t).not.toContain("chrome");
    expect(t).not.toContain("wv");
  });

  it("drops identifier-shaped tokens: long digit runs, hosts, emails, long strings", () => {
    const t = uaTokens(
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 build 12643679358 device-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 user@example.com host.example.com",
    );
    expect(t).not.toContain("build");
    expect(t.some((x) => x.includes("@"))).toBe(false);
    expect(t.some((x) => x.includes("."))).toBe(false);
    expect(t.some((x) => x.length > 32)).toBe(false);
    expect(t.every((x) => !/\d{6,}/.test(x))).toBe(true);
  });

  it("caps the number of tokens and dedupes", () => {
    const ua = "a1x b2x c3x d4x e5x f6x g7x h8x a1x b2x".replace(/(\w)(\d)x/g, "tok$1$2");
    const t = uaTokens(ua);
    expect(t.length).toBeLessThanOrEqual(6);
    expect(new Set(t).size).toBe(t.length);
  });

  it("handles null", () => {
    expect(uaTokens(null)).toEqual([]);
  });
});

describe("isoWeek", () => {
  it("labels a known date", () => {
    expect(isoWeek(new Date("2026-09-10T12:00:00Z"))).toBe("2026-W37");
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("countUaTokens", () => {
  function makeDb(seen: { sql: string; args: unknown[] }[]) {
    return {
      prepare(sql: string) {
        return { bind: (...args: unknown[]) => ({ sql, args }) };
      },
      async batch(stmts: { sql: string; args: unknown[] }[]) {
        for (const s of stmts) seen.push(s);
        return [];
      },
    } as unknown as D1Database;
  }

  it("writes one upsert per token, keyed by week and customer bucket, never the customer or the UA", async () => {
    const seen: { sql: string; args: unknown[] }[] = [];
    await countUaTokens(
      makeDb(seen),
      "acme",
      "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36 BrandNewApp/3.1",
      new Date("2026-09-10T12:00:00Z"),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("ua_token_counts");
    const bucket = await customerBucket("acme", "2026-W37");
    expect(bucket).toMatch(/^[0-9a-f]{2}$/);
    expect(seen[0]?.args).toEqual(["2026-W37", bucket, "brandnewapp"]);
    expect(JSON.stringify(seen)).not.toContain("acme");
  });

  it("the bucket rotates with the week and is deterministic", async () => {
    const a = await customerBucket("acme", "2026-W37");
    const b = await customerBucket("acme", "2026-W37");
    expect(a).toBe(b);
    const buckets = new Set<string>();
    for (let w = 1; w <= 40; w++) buckets.add(await customerBucket("acme", `2026-W${w}`));
    expect(buckets.size).toBeGreaterThan(5);
  });

  it("writes nothing when no token survives", async () => {
    const seen: { sql: string; args: unknown[] }[] = [];
    await countUaTokens(makeDb(seen), "acme", "Mozilla/5.0 (Linux; Android 14; wv) Chrome/124");
    expect(seen).toHaveLength(0);
  });

  it("swallows D1 errors", async () => {
    const db = {
      prepare() {
        throw new Error("boom");
      },
    } as unknown as D1Database;
    await expect(countUaTokens(db, "acme", "Foo/1 BarApp/2")).resolves.toBeUndefined();
  });
});
