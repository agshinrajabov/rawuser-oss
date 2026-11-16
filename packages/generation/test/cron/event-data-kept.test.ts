/**
 * ADR 0037 (2026-11-02): event data is kept for the life of the account.
 * No code NULLs the visit marker, source_name, tagged, found_by, country or
 * the bit lp by age, and no code deletes snippet_issue rows by age. Only the
 * per-customer delete (admin/customer-data.ts, by customer), an audit's own
 * end (audit/lifecycle.ts, by customer) and the raw retention sweep that is
 * off unless RAW_EVENT_RETENTION_DAYS is set remove event rows.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const DIRS = ["generation/src", "edge/src", "shared/src"].map((d) => join(ROOT, d));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const sources = DIRS.flatMap(files).map((f) => ({
  file: relative(ROOT, f),
  src: readFileSync(f, "utf8"),
}));

describe("event data is kept (ADR 0037)", () => {
  it("no statement NULLs a kept event column", () => {
    const kept = /UPDATE events SET[^;`]*\b(visit|source_name|tagged|found_by|country)\s*=\s*NULL/;
    const offenders = sources.filter((s) => kept.test(s.src)).map((s) => s.file);
    // The country off switch NULLs the customer's own column (ADR 0036, point
    // 6): by customer, never by age.
    expect(offenders).toEqual(["generation/src/admin/country.ts"]);
    const country = sources.find((s) => s.file === "generation/src/admin/country.ts")?.src ?? "";
    const stmt = /UPDATE events SET country = NULL[^`]*/.exec(country)?.[0] ?? "";
    expect(stmt).toContain("customer_id = ?");
    expect(stmt).not.toMatch(/\bts\b/);
  });

  it("no statement strips the bit lp from a row", () => {
    const offenders = sources.filter((s) => /json_remove\([^)]*\$\.lp/.test(s.src));
    expect(offenders.map((s) => s.file)).toEqual([]);
  });

  it("only the per-customer delete, an audit's end and the opt-in retention delete event rows", () => {
    const offenders = sources
      .filter((s) => /DELETE FROM events/.test(s.src))
      .map((s) => s.file)
      .sort();
    expect(offenders).toEqual([
      "generation/src/admin/customer-data.ts",
      "generation/src/audit/lifecycle.ts",
      "generation/src/cron/event-retention.ts",
    ]);
    for (const s of sources)
      expect(s.src, s.file).not.toMatch(/event_type = 'snippet_issue' AND ts </);
  });

  it("the purge module is gone", () => {
    expect(sources.some((s) => s.file.endsWith("cron/marker-purge.ts"))).toBe(false);
  });
});
