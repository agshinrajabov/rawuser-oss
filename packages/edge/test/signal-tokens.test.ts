import type { Signals } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { countSignalTokens, learnableToken, unknownTokens } from "../src/signal-tokens.ts";

function signals(over: Partial<Signals>): Signals {
  return {
    utm: {},
    referrerHost: null,
    device: "desktop",
    language: null,
    country: null,
    aiSource: null,
    appSource: null,
    clickId: null,
    linkFamily: null,
    entryPath: null,
    ...over,
  } as Signals;
}

describe("learnableToken", () => {
  it("keeps labels and hosts, drops anything identifier-shaped", () => {
    expect(learnableToken("Partner-XYZ")).toBe("partner-xyz");
    expect(learnableToken("www.some-site.example")).toBe("some-site.example");
    expect(learnableToken("john@example.com")).toBeNull();
    expect(learnableToken("id-1234567")).toBeNull();
    expect(learnableToken("10.0.0.1")).toBeNull();
    expect(learnableToken("a".repeat(65))).toBeNull();
  });
});

describe("unknownTokens", () => {
  it("counts only what the vocabulary missed", () => {
    const t = unknownTokens(
      signals({ utm: { source: "partner-xyz", medium: "cpc" }, referrerHost: "some-site.example" }),
    );
    expect(t).toEqual([
      { kind: "utm_source", token: "partner-xyz" },
      { kind: "referrer_host", token: "some-site.example" },
    ]);
    expect(
      unknownTokens(signals({ utm: { source: "chatgpt.com" }, referrerHost: "grok.com" })),
    ).toEqual([]);
  });

  it("android-app package ids (Layer G): a known one is not counted, an unknown one is, as app_package", () => {
    expect(
      unknownTokens(signals({ referrerHost: "com.facebook.katana", referrerIsApp: true })),
    ).toEqual([]);
    expect(
      unknownTokens(signals({ referrerHost: "com.example.notes", referrerIsApp: true })),
    ).toEqual([{ kind: "app_package", token: "com.example.notes" }]);
    // As a web host this would match the country-coded Google pattern; as a
    // package id it is unknown and waits for a human.
    expect(
      unknownTokens(signals({ referrerHost: "com.google.earth", referrerIsApp: true })),
    ).toEqual([{ kind: "app_package", token: "com.google.earth" }]);
    // The same token from a web referrer is still a referrer_host.
    expect(unknownTokens(signals({ referrerHost: "some-site.example" }))).toEqual([
      { kind: "referrer_host", token: "some-site.example" },
    ]);
  });
});

describe("countSignalTokens", () => {
  it("upserts one counter per token with the week and a customer bucket, never the customer", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          binds.push([sql, ...args]);
          return {};
        },
      }),
      batch: async () => [],
    } as unknown as D1Database;
    await countSignalTokens(db, "lumera", signals({ utm: { source: "partner-xyz" } }));
    expect(binds).toHaveLength(1);
    const [sql, week, bucket, kind, token] = binds[0] as [string, string, string, string, string];
    expect(sql).toContain("signal_token_counts");
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
    expect(bucket).toMatch(/^[0-9a-f]{2}$/);
    expect(kind).toBe("utm_source");
    expect(token).toBe("partner-xyz");
    expect(JSON.stringify(binds)).not.toContain("lumera");
  });
});
