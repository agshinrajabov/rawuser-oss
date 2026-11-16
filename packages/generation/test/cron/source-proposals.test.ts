import { describe, expect, it, vi } from "vitest";
import {
  formatProposals,
  lastFullWeek,
  runSourceProposals,
  stillUnknown,
} from "../../src/cron/source-proposals.ts";

describe("source proposals", () => {
  it("drops values the current vocabulary already knows", () => {
    expect(
      stillUnknown({ kind: "utm_source", token: "chatgpt.com", buckets: 2, sessions: 50 }),
    ).toBe(false);
    expect(
      stillUnknown({ kind: "utm_source", token: "partner-xyz", buckets: 2, sessions: 50 }),
    ).toBe(true);
    expect(
      stillUnknown({ kind: "referrer_host", token: "grok.com", buckets: 2, sessions: 50 }),
    ).toBe(false);
  });

  it("checks an app_package against the exact package table, never as a host (Layer G)", () => {
    const row = (token: string) => ({ kind: "app_package", token, buckets: 2, sessions: 50 });
    expect(stillUnknown(row("com.facebook.katana"))).toBe(false);
    expect(stillUnknown(row("com.example.notes"))).toBe(true);
    // As a referrer_host this reads as a country-coded Google host and hides.
    expect(stillUnknown({ ...row("com.google.earth"), kind: "referrer_host" })).toBe(false);
    expect(stillUnknown(row("com.google.earth"))).toBe(true);
  });

  it("formats a short list and a quiet line when empty", () => {
    expect(formatProposals("2026-W37", [])).toContain("nothing new");
    const text = formatProposals("2026-W37", [
      { kind: "utm_source", token: "partner-xyz", buckets: 3, sessions: 120 },
    ]);
    // A count and the command; the value itself never goes to the third party.
    expect(text).toContain("1 unknown value wait for review (1 utm_source)");
    expect(text).not.toContain("partner-xyz");
  });

  it("queries last week, deletes old weeks, posts only when there is something", async () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        // The sensitive customers of the week (none here): their buckets
        // are left out of the read (docs/specs/sensitive-customers.md).
        all: async () => ({ results: [] }),
        bind: (...args: unknown[]) => ({
          all: async () => {
            calls.push({ sql, args });
            return {
              results: [{ kind: "utm_source", token: "partner-xyz", buckets: 2, sessions: 60 }],
            };
          },
          run: async () => {
            calls.push({ sql, args });
            return {};
          },
        }),
      }),
    } as unknown as D1Database;
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await runSourceProposals(
      { DB: db, ALERT_WEBHOOK_URL: "https://api.telegram.org/botX/sendMessage?chat_id=1" },
      new Date("2026-09-14T06:00:00Z"),
    );
    vi.unstubAllGlobals();
    expect(out.week).toBe(lastFullWeek(new Date("2026-09-14T06:00:00Z")));
    expect(out.proposals).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes("DELETE FROM signal_token_counts"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain("partner-xyz");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("wait+for+review");
  });
});
